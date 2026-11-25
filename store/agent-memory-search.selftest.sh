#!/usr/bin/env bash
# Regression test for store/agent-memory-search.sh (card 01eb0d0c).
set -euo pipefail

SELF_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SELF_DIR/agent-memory-search.sh"
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
MOCK_REQ_LOG="$WORK/mock-requests.log"
: > "$MOCK_REQ_LOG"
python3 -c "
import http.server
from urllib.parse import urlparse, parse_qs

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        with open('$MOCK_REQ_LOG', 'a') as f:
            f.write(parsed.path + '?' + parsed.query + chr(10))
        if parsed.path != '/api/memories':
            self.send_response(404)
            self.end_headers()
            return
        q = qs.get('q', [''])[0]
        if q == 'badraw':
            # simulate the raw-accent-in-q 400: no X-Memory-Search header, empty body.
            self.send_response(400)
            self.end_headers()
            return
        if q == 'relaxedcase':
            self.send_response(200)
            self.send_header('X-Memory-Search', 'relaxed=true; hits=3')
            body = b'[{\"content\":\"approx match\"}]'
        elif q == 'strictcase':
            self.send_response(200)
            self.send_header('X-Memory-Search', 'relaxed=false; hits=0')
            body = b'[]'
        else:
            self.send_response(200)
            self.send_header('X-Memory-Search', 'relaxed=false; hits=1')
            body = b'[{\"content\":\"real match\"}]'
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

# Case 1: a normal hit -> exit 0, prints the X-Memory-Search header to stderr and the body to stdout.
OUT="$(bash "$SCRIPT" backend goodquery 2>"$WORK/stderr1")"
RC=0
if echo "$OUT" | grep -q "real match"; then
  pass "a real hit prints the body"
else
  fail "a real hit prints the body (got: $OUT)"
fi
if grep -qi "x-memory-search" "$WORK/stderr1"; then
  pass "the X-Memory-Search header is surfaced, not just the body"
else
  fail "the X-Memory-Search header is surfaced"
fi

# Case 2: a raw accented query reaches the server PERCENT-ENCODED, not as a raw 400-triggering byte.
bash "$SCRIPT" backend "funkcionális" >/dev/null 2>"$WORK/stderr2" || true
LAST_REQ="$(tail -n1 "$MOCK_REQ_LOG")"
if echo "$LAST_REQ" | grep -qi '%C3%A1' ; then
  pass "an accented query is percent-encoded before it reaches the server"
else
  fail "an accented query is percent-encoded before it reaches the server (got: $LAST_REQ)"
fi

# Case 3: relaxed=true -> exit 6, and a distinct warning that this is NOT evidence of a real match.
set +e
OUT="$(bash "$SCRIPT" backend relaxedcase 2>"$WORK/stderr3")"
RC=$?
set -e
if [ "$RC" = "6" ] && grep -qi "SAVED APPROXIMATION" "$WORK/stderr3"; then
  pass "relaxed=true exits non-zero with a clear approximation warning"
else
  fail "relaxed=true exits non-zero with a clear approximation warning (rc=$RC, stderr: $(cat "$WORK/stderr3"))"
fi

# Case 4: relaxed=false + hits=0 -> exit 0 (a real, verified zero-hit search is a valid answer).
set +e
OUT="$(bash "$SCRIPT" backend strictcase 2>"$WORK/stderr4")"
RC=$?
set -e
if [ "$RC" = "0" ]; then
  pass "relaxed=false hits=0 is a valid, non-error zero-hit answer"
else
  fail "relaxed=false hits=0 is a valid, non-error zero-hit answer (rc=$RC)"
fi

# Case 5: the documented silent-400 trap (no X-Memory-Search header, empty body on a non-200) --
# must be surfaced as a failure (exit 5), never presented as an empty-but-valid search.
set +e
OUT="$(bash "$SCRIPT" backend badraw 2>"$WORK/stderr5")"
RC=$?
set -e
if [ "$RC" = "5" ]; then
  pass "a request that never completed (400, no header) is reported as failed, not as a zero-hit search"
else
  fail "a request that never completed is reported as failed (rc=$RC, stdout: $OUT)"
fi

[ "$FAIL" = "0" ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
