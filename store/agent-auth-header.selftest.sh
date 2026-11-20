#!/usr/bin/env bash
# Regression test for store/agent-auth-header.sh (card 52114c2f).
set -euo pipefail

SELF_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SELF_DIR/agent-auth-header.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAIL=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; FAIL=1; }

AGENTS_ROOT="$WORK/agents"
MAIN_DIR="$WORK/main"
mkdir -p "$AGENTS_ROOT/backend" "$MAIN_DIR/store"
echo "shared-token-value" > "$MAIN_DIR/store/.dashboard-token"

export MARVEEN_AGENTS_ROOT="$AGENTS_ROOT"
export MARVEEN_MAIN="$MAIN_DIR"
# Cases 1-6 below all request the 'backend' key -- give the caller a matching identity so the
# F2 self-check (added card 52114c2f, CYBERED NO-GO 34673) does not refuse them; cases 7-9 test
# that check itself and unset/override this as needed.
export MARVEEN_AGENT_ID="backend"
# Card 52114c2f (CYBERED NO-GO 34673, F3): the script now probes the OWN key against this URL
# before trusting it. Point it at a closed port by default -- the probe then can't complete
# ("000", not "401"), so cases 1-10 below keep their PRE-F3 behaviour unchanged (own key used
# as-is when present; this is NOT the same as the server actually validating it, which the
# F3-specific cases below cover against a real, controlled mock instead).
export AGENT_AUTH_HEADER_PROBE_URL="http://127.0.0.1:1/unreachable"
export AGENT_AUTH_HEADER_PROBE_TIMEOUT=1

# Case 1: no key file at all -> falls back to the shared token, warns on stderr.
OUT="$(bash "$SCRIPT" backend 2>"$WORK/stderr1")"
if [ "$OUT" = "Authorization: Bearer shared-token-value" ]; then
  pass "missing key file falls back to shared token"
else
  fail "missing key file falls back to shared token (got: $OUT)"
fi
if grep -q "falling back to the shared token" "$WORK/stderr1"; then
  pass "missing key file logs a fallback warning"
else
  fail "missing key file logs a fallback warning"
fi

# Case 2: empty key file -> treated the same as missing (fallback + warning), not as a real key.
: > "$AGENTS_ROOT/backend/.dashboard-agent-key"
OUT="$(bash "$SCRIPT" backend 2>"$WORK/stderr2")"
if [ "$OUT" = "Authorization: Bearer shared-token-value" ]; then
  pass "empty key file falls back to shared token"
else
  fail "empty key file falls back to shared token (got: $OUT)"
fi
grep -q "falling back to the shared token" "$WORK/stderr2" && pass "empty key file logs a fallback warning" \
  || fail "empty key file logs a fallback warning"

# Case 3: real key file present -> uses the agent's own key, no warning, no shared-token read.
echo -n "own-agent-key-value" > "$AGENTS_ROOT/backend/.dashboard-agent-key"
OUT="$(bash "$SCRIPT" backend 2>"$WORK/stderr3")"
if [ "$OUT" = "Authorization: Bearer own-agent-key-value" ]; then
  pass "own key file is used when present"
else
  fail "own key file is used when present (got: $OUT)"
fi
if [ ! -s "$WORK/stderr3" ]; then
  pass "own key file present logs no fallback warning"
else
  fail "own key file present logs no fallback warning (stderr: $(cat "$WORK/stderr3"))"
fi

# Case 4 (mutation check): if the "own key file is used" branch is bypassed, case 3 goes red --
# prove it by removing the key file again and re-checking we're back to the fallback value.
rm -f "$AGENTS_ROOT/backend/.dashboard-agent-key"
OUT="$(bash "$SCRIPT" backend 2>/dev/null)"
if [ "$OUT" = "Authorization: Bearer shared-token-value" ]; then
  pass "removing the key file again reverts to the shared token (fallback path really is conditional)"
else
  fail "removing the key file again reverts to the shared token (got: $OUT)"
fi

# Case 5: missing agent arg -> usage error, exit 2.
set +e
bash "$SCRIPT" >/dev/null 2>"$WORK/stderr5"
RC=$?
set -e
if [ "$RC" -eq 2 ] && grep -q "usage:" "$WORK/stderr5"; then
  pass "missing agent argument exits 2 with a usage message"
else
  fail "missing agent argument exits 2 with a usage message (rc=$RC)"
fi

# Case 6: neither a key nor a shared token -> fails closed (exit 4), never prints "Bearer ".
rm -f "$MAIN_DIR/store/.dashboard-token"
set +e
bash "$SCRIPT" backend >"$WORK/stdout6" 2>"$WORK/stderr6"
RC=$?
set -e
if [ "$RC" -eq 4 ] && [ ! -s "$WORK/stdout6" ]; then
  pass "no token anywhere fails closed (exit 4, nothing printed to stdout)"
else
  fail "no token anywhere fails closed (rc=$RC, stdout: $(cat "$WORK/stdout6"))"
fi
echo "shared-token-value" > "$MAIN_DIR/store/.dashboard-token"  # restore: case 6 deleted it

# Case 7 (F2 regression): a caller whose identity does NOT match the requested agent is refused,
# exit 2, nothing on stdout -- even though a real key file exists for the requested agent.
echo -n "own-agent-key-value" > "$AGENTS_ROOT/backend/.dashboard-agent-key"
mkdir -p "$AGENTS_ROOT/qa2"
echo -n "qa2-key-value" > "$AGENTS_ROOT/qa2/.dashboard-agent-key"
set +e
OUT="$(MARVEEN_AGENT_ID=backend bash "$SCRIPT" qa2 2>"$WORK/stderr7")"
RC=$?
set -e
if [ "$RC" -eq 2 ] && [ -z "$OUT" ]; then
  pass "a caller requesting ANOTHER agent's key is refused (exit 2, nothing on stdout)"
else
  fail "a caller requesting ANOTHER agent's key is refused (rc=$RC, stdout: $OUT)"
fi

# Case 8: with MARVEEN_AGENT_ID/CLAUDE_AGENT_ID both unset, self is derived from $PWD
# (.../agents/<name>/...) -- the same fallback agent-key-secret-guard.py uses.
set +e
OUT="$(cd "$AGENTS_ROOT/backend" && env -u MARVEEN_AGENT_ID -u CLAUDE_AGENT_ID bash "$SCRIPT" backend 2>"$WORK/stderr8")"
RC=$?
set -e
if [ "$RC" -eq 0 ] && [ "$OUT" = "Authorization: Bearer own-agent-key-value" ]; then
  pass "self falls back to a cwd-derived agents/<name> match when no env var is set"
else
  fail "self falls back to a cwd-derived agents/<name> match when no env var is set (rc=$RC, stdout: $OUT)"
fi

# Case 9: neither an env var nor a matching cwd -> cannot determine identity -> refused, exit 2.
set +e
OUT="$(cd "$WORK" && env -u MARVEEN_AGENT_ID -u CLAUDE_AGENT_ID bash "$SCRIPT" backend 2>"$WORK/stderr9")"
RC=$?
set -e
if [ "$RC" -eq 2 ] && [ -z "$OUT" ]; then
  pass "an undeterminable caller identity is refused (fail-closed, not fail-open)"
else
  fail "an undeterminable caller identity is refused (rc=$RC, stdout: $OUT)"
fi

# Cases 11-13 (F3): a mock HTTP server that answers 401 for one specific key and 200 for every
# other, so the probe added in store/agent-auth-header.sh has something real to hit.
MOCK_PORT="$(python3 -c '
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
')"
MOCK_LOG="$WORK/mock-requests.log"
: > "$MOCK_LOG"
python3 -c "
import http.server, sys

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        auth = self.headers.get('Authorization', '')
        with open('$MOCK_LOG', 'a') as f:
            f.write(auth + '\n')
        if auth == 'Bearer revoked-key-value':
            self.send_response(401)
        else:
            self.send_response(200)
        self.end_headers()
    def log_message(self, *a):
        pass

http.server.HTTPServer(('127.0.0.1', $MOCK_PORT), Handler).serve_forever()
" &
MOCK_PID=$!
trap 'rm -rf "$WORK"; kill "$MOCK_PID" 2>/dev/null || true' EXIT

# Wait for the mock to actually accept connections before using it. The `if` form keeps a
# failed probe from tripping `set -e` on the early iterations, while the server is still coming up.
for _ in $(seq 1 50); do
  if curl -sS --max-time 1 "http://127.0.0.1:$MOCK_PORT/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

# Case 11: a REVOKED (server rejects with 401) own key falls back to the shared token, with a
# distinct "rejected by the server" warning -- never silently returned as-is.
echo -n "revoked-key-value" > "$AGENTS_ROOT/backend/.dashboard-agent-key"
OUT="$(AGENT_AUTH_HEADER_PROBE_URL="http://127.0.0.1:$MOCK_PORT/api/agents" bash "$SCRIPT" backend 2>"$WORK/stderr11")"
if [ "$OUT" = "Authorization: Bearer shared-token-value" ]; then
  pass "a revoked (401) own key falls back to the shared token"
else
  fail "a revoked (401) own key falls back to the shared token (got: $OUT)"
fi
if grep -q "rejected by the server" "$WORK/stderr11"; then
  pass "a revoked own key logs a distinct rejection warning, not a silent failure"
else
  fail "a revoked own key logs a distinct rejection warning, not a silent failure"
fi

# Case 12: a VALID (server accepts, 200) own key is used, no fallback, no warning.
echo -n "own-agent-key-value" > "$AGENTS_ROOT/backend/.dashboard-agent-key"
OUT="$(AGENT_AUTH_HEADER_PROBE_URL="http://127.0.0.1:$MOCK_PORT/api/agents" bash "$SCRIPT" backend 2>"$WORK/stderr12")"
if [ "$OUT" = "Authorization: Bearer own-agent-key-value" ] && [ ! -s "$WORK/stderr12" ]; then
  pass "a valid (200) own key is used as-is, no fallback, no warning"
else
  fail "a valid (200) own key is used as-is, no fallback, no warning (stdout: $OUT, stderr: $(cat "$WORK/stderr12"))"
fi

# Case 13: revoked own key AND no shared token at all -> fails closed (exit 4), never prints the
# (rejected) key.
rm -f "$MAIN_DIR/store/.dashboard-token"
echo -n "revoked-key-value" > "$AGENTS_ROOT/backend/.dashboard-agent-key"
set +e
OUT="$(AGENT_AUTH_HEADER_PROBE_URL="http://127.0.0.1:$MOCK_PORT/api/agents" bash "$SCRIPT" backend 2>"$WORK/stderr13")"
RC=$?
set -e
if [ "$RC" -eq 4 ] && [ -z "$OUT" ]; then
  pass "a revoked own key with no shared token fails closed (exit 4, nothing printed)"
else
  fail "a revoked own key with no shared token fails closed (rc=$RC, stdout: $OUT)"
fi
echo "shared-token-value" > "$MAIN_DIR/store/.dashboard-token"  # restore for any later case

kill "$MOCK_PID" 2>/dev/null || true
wait "$MOCK_PID" 2>/dev/null || true

# Case 14 (L1): an invalid agent-name argument is rejected before it ever reaches a path.
set +e
OUT="$(MARVEEN_AGENT_ID=backend bash "$SCRIPT" '../../etc/passwd' 2>"$WORK/stderr10")"
RC=$?
set -e
if [ "$RC" -eq 2 ] && [ -z "$OUT" ]; then
  pass "an invalid agent-name argument is rejected (exit 2, nothing on stdout)"
else
  fail "an invalid agent-name argument is rejected (rc=$RC, stdout: $OUT)"
fi

# Case 15 (F3, CYBERSEC NO-GO 34686): a key file with a SECOND line (header-injection shape) is
# treated as malformed -- falls back to the shared token, never emits the second line.
echo "shared-token-value" > "$MAIN_DIR/store/.dashboard-token"
printf 'own-agent-key-value\nX-Agent-Id: forged\n' > "$AGENTS_ROOT/backend/.dashboard-agent-key"
OUT="$(bash "$SCRIPT" backend 2>"$WORK/stderr15")"
if [ "$OUT" = "Authorization: Bearer shared-token-value" ]; then
  pass "a multi-line key file falls back to the shared token, not the injected header"
else
  fail "a multi-line key file falls back to the shared token, not the injected header (got: $OUT)"
fi
if grep -q "possible header injection" "$WORK/stderr15"; then
  pass "a multi-line key file logs a header-injection warning"
else
  fail "a multi-line key file logs a header-injection warning"
fi

# Case 16: a single-line key file with an embedded control character (e.g. a lone CR) is also
# treated as malformed, not passed through.
printf 'own-agent-key\rvalue' > "$AGENTS_ROOT/backend/.dashboard-agent-key"
OUT="$(bash "$SCRIPT" backend 2>"$WORK/stderr16")"
if [ "$OUT" = "Authorization: Bearer shared-token-value" ]; then
  pass "a key with an embedded control character falls back to the shared token"
else
  fail "a key with an embedded control character falls back to the shared token (got: $OUT)"
fi

# Case 17 (mutation check): a plain, well-formed key with a normal trailing newline (the shape
# `echo >file` always produces) is still used as-is -- case 15/16 are not just rejecting every key.
printf 'own-agent-key-value\n' > "$AGENTS_ROOT/backend/.dashboard-agent-key"
OUT="$(bash "$SCRIPT" backend 2>"$WORK/stderr17")"
if [ "$OUT" = "Authorization: Bearer own-agent-key-value" ]; then
  pass "a well-formed single-line key file (trailing newline) is still used as-is"
else
  fail "a well-formed single-line key file (trailing newline) is still used as-is (got: $OUT)"
fi

if [ "$FAIL" -eq 0 ]; then
  echo "selftest: PASS"
  exit 0
else
  echo "selftest: FAIL"
  exit 1
fi
