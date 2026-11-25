#!/usr/bin/env bash
# Regression test for store/agent-message-close.sh (card 01eb0d0c).
set -euo pipefail

SELF_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SELF_DIR/agent-message-close.sh"
WORK="$(mktemp -d)"

FAIL=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; FAIL=1; }

AGENTS_ROOT="$WORK/agents"
MAIN_DIR="$WORK/main"
mkdir -p "$AGENTS_ROOT/backend" "$MAIN_DIR/store"
echo "shared-token-value" > "$MAIN_DIR/store/.dashboard-token"
export MARVEEN_AGENTS_ROOT="$AGENTS_ROOT"
export MARVEEN_MAIN="$MAIN_DIR"
export MARVEEN_AGENT_ID="backend"

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
import http.server, json

class Handler(http.server.BaseHTTPRequestHandler):
    def do_PUT(self):
        length = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(length)
        with open('$MOCK_LOG', 'a') as f:
            f.write(self.path + ' ' + raw.decode().rstrip(chr(10)) + chr(10))
        if self.path == '/api/messages/409000':
            self.send_response(409)
            body = b'{\"error\":\"Message already closed\"}'
        else:
            try:
                parsed = json.loads(raw)
                notify_ok = isinstance(parsed.get('notify'), bool)
            except Exception:
                notify_ok = False
            if not notify_ok:
                self.send_response(400)
                body = b'{\"error\":\"notify must be boolean\"}'
            else:
                self.send_response(200)
                body = json.dumps({'ok': True, 'echo': parsed}).encode()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass

http.server.HTTPServer(('127.0.0.1', $MOCK_PORT), Handler).serve_forever()
" &
MOCK_PID=$!
trap 'rm -rf "$WORK"; kill "$MOCK_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  if curl -sS --max-time 1 "http://127.0.0.1:$MOCK_PORT/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

export MARVEEN_DASHBOARD_ORIGIN="http://127.0.0.1:$MOCK_PORT"

# Case 1: default close (no flags) -> notify:false, status:"done", real JSON boolean.
OUT="$(bash "$SCRIPT" backend 123)"
if echo "$OUT" | grep -q '"ok": true' || echo "$OUT" | grep -q '"ok":true'; then
  pass "default close succeeds"
else
  fail "default close succeeds (got: $OUT)"
fi
LAST_REQ="$(tail -n1 "$MOCK_LOG")"
if echo "$LAST_REQ" | grep -q '"notify": false' || echo "$LAST_REQ" | grep -q '"notify":false'; then
  pass "default close sends a real JSON boolean notify:false, never the string \"false\""
else
  fail "default close sends notify:false as a real boolean (got: $LAST_REQ)"
fi

# Case 2: --notify true + --result with a quote and a backtick -> must reach the server
# byte-exact, never shell-interpolated or executed.
OUT="$(bash "$SCRIPT" backend 124 --notify true --result 'done, found a "quote" and a `backtick`')"
LAST_REQ="$(tail -n1 "$MOCK_LOG")"
if echo "$LAST_REQ" | grep -q 'found a \\"quote\\" and a `backtick`'; then
  pass "a result containing quotes and backticks reaches the server literally, not executed"
else
  fail "a result containing quotes and backticks reaches the server literally (got: $LAST_REQ)"
fi

# Case 3: a 409 (already closed) is treated as a no-op success, not an error to retry.
set +e
OUT="$(bash "$SCRIPT" backend 409000 2>"$WORK/stderr3")"
RC=$?
set -e
if [ "$RC" = "0" ] && grep -q "already closed" "$WORK/stderr3" && grep -q "NOT applied" "$WORK/stderr3"; then
  pass "409 (already closed) exits 0 with a clear no-op message, says the result was not applied"
else
  fail "409 (already closed) exits 0 with a clear no-op message (rc=$RC, stderr: $(cat "$WORK/stderr3"))"
fi

# Case 4: bad usage (missing message id) -> exit 2, no request sent.
BEFORE_LINES="$(wc -l < "$MOCK_LOG")"
set +e
bash "$SCRIPT" backend >/dev/null 2>"$WORK/stderr4"
RC=$?
set -e
AFTER_LINES="$(wc -l < "$MOCK_LOG")"
if [ "$RC" = "2" ] && [ "$BEFORE_LINES" = "$AFTER_LINES" ]; then
  pass "missing message id is refused before any request is sent"
else
  fail "missing message id is refused before any request is sent (rc=$RC)"
fi

# Case 5: invalid --notify value is refused, not silently coerced.
set +e
bash "$SCRIPT" backend 125 --notify maybe >/dev/null 2>"$WORK/stderr5"
RC=$?
set -e
if [ "$RC" = "2" ] && grep -q "must be true or false" "$WORK/stderr5"; then
  pass "an invalid --notify value is refused"
else
  fail "an invalid --notify value is refused (rc=$RC, stderr: $(cat "$WORK/stderr5"))"
fi

# Case 6 (CYBERSEC NO-GO 38468, F1): --result-file reaches the server byte-exact even with a
# backtick and a command substitution inside -- the TAUGHT, quoting-risk-free form.
RESULT_FILE="$WORK/result.txt"
printf 'done: ran `touch %s/should-not-exist` and updated $(whoami) ok' "$WORK" > "$RESULT_FILE"
bash "$SCRIPT" backend 126 --notify true --result-file "$RESULT_FILE" >/dev/null
LAST_REQ="$(tail -n1 "$MOCK_LOG")"
if echo "$LAST_REQ" | grep -q 'touch ' && [ ! -e "$WORK/should-not-exist" ]; then
  pass "--result-file carries backticks/\$(...) literally and never executes them"
else
  fail "--result-file carries backticks/\$(...) literally and never executes them (got: $LAST_REQ)"
fi

# Case 7: --result-stdin reads the result from a pipe, same literal-byte guarantee.
printf 'done via stdin: `rm -rf %s/should-not-exist-either`' "$WORK" | bash "$SCRIPT" backend 127 --notify true --result-stdin >/dev/null
LAST_REQ="$(tail -n1 "$MOCK_LOG")"
if echo "$LAST_REQ" | grep -q 'done via stdin' && [ ! -e "$WORK/should-not-exist-either" ]; then
  pass "--result-stdin carries the piped text literally and never executes it"
else
  fail "--result-stdin carries the piped text literally and never executes it (got: $LAST_REQ)"
fi

# Case 8 (LOW1): a non-numeric / path-traversal-shaped message-id is refused before any request.
BEFORE_LINES="$(wc -l < "$MOCK_LOG")"
set +e
bash "$SCRIPT" backend '409/../../kanban/zzz?x=1' >/dev/null 2>"$WORK/stderr8"
RC=$?
set -e
AFTER_LINES="$(wc -l < "$MOCK_LOG")"
if [ "$RC" = "2" ] && [ "$BEFORE_LINES" = "$AFTER_LINES" ] && grep -q "plain positive integer" "$WORK/stderr8"; then
  pass "a path-traversal-shaped message-id is refused before any request is sent"
else
  fail "a path-traversal-shaped message-id is refused before any request is sent (rc=$RC)"
fi

# Case 9 (LOW2): MARVEEN_DASHBOARD_ORIGIN pointed at a non-loopback host is refused, so an env
# override cannot be used to send the bearer token to an arbitrary host.
set +e
MARVEEN_DASHBOARD_ORIGIN="http://example.com" bash "$SCRIPT" backend 128 >/dev/null 2>"$WORK/stderr9"
RC=$?
set -e
if [ "$RC" = "2" ] && grep -q "localhost/127.0.0.1" "$WORK/stderr9"; then
  pass "a non-loopback MARVEEN_DASHBOARD_ORIGIN is refused"
else
  fail "a non-loopback MARVEEN_DASHBOARD_ORIGIN is refused (rc=$RC, stderr: $(cat "$WORK/stderr9"))"
fi

# Case 10 (LOW3): a dead dashboard (connection refused) maps to the same exit 5 as an HTTP
# failure, with a message, instead of a silent -s failure.
DEAD_PORT=1
set +e
MARVEEN_DASHBOARD_ORIGIN="http://127.0.0.1:$DEAD_PORT" bash "$SCRIPT" backend 129 >/dev/null 2>"$WORK/stderr10"
RC=$?
set -e
if [ "$RC" = "5" ] && grep -q "PUT failed" "$WORK/stderr10"; then
  pass "a dead dashboard maps to exit 5 with a message, not a silent failure"
else
  fail "a dead dashboard maps to exit 5 with a message (rc=$RC, stderr: $(cat "$WORK/stderr10"))"
fi

[ "$FAIL" = "0" ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
