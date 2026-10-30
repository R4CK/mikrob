#!/usr/bin/env bash
# freellm-call.selftest.sh -- unit tests for freellm-call.sh
#
# A local mock HTTP server (127.0.0.1, random free port) stands in for freellmapi so these
# tests never touch the real service or a real key (card ad6b183f constraint). The mock
# records each request's Authorization header and body, so tests can assert on what was
# actually sent, not just on the script's exit code.
#
# TESTS:
# 1.  --dry-run works without config
# 2.  missing switch file = exit 2
# 3.  disabled switch = exit 2
# 4.  switch type confusion (F4): {"enabled":"True"} (string) keeps it OFF, no network call
# 5.  content gate: mopsion prompt = exit 4, zero requests
# 6.  content gate (real checker, F2): Hungarian "jelszo" = exit 4, zero requests
# 7.  content gate (real checker, F2): CleanCore (mopsion's old name) = exit 4, zero requests
# 8.  content gate (real checker, F2): zero-width-split mopsion = exit 4, zero requests
# 9.  content gate (redactor, F2): secret-shaped GitHub token = exit 4, zero requests
# 9b. content gate (redactor, F2, CYBERED NO-GO 25494): a secret-shaped string with one
#     Greek-omicron homoglyph substituted for the ASCII "o" (outside the 12-entry map) fails
#     closed = exit 4, zero requests -- the fold table is a convenience, not the guarantee.
# 10. content gate: benign prompt is NOT refused (passes both gates)
# 11. validate-key with enabled switch = exit 0
# 12. validate-key with disabled switch = exit 2
# 13. happy path: valid switch + safe prompt reaches the mock, exit 0, Authorization present
# 14. F1 regression: a prompt that closes a Python triple-quote and calls os.system() does
#     NOT execute -- no marker file appears, and the mock receives the payload as the exact,
#     unexecuted string (round-trip proof), not as evaluated code.
# 15. F1 regression: ordinary prompts with triple-quotes/backslashes round-trip byte-for-byte
#     instead of producing a SyntaxError-truncated empty body.
# 16. Kesz-ha 4: the auth token value never appears in `ps` output sampled DURING the call,
#     and never appears in the script's own stdout/stderr -- while the mock confirms the
#     header WAS sent (so the absence is concealment, not a forgotten header).
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/freellm-call.sh"
CATEGORY_CHECK="$HERE/gemini-agy-category-check.py"
TMPDIR_TEST="$(mktemp -d)"
MOCK_LOGDIR="$TMPDIR_TEST/mock-reqs"
mkdir -p "$MOCK_LOGDIR"
MOCK_PID=""
cleanup() {
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null
  rm -rf "$TMPDIR_TEST"
}
trap cleanup EXIT

PASS=0 FAIL=0

test_case() {
  local name="$1"
  local expected_exit="$2"
  shift 2
  local actual_exit=0
  "$@" >/dev/null 2>&1 || actual_exit=$?
  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "[PASS] $name (exit $actual_exit)"
    ((PASS++))
  else
    echo "[FAIL] $name (expected $expected_exit, got $actual_exit)"
    ((FAIL++))
  fi
}

assert_true() {
  local name="$1" cond="$2"
  if [[ "$cond" == "1" ]]; then
    echo "[PASS] $name"
    ((PASS++))
  else
    echo "[FAIL] $name"
    ((FAIL++))
  fi
}

mock_request_count() {
  ls "$MOCK_LOGDIR"/req-*.json 2>/dev/null | wc -l | tr -d ' '
}

clear_mock_requests() {
  rm -f "$MOCK_LOGDIR"/req-*.json
}

# ---- start the mock server on a free loopback port -----------------------------------
cat > "$TMPDIR_TEST/mock_server.py" << 'PYEOF'
import http.server, json, sys, os, time

LOGDIR = sys.argv[1]
PORT = int(sys.argv[2])
DELAY = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        auth = self.headers.get('Authorization', '')
        if DELAY > 0:
            time.sleep(DELAY)
        existing = [f for f in os.listdir(LOGDIR) if f.startswith('req-')]
        n = len(existing)
        with open(os.path.join(LOGDIR, f'req-{n}.json'), 'w') as f:
            json.dump({'path': self.path, 'auth': auth, 'body': body.decode('utf-8', 'replace')}, f)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({"choices": [{"message": {"content": "mock response"}}]}).encode())

    def log_message(self, *a):
        pass

httpd = http.server.HTTPServer(('127.0.0.1', PORT), Handler)
httpd.serve_forever()
PYEOF

# Port 0 trick to find a free port, then start the real server on it.
MOCK_PORT="$(python3 -c '
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
')"
python3 -I "$TMPDIR_TEST/mock_server.py" "$MOCK_LOGDIR" "$MOCK_PORT" 0 &
MOCK_PID=$!
# Poll until the mock accepts connections (no fixed sleep -- startup time varies).
for _ in $(seq 1 50); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$MOCK_PORT") 2>/dev/null; then
    exec 3>&- 3<&-
    break
  fi
  sleep 0.05
done

export FREELLM_API_BASE="http://127.0.0.1:$MOCK_PORT/v1"
export FREELLM_CATEGORY_CHECK_OVERRIDE="$CATEGORY_CHECK"

AUTH_TOKEN_FIXTURE="$TMPDIR_TEST/auth-token"
printf '%s' "FAKE-SELFTEST-TOKEN-9f2b7c1e" > "$AUTH_TOKEN_FIXTURE"
export FREELLM_AUTH_TOKEN_FILE="$AUTH_TOKEN_FIXTURE"

ENABLED_SWITCH="$TMPDIR_TEST/freellm-enabled.json"
cat > "$ENABLED_SWITCH" << 'EOF'
{"enabled": true, "setBy": "test", "reason": "testing", "since": 1234567890}
EOF
DISABLED_SWITCH="$TMPDIR_TEST/freellm-disabled.json"
cat > "$DISABLED_SWITCH" << 'EOF'
{"enabled": false, "setBy": "test", "reason": "testing", "since": 1234567890}
EOF
STRING_TRUE_SWITCH="$TMPDIR_TEST/freellm-string-true.json"
cat > "$STRING_TRUE_SWITCH" << 'EOF'
{"enabled": "True", "setBy": "test", "reason": "type confusion probe", "since": 1234567890}
EOF

# ---- Test 1: --dry-run works without config -------------------------------------------
test_case "dry-run without config" 0 \
  bash "$SCRIPT" --dry-run "test prompt"

# ---- Test 2: missing switch file = exit 2 ----------------------------------------------
export FREELLM_SWITCH="$TMPDIR_TEST/nonexistent.json"
test_case "missing switch file" 2 \
  bash "$SCRIPT" "test prompt"

# ---- Test 3: disabled switch = exit 2 --------------------------------------------------
export FREELLM_SWITCH="$DISABLED_SWITCH"
test_case "disabled switch" 2 \
  bash "$SCRIPT" "test prompt"

# ---- Test 4 (F4): switch type confusion -- {"enabled":"True"} (string) stays OFF -------
clear_mock_requests
export FREELLM_SWITCH="$STRING_TRUE_SWITCH"
test_case "F4: string \"True\" enabled value does not turn the client on" 2 \
  bash "$SCRIPT" "benign prompt"
assert_true "F4: no network call with the string-typed switch" "$([[ "$(mock_request_count)" -eq 0 ]] && echo 1 || echo 0)"

# ---- Test 5: content gate - mopsion prompt = exit 4, zero requests --------------------
clear_mock_requests
export FREELLM_SWITCH="$ENABLED_SWITCH"
test_case "content gate: mopsion in prompt" 4 \
  bash "$SCRIPT" "test mopsion feature"
assert_true "content gate (mopsion): zero network requests" "$([[ "$(mock_request_count)" -eq 0 ]] && echo 1 || echo 0)"

# ---- Test 6 (F2): real category check catches a Hungarian sensitive word --------------
clear_mock_requests
test_case "F2: real category check catches Hungarian 'jelszo'" 4 \
  bash "$SCRIPT" "A jelszo: hunter2"
assert_true "F2 jelszo: zero network requests" "$([[ "$(mock_request_count)" -eq 0 ]] && echo 1 || echo 0)"

# ---- Test 7 (F2): real category check catches CleanCore (mopsion's old internal name) --
clear_mock_requests
test_case "F2: real category check catches CleanCore" 4 \
  bash "$SCRIPT" "CleanCore layout redesign"
assert_true "F2 CleanCore: zero network requests" "$([[ "$(mock_request_count)" -eq 0 ]] && echo 1 || echo 0)"

# ---- Test 8 (F2): real category check catches a zero-width-split mopsion --------------
clear_mock_requests
test_case "F2: real category check catches zero-width-split mopsion" 4 \
  bash "$SCRIPT" "$(printf 'mop\xe2\x80\x8bsion kod')"
assert_true "F2 zero-width mopsion: zero network requests" "$([[ "$(mock_request_count)" -eq 0 ]] && echo 1 || echo 0)"

# ---- Test 9 (F2): secret-shaped GitHub token is caught by the reused redactor ----------
clear_mock_requests
test_case "F2: secret-shaped GitHub token" 4 \
  bash "$SCRIPT" "ghp_$(printf 'a%.0s' $(seq 1 36))"
assert_true "F2 github token: zero network requests" "$([[ "$(mock_request_count)" -eq 0 ]] && echo 1 || echo 0)"

# ---- Test 9b (F2): unmapped homoglyph (Greek omicron) fails closed --------------------
# CYBERED NO-GO 25494 repro: "t" + U+03BF (GREEK SMALL LETTER OMICRON) + "ken: <secret>" is
# visually "token: <secret>" but survives the 12-entry Cyrillic-only _HOMOGLYPH_MAP untouched,
# so the SECRET_PATTERNS keyword alternation never matches it. On the pre-fix script (39284c8a)
# this reaches the mock verbatim (exit 0); the fail-closed backstop must refuse it (exit 4).
clear_mock_requests
OMICRON_SECRET="$(printf 't\xce\xbfken: hunter2verylongsecretvalue1234567890')"
test_case "F2: unmapped homoglyph (Greek omicron) in secret-shaped text fails closed" 4 \
  bash "$SCRIPT" "$OMICRON_SECRET"
assert_true "F2 omicron: zero network requests" "$([[ "$(mock_request_count)" -eq 0 ]] && echo 1 || echo 0)"

# ---- Test 10: a benign prompt is NOT refused by the content gates ---------------------
clear_mock_requests
test_case "content gate: benign prompt passes both gates" 0 \
  bash "$SCRIPT" "please summarize this short changelog entry"
assert_true "benign prompt: exactly one network request" "$([[ "$(mock_request_count)" -eq 1 ]] && echo 1 || echo 0)"

# ---- Test 11: --validate-key with enabled switch = exit 0 ------------------------------
clear_mock_requests
test_case "validate-key with enabled switch" 0 \
  bash "$SCRIPT" --validate-key
assert_true "validate-key (enabled): zero network requests" "$([[ "$(mock_request_count)" -eq 0 ]] && echo 1 || echo 0)"

# ---- Test 12: --validate-key with disabled switch = exit 2 -----------------------------
export FREELLM_SWITCH="$DISABLED_SWITCH"
test_case "validate-key with disabled switch" 2 \
  bash "$SCRIPT" --validate-key
export FREELLM_SWITCH="$ENABLED_SWITCH"

# ---- Test 13: happy path -- mock receives the request, Authorization header present ----
clear_mock_requests
OUT="$(bash "$SCRIPT" "benign happy-path prompt" 2>/dev/null)"
RC=$?
if [[ "$RC" -eq 0 ]] && [[ "$OUT" == "mock response" ]]; then
  echo "[PASS] happy path: exit 0, mock's canned response printed"
  ((PASS++))
else
  echo "[FAIL] happy path: expected exit 0 / 'mock response', got exit $RC / '$OUT'"
  ((FAIL++))
fi
REQ_AUTH="$(python3 -c "import json; print(json.load(open('$MOCK_LOGDIR/req-0.json'))['auth'])" 2>/dev/null || echo "")"
assert_true "happy path: Authorization header was sent to the mock" "$([[ "$REQ_AUTH" == Bearer* ]] && echo 1 || echo 0)"

# ---- Test 14 (F1 CRITICAL regression): heredoc-injection RCE payload does not execute --
clear_mock_requests
MARKER_FILE="$TMPDIR_TEST/PWNED-marker"
rm -f "$MARKER_FILE"
RCE_PAYLOAD="x\"\"\" + str(open(\"$MARKER_FILE\",\"w\").write(\"EXECUTED\")) + \"\"\""
OUT="$(bash "$SCRIPT" "$RCE_PAYLOAD" 2>/dev/null)"
RC=$?
assert_true "F1: heredoc-injection RCE payload creates NO marker file" "$([[ ! -e "$MARKER_FILE" ]] && echo 1 || echo 0)"
if [[ "$RC" -eq 0 ]] && [[ -f "$MOCK_LOGDIR/req-0.json" ]]; then
  SENT_CONTENT="$(python3 -c "
import json
body = json.loads(json.load(open('$MOCK_LOGDIR/req-0.json'))['body'])
print(body['messages'][0]['content'], end='')
" 2>/dev/null)"
  # The herestring in freellm-call.sh appends exactly one trailing newline to the prompt;
  # strip exactly one to compare against the original payload byte-for-byte.
  SENT_CONTENT="${SENT_CONTENT%$'\n'}"
  assert_true "F1: payload reached the mock as an exact, unexecuted string" \
    "$([[ "$SENT_CONTENT" == "$RCE_PAYLOAD" ]] && echo 1 || echo 0)"
else
  echo "[FAIL] F1: expected exit 0 and a captured mock request, got exit $RC"
  ((FAIL++))
fi

# ---- Test 15 (F1 regression): ordinary prompts with triple-quotes/backslashes ----------
clear_mock_requests
ORDINARY_PROMPTS=(
  'say """hello""" please'
  'C:\users\x\new'
  'tab\there and \x zz'
  'trailing backslash \'
)
ORD_OK=1
for i in "${!ORDINARY_PROMPTS[@]}"; do
  p="${ORDINARY_PROMPTS[$i]}"
  clear_mock_requests
  OUT="$(bash "$SCRIPT" "$p" 2>/dev/null)"
  RC=$?
  if [[ "$RC" -ne 0 ]] || [[ ! -f "$MOCK_LOGDIR/req-0.json" ]]; then
    ORD_OK=0
    echo "  (ordinary prompt #$i: exit $RC, no request captured)"
    continue
  fi
  GOT="$(python3 -c "
import json
body = json.loads(json.load(open('$MOCK_LOGDIR/req-0.json'))['body'])
print(body['messages'][0]['content'], end='')
" 2>/dev/null)"
  GOT="${GOT%$'\n'}"
  if [[ "$GOT" != "$p" ]]; then
    ORD_OK=0
    echo "  (ordinary prompt #$i: round-trip mismatch)"
  fi
done
assert_true "F1: ordinary triple-quote/backslash prompts round-trip byte-for-byte" "$ORD_OK"

# ---- Test 16 (Kesz-ha 4): auth token never visible in ps or in the script's own output -
clear_mock_requests
SECRET_TOKEN_VALUE="ZZZ-DO-NOT-LEAK-ME-$$-UNIQUE"
printf '%s' "$SECRET_TOKEN_VALUE" > "$AUTH_TOKEN_FIXTURE"
# Give the mock an artificial delay so there is a window to sample `ps` mid-call.
rm -f "$MOCK_LOGDIR"/req-*.json
python3 -I "$TMPDIR_TEST/mock_server.py" "$MOCK_LOGDIR" "$MOCK_PORT" 0.6 &
kill "$MOCK_PID" 2>/dev/null
MOCK_PID=$!
for _ in $(seq 1 50); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$MOCK_PORT") 2>/dev/null; then
    exec 3>&- 3<&-
    break
  fi
  sleep 0.05
done

STDOUT_FILE="$TMPDIR_TEST/t16.out"
STDERR_FILE="$TMPDIR_TEST/t16.err"
bash "$SCRIPT" "benign ps-probe prompt" > "$STDOUT_FILE" 2> "$STDERR_FILE" &
CALL_PID=$!
PS_LEAK=0
PS_SNAPSHOT="$TMPDIR_TEST/ps-snapshot.txt"
for _ in $(seq 1 40); do
  if ! kill -0 "$CALL_PID" 2>/dev/null; then
    break
  fi
  # The token value must never appear in any of THESE commands' own argv, or they would
  # catch their own command line (a self-referential false positive, not a real leak from
  # freellm-call.sh) -- ps writes to a file, and grep's pattern comes from the token FILE
  # (-f), never from an argv value.
  ps -eo args --no-headers > "$PS_SNAPSHOT" 2>/dev/null
  if grep -qFf "$AUTH_TOKEN_FIXTURE" "$PS_SNAPSHOT"; then
    PS_LEAK=1
  fi
  sleep 0.02
done
wait "$CALL_PID" 2>/dev/null
CALL_RC=$?

assert_true "Kesz-ha 4: auth token never appears in ps output during the call" "$([[ "$PS_LEAK" -eq 0 ]] && echo 1 || echo 0)"
assert_true "Kesz-ha 4: auth token never appears in the script's own stdout" \
  "$(grep -qF "$SECRET_TOKEN_VALUE" "$STDOUT_FILE" && echo 0 || echo 1)"
assert_true "Kesz-ha 4: auth token never appears in the script's own stderr" \
  "$(grep -qF "$SECRET_TOKEN_VALUE" "$STDERR_FILE" && echo 0 || echo 1)"
MOCK_AUTH="$(python3 -c "import json; print(json.load(open('$MOCK_LOGDIR/req-0.json'))['auth'])" 2>/dev/null || echo "")"
assert_true "Kesz-ha 4: the token WAS actually sent to the mock (hiding, not forgetting)" \
  "$([[ "$MOCK_AUTH" == "Bearer $SECRET_TOKEN_VALUE" ]] && echo 1 || echo 0)"
assert_true "Kesz-ha 4: the call itself still succeeded (exit 0)" "$([[ "$CALL_RC" -eq 0 ]] && echo 1 || echo 0)"

# Summary
echo ""
echo "PASSED: $PASS"
echo "FAILED: $FAIL"
if [[ "$FAIL" -eq 0 ]]; then
  exit 0
else
  exit 1
fi
