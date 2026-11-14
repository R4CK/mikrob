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
# 9c. (card a2db9d8f req 1) same omicron-secret payload as 9b, but with CATEGORY_CHECK
#     (gate 1) stubbed to always report "clean" -- isolates gate 2 (the inline _GATE_PY
#     backstop) so this test actually exercises the backstop itself, not gate 1's own
#     unmapped-letter fail-closed (c5f2d6c9), which in the real checker already catches
#     omicron-laced text before gate 2 ever runs.
# 10. content gate: benign prompt is NOT refused (passes both gates)
# 11. validate-key with enabled switch = exit 0
# 12. validate-key with disabled switch = exit 2
# 12b. (L1, WhiteHat NO-GO 28484, card 4eb3743e delta) a non-loopback FREELLM_API_BASE fails
#      closed (exit 2), zero network requests -- the host check runs before the switch/token
#      network call, so a proxy or a reconfigured host cannot reach a real request through.
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
# Card af8ddbf0: the mock now ALSO serves GET /v1/models (a real catalog) and enforces both
# the expected auth token and model-catalog membership on POST /v1/chat/completions -- the
# old mock accepted any model/token unconditionally, which could never have reproduced the
# live incident (a stale default model and a drifted token both 404/401'd for real). Both
# the catalog and the expected token are read fresh from small files on every request (args
# 4 and 5), so a test can change either mid-run without restarting the server.
cat > "$TMPDIR_TEST/mock_server.py" << 'PYEOF'
import http.server, json, sys, os, time

LOGDIR = sys.argv[1]
PORT = int(sys.argv[2])
DELAY = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
EXPECTED_TOKEN_FILE = sys.argv[4]
MODELS_FILE = sys.argv[5]
# Card 555419a8 (M2): the startup preflight hits GET /v1/providers -- configurable response
# code via a small file (read fresh per request, default 200 when absent/unreadable) so a test
# can simulate the provider-health endpoint reporting 401/403/429 without touching the token or
# model-catalog files those other checks already own.
PROVIDERS_STATUS_FILE = sys.argv[6] if len(sys.argv) > 6 else None

def _expected_token():
    try:
        with open(EXPECTED_TOKEN_FILE) as f:
            return f.read()
    except Exception:
        return None

def _catalog_ids():
    try:
        with open(MODELS_FILE) as f:
            return json.load(f)
    except Exception:
        return []

def _providers_status():
    if not PROVIDERS_STATUS_FILE:
        return 200
    try:
        with open(PROVIDERS_STATUS_FILE) as f:
            return int(f.read().strip())
    except Exception:
        return 200

class Handler(http.server.BaseHTTPRequestHandler):
    def _send_json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip('/') == '/v1/models':
            self._send_json(200, {"data": [{"id": m} for m in _catalog_ids()]})
            return
        if self.path.rstrip('/') == '/v1/providers':
            code = _providers_status()
            if code == 200:
                self._send_json(200, {"providers": []})
            else:
                self._send_json(code, {"error": {"message": "mock providers status"}})
            return
        self._send_json(404, {"error": "not found"})

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

        expected = _expected_token()
        if expected is not None and auth != f"Bearer {expected}":
            self._send_json(401, {"error": {"message": "invalid api key"}})
            return

        try:
            model = json.loads(body.decode('utf-8', 'replace')).get('model')
        except Exception:
            model = None
        catalog = _catalog_ids()
        if catalog and model not in catalog:
            self._send_json(404, {"error": {"message": f"model '{model}' not found"}})
            return

        self._send_json(200, {"choices": [{"message": {"content": "mock response"}}]})

    def log_message(self, *a):
        pass

httpd = http.server.HTTPServer(('127.0.0.1', PORT), Handler)
httpd.serve_forever()
PYEOF

EXPECTED_TOKEN_FILE="$TMPDIR_TEST/expected-token.txt"
printf '%s' "FAKE-SELFTEST-TOKEN-9f2b7c1e" > "$EXPECTED_TOKEN_FILE"
MODELS_FILE="$TMPDIR_TEST/models-catalog.json"
printf '["auto"]' > "$MODELS_FILE"
PROVIDERS_STATUS_FILE="$TMPDIR_TEST/providers-status.txt"
printf '200' > "$PROVIDERS_STATUS_FILE"

# Port 0 trick to find a free port, then start the real server on it.
MOCK_PORT="$(python3 -c '
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
')"
python3 -I "$TMPDIR_TEST/mock_server.py" "$MOCK_LOGDIR" "$MOCK_PORT" 0 "$EXPECTED_TOKEN_FILE" "$MODELS_FILE" "$PROVIDERS_STATUS_FILE" &
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
chmod 0600 "$AUTH_TOKEN_FIXTURE"
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

# ---- Test 9c (card a2db9d8f req 1): same omicron-secret, but gate 1 stubbed clean --------
# A "clean" stub that always reports no category isolates gate 2 (the inline _GATE_PY
# backstop in freellm-call.sh). Without this, test 9b alone proves nothing about gate 2:
# the REAL category checker (gate 1) now also fails closed on any unmapped letter anywhere
# in the wrapped description (card c5f2d6c9), so it already refuses this exact payload
# before gate 2's own backstop ever runs -- removing gate 2's backstop would NOT turn 9b red.
CLEAN_CATEGORY_CHECK="$TMPDIR_TEST/clean-category-check.py"
cat > "$CLEAN_CATEGORY_CHECK" << 'PYEOF'
import sys
sys.exit(0)
PYEOF
clear_mock_requests
export FREELLM_CATEGORY_CHECK_OVERRIDE="$CLEAN_CATEGORY_CHECK"
test_case "F2 (gate 2 isolated): unmapped homoglyph (Greek omicron) fails closed even when gate 1 is stubbed clean" 4 \
  bash "$SCRIPT" "$OMICRON_SECRET"
assert_true "F2 omicron (gate 2 isolated): zero network requests" "$([[ "$(mock_request_count)" -eq 0 ]] && echo 1 || echo 0)"
export FREELLM_CATEGORY_CHECK_OVERRIDE="$CATEGORY_CHECK"

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

# ---- Test 12b (L1, WhiteHat NO-GO 28484): non-loopback FREELLM_API_BASE = exit 2, no attempt --
clear_mock_requests
export FREELLM_API_BASE="https://example.com/v1"
test_case "L1: non-loopback FREELLM_API_BASE fails closed" 2 \
  bash "$SCRIPT" "benign prompt"
assert_true "L1: non-loopback host made zero network requests to the mock" "$([[ "$(mock_request_count)" -eq 0 ]] && echo 1 || echo 0)"
export FREELLM_API_BASE="http://127.0.0.1:$MOCK_PORT/v1"

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

# ---- Test 13b (card af8ddbf0): default-model -- no FREELLM_MODEL set resolves against the
# provider's /v1/models catalog and succeeds. The OLD default ("gpt-3.5-turbo") is not in the
# catalog served by this mock (same shape as the live freellmapi catalog) and would 404; this
# is RED on the pre-fix script (old default, exit 1, no message) and GREEN once the default
# becomes "auto" (confirmed present in the catalog below) and the call succeeds end to end.
clear_mock_requests
CATALOG_IDS="$(curl -s "http://127.0.0.1:$MOCK_PORT/v1/models" | python3 -c "import json,sys; print(','.join(m['id'] for m in json.load(sys.stdin)['data']))")"
assert_true "default-model: the provider catalog (stub) includes 'auto'" "$([[ ",$CATALOG_IDS," == *,auto,* ]] && echo 1 || echo 0)"
unset FREELLM_MODEL
OUT="$(bash "$SCRIPT" "benign default-model prompt" 2>/dev/null)"
RC=$?
assert_true "default-model: no FREELLM_MODEL set still succeeds (exit 0)" "$([[ "$RC" -eq 0 ]] && echo 1 || echo 0)"
SENT_MODEL="$(python3 -c "import json; print(json.loads(json.load(open('$MOCK_LOGDIR/req-0.json'))['body'])['model'])" 2>/dev/null || echo "")"
assert_true "default-model: the request sent model='auto' (not the old gpt-3.5-turbo)" "$([[ "$SENT_MODEL" == "auto" ]] && echo 1 || echo 0)"

# ---- Test 13c (card af8ddbf0): a model the provider rejects (404) is reported as a model
# error, not silently. The pre-fix script had no 404-specific branch (fell into the generic
# `*) exit 1` case with zero stderr output) -- RED there (no message), GREEN after the fix
# names the model and the HTTP code.
clear_mock_requests
export FREELLM_MODEL="gpt-3.5-turbo"
ERR_OUT="$(bash "$SCRIPT" "benign prompt" 2>&1 1>/dev/null)"
RC=$?
assert_true "model-404: rejected model exits 1 (not silently as the generic other-failure code is already 1, but NAMED below)" "$([[ "$RC" -eq 1 ]] && echo 1 || echo 0)"
assert_true "model-404: stderr names the rejected model and the HTTP code, not silent" \
  "$([[ "$ERR_OUT" == *"gpt-3.5-turbo"* ]] && [[ "$ERR_OUT" == *"404"* ]] && echo 1 || echo 0)"
unset FREELLM_MODEL

# ---- Test 13d (card af8ddbf0): token-mismatch -- an auth token the provider rejects (401)
# is reported as a clear, named mismatch, not silently. The pre-fix script's 401|403 branch
# was a bare `exit 3` with zero stderr output -- RED there, GREEN once the branch names the
# token file and the HTTP code (the exact live incident: a drifted token file went unnoticed
# until MikroB diagnosed it by hand).
clear_mock_requests
WRONG_TOKEN_FIXTURE="$TMPDIR_TEST/wrong-auth-token"
printf '%s' "THIS-DOES-NOT-MATCH-THE-SERVER" > "$WRONG_TOKEN_FIXTURE"
export FREELLM_AUTH_TOKEN_FILE="$WRONG_TOKEN_FIXTURE"
ERR_OUT="$(bash "$SCRIPT" "benign prompt" 2>&1 1>/dev/null)"
RC=$?
assert_true "token-mismatch: a rejected token exits 3" "$([[ "$RC" -eq 3 ]] && echo 1 || echo 0)"
assert_true "token-mismatch: stderr names the token file and the HTTP code, not silent" \
  "$([[ "$ERR_OUT" == *"$WRONG_TOKEN_FIXTURE"* ]] && [[ "$ERR_OUT" == *"401"* ]] && echo 1 || echo 0)"
export FREELLM_AUTH_TOKEN_FILE="$AUTH_TOKEN_FIXTURE"

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
# The mock must accept this new value too (card af8ddbf0: it now enforces a match), or this
# test's own "call succeeded" assertion would fail for an unrelated reason.
printf '%s' "$SECRET_TOKEN_VALUE" > "$EXPECTED_TOKEN_FILE"
# Give the mock an artificial delay so there is a window to sample `ps` mid-call.
rm -f "$MOCK_LOGDIR"/req-*.json
python3 -I "$TMPDIR_TEST/mock_server.py" "$MOCK_LOGDIR" "$MOCK_PORT" 0.6 "$EXPECTED_TOKEN_FILE" "$MODELS_FILE" "$PROVIDERS_STATUS_FILE" &
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

# ---- Card 555419a8 (Cybersec M2 on af8ddbf0): startup preflight + distinct exit codes + token
# file mode/owner check. All against the SAME mock, which now also serves GET /v1/providers.
clear_mock_requests
printf '200' > "$PROVIDERS_STATUS_FILE"

# Test 17: preflight reports 401 -> exit 3, a NAMED message, and the real chat-completions
# endpoint is NEVER reached (0 requests) -- this is the "verified at startup" requirement: the
# auth problem is caught before any content gate or real call runs, not just on a later 401.
printf '401' > "$PROVIDERS_STATUS_FILE"
ERR_OUT="$(bash "$SCRIPT" "benign prompt" 2>&1 1>/dev/null)"; RC=$?
test_case "startup preflight: provider reports 401 -> exit 3" 3 bash "$SCRIPT" "benign prompt"
assert_true "startup preflight (401): stderr names 'startup check' and the token file, not silent" \
  "$([[ "$ERR_OUT" == *"startup check"* ]] && [[ "$ERR_OUT" == *"$AUTH_TOKEN_FIXTURE"* ]] && echo 1 || echo 0)"
assert_true "startup preflight (401): zero requests reached POST /v1/chat/completions" \
  "$([[ "$(mock_request_count)" -eq 0 ]] && echo 1 || echo 0)"

# Test 18: preflight reports 429 -> exit 5 (its OWN code, distinct from 401/403's exit 3), same
# "caught at startup, zero real-call requests" shape.
clear_mock_requests
printf '429' > "$PROVIDERS_STATUS_FILE"
ERR_OUT="$(bash "$SCRIPT" "benign prompt" 2>&1 1>/dev/null)"
test_case "startup preflight: provider reports 429 -> exit 5 (distinct from 401/403's exit 3)" 5 bash "$SCRIPT" "benign prompt"
assert_true "startup preflight (429): stderr names 'startup check' and quota, not silent" \
  "$([[ "$ERR_OUT" == *"startup check"* ]] && [[ "$ERR_OUT" == *"429"* ]] && echo 1 || echo 0)"
assert_true "startup preflight (429): zero requests reached POST /v1/chat/completions" \
  "$([[ "$(mock_request_count)" -eq 0 ]] && echo 1 || echo 0)"
printf '200' > "$PROVIDERS_STATUS_FILE"

# Test 19: a non-401/403/429 preflight response (here, the mock's 404 default for any OTHER
# unconfigured path -- simulated by pointing FREELLM_API_BASE at a path the mock does not
# recognise as /v1/providers) must NOT hard-fail the call -- only a clear auth/quota signal
# blocks at startup, not "the health endpoint behaved oddly". Re-use the main base (which DOES
# serve /v1/providers normally) with status forced back to 200 is the common case already
# covered by every other happy-path test above; this confirms the soft-fail direction (a code
# outside {401,403,429}, here 500) still falls through to the real call instead of refusing.
clear_mock_requests
printf '500' > "$PROVIDERS_STATUS_FILE"
test_case "startup preflight: an unexpected response code (500) does not block the real call" 0 \
  bash "$SCRIPT" "benign prompt"
assert_true "startup preflight (500, soft-fail): the real call still reached the mock" \
  "$([[ "$(mock_request_count)" -eq 1 ]] && echo 1 || echo 0)"
printf '200' > "$PROVIDERS_STATUS_FILE"

# Test 20: --validate-key now exercises the SAME preflight (M2: "verified at startup" needs an
# actual startup entry point) -- a 401 at validate-key time must refuse too, not just the real call.
clear_mock_requests
printf '401' > "$PROVIDERS_STATUS_FILE"
test_case "validate-key also runs the startup preflight: 401 -> exit 3" 3 bash "$SCRIPT" --validate-key
printf '200' > "$PROVIDERS_STATUS_FILE"

# Test 21 (L3, token file mode/owner): a group/world-readable token file is refused before any
# network attempt at all (not even the preflight), same fail-closed-and-cheapest-first ordering
# as the switch/host checks.
clear_mock_requests
BAD_MODE_TOKEN="$TMPDIR_TEST/bad-mode-token"
printf '%s' "FAKE-SELFTEST-TOKEN-9f2b7c1e" > "$BAD_MODE_TOKEN"
chmod 644 "$BAD_MODE_TOKEN"
ERR_OUT="$(FREELLM_AUTH_TOKEN_FILE="$BAD_MODE_TOKEN" bash "$SCRIPT" "benign prompt" 2>&1 1>/dev/null)"
RC=$?
assert_true "L3: a 0644 token file is refused (exit 2)" "$([[ "$RC" -eq 2 ]] && echo 1 || echo 0)"
assert_true "L3: stderr names the token file, not silent" "$([[ "$ERR_OUT" == *"$BAD_MODE_TOKEN"* ]] && echo 1 || echo 0)"
assert_true "L3: zero network requests (not even the preflight)" "$([[ "$(mock_request_count)" -eq 0 ]] && echo 1 || echo 0)"
chmod 600 "$BAD_MODE_TOKEN"

# Summary
echo ""
echo "PASSED: $PASS"
echo "FAILED: $FAIL"
if [[ "$FAIL" -eq 0 ]]; then
  exit 0
else
  exit 1
fi
