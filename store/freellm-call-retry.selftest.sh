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

count = {'n': 0}

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        self.rfile.read(length)
        idx = count['n']
        count['n'] += 1
        with open(f"{LOGDIR}/req-{idx}.json", 'w') as f:
            f.write(str(idx))
        if idx == 0:
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

echo "freellm-call-retry.selftest: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
