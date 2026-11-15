#!/usr/bin/env bash
# freellm-call-retry.selftest.sh -- card 4cd2a0fc: a single slow/stalled
# upstream must not eat the whole FREELLM_TIMEOUT client budget.
#
# A local mock HTTP server (127.0.0.1, random free port) stands in for
# freellmapi, same isolation convention as freellm-call.selftest.sh. Its FIRST
# request hangs for 90s (the Kesz-ha's literal "stub upstream that hangs
# 90s"); every request after that answers instantly -- simulating
# freellmapi re-routing to a different, responsive provider on the client's
# next attempt (FREELLM_MODEL=auto re-resolves fresh on every call).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/freellm-call.sh"
PASS=0
FAIL=0
check() {
  local desc="$1" ok="$2"
  if [[ "$ok" == "1" ]]; then PASS=$((PASS + 1));
  else FAIL=$((FAIL + 1)); echo "FAIL - $desc"; fi
}

TMPDIR_TEST="$(mktemp -d)"
MOCK_PID=""
cleanup() {
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null
  rm -rf "$TMPDIR_TEST"
}
trap cleanup EXIT

cat > "$TMPDIR_TEST/mock_server.py" << 'PYEOF'
import http.server, json, sys, time

LOGDIR = sys.argv[1]
PORT = int(sys.argv[2])
STALL_SECONDS = float(sys.argv[3])
# P1 (card 6f9426d6): "first" (default) stalls only request 0, letting any later
# attempt succeed immediately -- this is what made the original clamp pin vacuous
# (a lucky early success hides a broken clamp). "always" stalls every request, so
# the total elapsed time is driven ENTIRELY by how many attempts the client makes
# and how long each is allowed to run -- the only way to actually exercise the
# overall-budget clamp instead of getting bailed out by chance.
STALL_MODE = sys.argv[4] if len(sys.argv) > 4 else "first"

count = {'n': 0}

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        self.rfile.read(length)
        idx = count['n']
        count['n'] += 1
        with open(f"{LOGDIR}/req-{idx}.json", 'w') as f:
            f.write(str(idx))
        if STALL_MODE == "always" or idx == 0:
            time.sleep(STALL_SECONDS)
        body = json.dumps({"choices": [{"message": {"content": "fallback-after-stall"}}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass

class ThreadingHTTPServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
PYEOF

MOCK_LOGDIR="$TMPDIR_TEST/reqs"
mkdir -p "$MOCK_LOGDIR"
request_count() { ls "$MOCK_LOGDIR"/req-*.json 2>/dev/null | wc -l | tr -d ' '; }

MOCK_PORT="$(python3 -c '
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
')"

python3 -I "$TMPDIR_TEST/mock_server.py" "$MOCK_LOGDIR" "$MOCK_PORT" 90 &
MOCK_PID=$!
for _ in $(seq 1 50); do
  (exec 3<>"/dev/tcp/127.0.0.1/$MOCK_PORT") 2>/dev/null && break
  sleep 0.1
done

SWITCH_FILE="$TMPDIR_TEST/switch.json"
printf '{"enabled": true}\n' > "$SWITCH_FILE"
TOKEN_FILE="$TMPDIR_TEST/token"
printf 'test-token\n' > "$TOKEN_FILE"
chmod 0600 "$TOKEN_FILE"

run_call() {
  env FREELLM_SWITCH="$SWITCH_FILE" FREELLM_AUTH_TOKEN_FILE="$TOKEN_FILE" \
      FREELLM_API_BASE="http://127.0.0.1:$MOCK_PORT/v1" \
      FREELLM_MODEL="auto" FREELLM_TIMEOUT="${1}" FREELLM_MAX_ATTEMPTS="${2}" \
      ${3:+FREELLM_ATTEMPT_TIMEOUT="${3}"} \
      bash "$SCRIPT" "hi"
}

# ---- 1: default retry behaviour (FREELLM_TIMEOUT=60, 2 attempts of 20s) ----
# recovers from a 90s-stalled first attempt and returns the fallback answer.
start_ns="$(date +%s%N)"
out="$(run_call 60 2 2>"$TMPDIR_TEST/stderr1.log")"
rc=$?
end_ns="$(date +%s%N)"
elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))

check "default retry: exit 0" "$([[ "$rc" -eq 0 ]] && echo 1 || echo 0)"
check "default retry: got the fallback answer, not the stalled one" "$([[ "$out" == "fallback-after-stall" ]] && echo 1 || echo 0)"
check "default retry: finished well within FREELLM_TIMEOUT (${elapsed_ms}ms < 60000ms)" "$([[ "$elapsed_ms" -lt 60000 ]] && echo 1 || echo 0)"
check "default retry: a second attempt was actually made (benched, not silently dropped)" "$([[ "$(request_count)" -ge 2 ]] && echo 1 || echo 0)"
check "default retry: the stall/retry was reported on stderr, not silent" "$(grep -q "stalled" "$TMPDIR_TEST/stderr1.log" && echo 1 || echo 0)"

# ---- 2: with retries disabled (FREELLM_MAX_ATTEMPTS=1), the same stalled
# first attempt has no second chance and the call fails -- this is what the
# pre-fix single-attempt behaviour looked like, confirming the retry (not
# something else) is what makes test 1 pass. Fresh mock process so its
# request counter (and therefore the stall-on-first-request behaviour)
# restarts at 0.
kill "$MOCK_PID" 2>/dev/null
wait "$MOCK_PID" 2>/dev/null
MOCK_LOGDIR2="$TMPDIR_TEST/reqs2"
mkdir -p "$MOCK_LOGDIR2"
MOCK_PORT2="$(python3 -c '
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
')"
python3 -I "$TMPDIR_TEST/mock_server.py" "$MOCK_LOGDIR2" "$MOCK_PORT2" 90 &
MOCK_PID=$!
for _ in $(seq 1 50); do
  (exec 3<>"/dev/tcp/127.0.0.1/$MOCK_PORT2") 2>/dev/null && break
  sleep 0.1
done
out2="$(env FREELLM_SWITCH="$SWITCH_FILE" FREELLM_AUTH_TOKEN_FILE="$TOKEN_FILE" \
    FREELLM_API_BASE="http://127.0.0.1:$MOCK_PORT2/v1" \
    FREELLM_MODEL="auto" FREELLM_TIMEOUT=60 FREELLM_MAX_ATTEMPTS=1 FREELLM_ATTEMPT_TIMEOUT=20 \
    bash "$SCRIPT" "hi" 2>/dev/null)"
rc2=$?
check "no-retry baseline: fails without a second attempt (exit != 0)" "$([[ "$rc2" -ne 0 ]] && echo 1 || echo 0)"
check "no-retry baseline: exactly one attempt was made" "$([[ "$(ls "$MOCK_LOGDIR2"/req-*.json 2>/dev/null | wc -l | tr -d ' ')" -eq 1 ]] && echo 1 || echo 0)"

# ---- 3: the SCRIPT'S OWN DEFAULT (FREELLM_MAX_ATTEMPTS left unset, not passed
# by the caller) must still retry. Test 1 always passes FREELLM_MAX_ATTEMPTS=2
# explicitly, so it would stay green even if the script's shipped default
# regressed to 1 (cybersec2, comment 31204, PINS) -- this test exercises the
# default path on its own, fresh mock so the stall is on request 0 again.
kill "$MOCK_PID" 2>/dev/null
wait "$MOCK_PID" 2>/dev/null
MOCK_LOGDIR3="$TMPDIR_TEST/reqs3"
mkdir -p "$MOCK_LOGDIR3"
MOCK_PORT3="$(python3 -c '
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
')"
python3 -I "$TMPDIR_TEST/mock_server.py" "$MOCK_LOGDIR3" "$MOCK_PORT3" 90 &
MOCK_PID=$!
for _ in $(seq 1 50); do
  (exec 3<>"/dev/tcp/127.0.0.1/$MOCK_PORT3") 2>/dev/null && break
  sleep 0.1
done
out3="$(env FREELLM_SWITCH="$SWITCH_FILE" FREELLM_AUTH_TOKEN_FILE="$TOKEN_FILE" \
    FREELLM_API_BASE="http://127.0.0.1:$MOCK_PORT3/v1" \
    FREELLM_MODEL="auto" FREELLM_TIMEOUT=60 \
    bash "$SCRIPT" "hi" 2>/dev/null)"
rc3=$?
check "default FREELLM_MAX_ATTEMPTS (unset by caller): exit 0" "$([[ "$rc3" -eq 0 ]] && echo 1 || echo 0)"
check "default FREELLM_MAX_ATTEMPTS (unset by caller): got the fallback answer" "$([[ "$out3" == "fallback-after-stall" ]] && echo 1 || echo 0)"
check "default FREELLM_MAX_ATTEMPTS (unset by caller): a second attempt was actually made" "$([[ "$(ls "$MOCK_LOGDIR3"/req-*.json 2>/dev/null | wc -l | tr -d ' ')" -ge 2 ]] && echo 1 || echo 0)"

# ---- 4: F1 (WhiteHat2 MEDIUM-LOW, comment 31204) -- an arithmetic-injection
# payload in FREELLM_TIMEOUT or FREELLM_MAX_ATTEMPTS must be refused (exit 2,
# fail-closed, no file created) rather than reaching bash's `$(( ))`/`-le`
# arithmetic evaluation. No network needed: the check happens before any API
# call, so no mock server/switch/token setup is required either.
INJECT_MARKER="$TMPDIR_TEST/inject-marker"
rm -f "$INJECT_MARKER"
FREELLM_TIMEOUT="x[\$(touch $INJECT_MARKER)]" bash "$SCRIPT" --dry-run hi >/dev/null 2>&1
rc_inj1=$?
check "F1: FREELLM_TIMEOUT injection payload refused (exit 2)" "$([[ "$rc_inj1" -eq 2 ]] && echo 1 || echo 0)"
check "F1: FREELLM_TIMEOUT injection payload never reached arithmetic (no marker file)" "$([[ ! -e "$INJECT_MARKER" ]] && echo 1 || echo 0)"

rm -f "$INJECT_MARKER"
FREELLM_TIMEOUT=60 FREELLM_MAX_ATTEMPTS="x[\$(touch $INJECT_MARKER)]" bash "$SCRIPT" --dry-run hi >/dev/null 2>&1
rc_inj2=$?
check "F1: FREELLM_MAX_ATTEMPTS injection payload refused (exit 2)" "$([[ "$rc_inj2" -eq 2 ]] && echo 1 || echo 0)"
check "F1: FREELLM_MAX_ATTEMPTS injection payload never reached arithmetic (no marker file)" "$([[ ! -e "$INJECT_MARKER" ]] && echo 1 || echo 0)"

# ---- 5: F2 (WhiteHat2 LOW, same comment) -- FREELLM_ATTEMPT_TIMEOUT=0 (which
# curl would treat as "no limit") is rejected the same way, and a high
# FREELLM_MAX_ATTEMPTS x an explicit FREELLM_ATTEMPT_TIMEOUT that would sum
# past FREELLM_TIMEOUT gets clamped instead of silently exceeding the budget.
FREELLM_TIMEOUT=60 FREELLM_ATTEMPT_TIMEOUT=0 bash "$SCRIPT" --dry-run hi >/dev/null 2>&1
rc_zero=$?
check "F2: FREELLM_ATTEMPT_TIMEOUT=0 refused (exit 2, not unlimited curl)" "$([[ "$rc_zero" -eq 2 ]] && echo 1 || echo 0)"

kill "$MOCK_PID" 2>/dev/null
wait "$MOCK_PID" 2>/dev/null
MOCK_LOGDIR4="$TMPDIR_TEST/reqs4"
mkdir -p "$MOCK_LOGDIR4"
MOCK_PORT4="$(python3 -c '
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
')"
python3 -I "$TMPDIR_TEST/mock_server.py" "$MOCK_LOGDIR4" "$MOCK_PORT4" 90 &
MOCK_PID=$!
for _ in $(seq 1 50); do
  (exec 3<>"/dev/tcp/127.0.0.1/$MOCK_PORT4") 2>/dev/null && break
  sleep 0.1
done
start_ns5="$(date +%s%N)"
env FREELLM_SWITCH="$SWITCH_FILE" FREELLM_AUTH_TOKEN_FILE="$TOKEN_FILE" \
    FREELLM_API_BASE="http://127.0.0.1:$MOCK_PORT4/v1" \
    FREELLM_MODEL="auto" FREELLM_TIMEOUT=6 FREELLM_MAX_ATTEMPTS=5 FREELLM_ATTEMPT_TIMEOUT=2 \
    bash "$SCRIPT" "hi" >/dev/null 2>"$TMPDIR_TEST/stderr5.log"
rc5=$?
end_ns5="$(date +%s%N)"
elapsed_ms5=$(( (end_ns5 - start_ns5) / 1000000 ))
# unclamped this would be up to 5 x 2s = 10000ms against a 6000ms budget;
# clamped (TIMEOUT/MAX_ATTEMPTS = 6/5 = 1s/attempt) it must stay well under 10s.
check "F2: FREELLM_MAX_ATTEMPTS=5 x FREELLM_ATTEMPT_TIMEOUT=2 clamped under the 6s budget (${elapsed_ms5}ms)" "$([[ "$elapsed_ms5" -lt 9000 ]] && echo 1 || echo 0)"

# ---- 6: L1 (card 6f9426d6) -- a rejected value must NAME the variable on stderr, not
# just exit 2 silently. No network needed, same as test 4.
FREELLM_TIMEOUT="not-a-number" bash "$SCRIPT" --dry-run hi >/dev/null 2>"$TMPDIR_TEST/stderr_l1a.log"
check "L1: FREELLM_TIMEOUT rejection names the variable on stderr" "$(grep -q "FREELLM_TIMEOUT" "$TMPDIR_TEST/stderr_l1a.log" && echo 1 || echo 0)"

FREELLM_TIMEOUT=60 FREELLM_MAX_ATTEMPTS="not-a-number" bash "$SCRIPT" --dry-run hi >/dev/null 2>"$TMPDIR_TEST/stderr_l1b.log"
check "L1: FREELLM_MAX_ATTEMPTS rejection names the variable on stderr" "$(grep -q "FREELLM_MAX_ATTEMPTS" "$TMPDIR_TEST/stderr_l1b.log" && echo 1 || echo 0)"

FREELLM_TIMEOUT=60 FREELLM_ATTEMPT_TIMEOUT="not-a-number" bash "$SCRIPT" --dry-run hi >/dev/null 2>"$TMPDIR_TEST/stderr_l1c.log"
check "L1: FREELLM_ATTEMPT_TIMEOUT rejection names the variable on stderr" "$(grep -q "FREELLM_ATTEMPT_TIMEOUT" "$TMPDIR_TEST/stderr_l1c.log" && echo 1 || echo 0)"

# ---- 7: P1 length-cap layer (card 6f9426d6) -- the regex (`^[1-9][0-9]*$`) and the
# length cap (`${#value} <= maxlen`) are two SEPARATE checks; every prior injection test
# used a non-digit payload, which only ever exercises the regex. A well-formed but
# too-long digit string exercises the length cap on its own -- a mutant that dropped
# the cap entirely (kept only the regex) would pass every existing test but must fail
# this one.
FREELLM_TIMEOUT="99999" bash "$SCRIPT" --dry-run hi >/dev/null 2>"$TMPDIR_TEST/stderr_p1a.log"
rc_p1a=$?
check "P1: FREELLM_TIMEOUT=99999 (5 digits, cap is 4) refused (exit 2)" "$([[ "$rc_p1a" -eq 2 ]] && echo 1 || echo 0)"
check "P1: FREELLM_TIMEOUT=99999 rejection names the variable on stderr" "$(grep -q "FREELLM_TIMEOUT" "$TMPDIR_TEST/stderr_p1a.log" && echo 1 || echo 0)"

FREELLM_TIMEOUT=60 FREELLM_MAX_ATTEMPTS="999" bash "$SCRIPT" --dry-run hi >/dev/null 2>"$TMPDIR_TEST/stderr_p1b.log"
rc_p1b=$?
check "P1: FREELLM_MAX_ATTEMPTS=999 (3 digits, cap is 2) refused (exit 2)" "$([[ "$rc_p1b" -eq 2 ]] && echo 1 || echo 0)"
check "P1: FREELLM_MAX_ATTEMPTS=999 rejection names the variable on stderr" "$(grep -q "FREELLM_MAX_ATTEMPTS" "$TMPDIR_TEST/stderr_p1b.log" && echo 1 || echo 0)"

# ---- 8: P1/L2, non-vacuous clamp pin (card 6f9426d6) -- the retry-selftest's own test 5
# above stalls only request 0 (STALL_MODE=first), so a LATER attempt always succeeds fast
# and the elapsed-time check passes whether or not the clamp logic does anything at all
# (confirmed: removing the clamp, flipping its comparison, or forcing its floor to 0 all
# still pass test 5 unchanged). STALL_MODE=always removes that escape: every attempt
# stalls, so the client NEVER succeeds and the elapsed time is driven purely by how many
# attempts x how long each is allowed to run -- exactly the card's own repro
# (TIMEOUT=3, MAX_ATTEMPTS=9 measured 9348ms before this fix). This pin requires the
# wall-clock DEADLINE fix (not just a per-attempt clamp): even a "correct" per-attempt
# clamp of TIMEOUT/MAX_ATTEMPTS=0->1 still sums to MAX_ATTEMPTS seconds here.
kill "$MOCK_PID" 2>/dev/null
wait "$MOCK_PID" 2>/dev/null
MOCK_LOGDIR6="$TMPDIR_TEST/reqs6"
mkdir -p "$MOCK_LOGDIR6"
MOCK_PORT6="$(python3 -c '
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
')"
python3 -I "$TMPDIR_TEST/mock_server.py" "$MOCK_LOGDIR6" "$MOCK_PORT6" 90 always &
MOCK_PID=$!
for _ in $(seq 1 50); do
  (exec 3<>"/dev/tcp/127.0.0.1/$MOCK_PORT6") 2>/dev/null && break
  sleep 0.1
done
start_ns6="$(date +%s%N)"
env FREELLM_SWITCH="$SWITCH_FILE" FREELLM_AUTH_TOKEN_FILE="$TOKEN_FILE" \
    FREELLM_API_BASE="http://127.0.0.1:$MOCK_PORT6/v1" \
    FREELLM_MODEL="auto" FREELLM_TIMEOUT=3 FREELLM_MAX_ATTEMPTS=9 \
    bash "$SCRIPT" "hi" >/dev/null 2>/dev/null
rc6=$?
end_ns6="$(date +%s%N)"
elapsed_ms6=$(( (end_ns6 - start_ns6) / 1000000 ))
check "L2/P1: every attempt stalls -> never succeeds (exit != 0)" "$([[ "$rc6" -ne 0 ]] && echo 1 || echo 0)"
# Old (buggy) behaviour: ~9 attempts x 1s floor = ~9348ms measured. Fixed behaviour must
# stay close to the advertised TIMEOUT=3s budget, not the attempt-count x floor product.
check "L2/P1: TIMEOUT=3 MAX_ATTEMPTS=9 (always-stalling upstream) honours the 3s budget, not ~9s (${elapsed_ms6}ms)" "$([[ "$elapsed_ms6" -lt 5000 ]] && echo 1 || echo 0)"

echo "freellm-call-retry.selftest: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
