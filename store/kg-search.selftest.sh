#!/usr/bin/env bash
# Selftest for store/kg-search.sh (card 34c2d2a2 delta, WhiteHat NO-GO comment 24103).
#
# F1 MEDIUM: the old _hdr() created its mktemp header file inside a command-substitution subshell
# ($_HDR was only ever set there), so the parent's EXIT trap always ran `rm -f ""` -- every
# invocation leaked one token-bearing /tmp file. The fix removes the temp file entirely (pipe the
# token straight into curl's stdin), so there is nothing left to leak.
#
# F3 LOW: KG_SEARCH_API must reject a non-localhost target, and --k must be digits only.
#
# This test runs against a disposable, local-only Python HTTP server, never the real dashboard.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

WORKDIR="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

FAKE_TOKEN="kg-search-selftest-token-$$-$RANDOM"
cp "$SCRIPT_DIR/kg-search.sh" "$WORKDIR/kg-search.sh"
printf '%s' "$FAKE_TOKEN" > "$WORKDIR/.dashboard-token"

CAPTURE_LOG="$WORKDIR/capture.log"
PATH_LOG="$WORKDIR/path.log"
: > "$CAPTURE_LOG"
: > "$PATH_LOG"
PORT=$(( (RANDOM % 5000) + 21000 ))

python3 - "$PORT" "$CAPTURE_LOG" "$PATH_LOG" > "$WORKDIR/server.log" 2>&1 <<'PYEOF' &
import http.server
import json
import sys

port = int(sys.argv[1])
log_path = sys.argv[2]
path_log_path = sys.argv[3]


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        with open(log_path, "a") as f:
            f.write((self.headers.get("Authorization") or "") + "\n")
        with open(path_log_path, "a") as f:
            f.write(self.path + "\n")

        # F6/pretty-printer selftest: a search request for q=prettytest gets a real "results"
        # payload back, so the non-json _pretty() code path actually runs end to end.
        if self.path.startswith("/api/kg/search") and "q=prettytest" in self.path:
            body = json.dumps({
                "meta": {"scope": "all", "hits": 1, "relaxed": False, "strict": False},
                "results": [{"type": "card", "id": "abc123", "score": 0.5, "status": "done",
                             "title": "T", "why": "W"}],
            }).encode()
            self.send_response(200)
        else:
            body = json.dumps({"error": "kg_disabled"}).encode()
            self.send_response(404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
PYEOF
SERVER_PID=$!

for _ in $(seq 1 30); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
  sleep 0.1
done

FAILS=0
CHECKS=0
check() {
  CHECKS=$((CHECKS + 1))
  if [ "$1" = "0" ]; then
    echo "PASS: $2"
  else
    echo "FAIL: $2"
    FAILS=$((FAILS + 1))
  fi
}

# From here on every assertion is routed through check(), which handles the non-zero case
# itself -- errexit would otherwise abort the script on the FIRST failing assertion instead of
# collecting all of them, which is also exactly the failure mode this test must survive when run
# against the pre-fix script (that is the whole point of the mutation check).
set +e

# -s suppresses "Is a directory" noise (the same tmp.* glob also matches other processes' temp
# DIRECTORIES, e.g. other mktemp -d callers on this shared box).
before=$(grep -slF "$FAKE_TOKEN" /tmp/tmp.* 2>/dev/null | wc -l)

KG_SEARCH_API="http://127.0.0.1:$PORT" bash "$WORKDIR/kg-search.sh" search --q selftest --project x --json \
  >/dev/null 2>"$WORKDIR/run1.err"

after=$(grep -slF "$FAKE_TOKEN" /tmp/tmp.* 2>/dev/null | wc -l)
[ "$after" -le "$before" ]
check "$?" "F1: no token-bearing /tmp file left behind after a run ($before -> $after)"

grep -q "Bearer $FAKE_TOKEN" "$CAPTURE_LOG"
check "$?" "F1-sanity: server actually received the real Bearer token via the pipe"

KG_SEARCH_API="http://evil.example.com" bash "$WORKDIR/kg-search.sh" search --q x --project y \
  >/dev/null 2>"$WORKDIR/f3.err"
rc=$?
# A plain non-zero exit is not enough here: the OLD script also exits non-zero against
# evil.example.com (curl cannot resolve/reach it), for the wrong reason -- no KG_SEARCH_API check
# ever ran. Require the script's OWN rejection message, not any failure.
[ "$rc" -ne 0 ] && grep -q "KG_SEARCH_API must be" "$WORKDIR/f3.err"
check "$?" "F3: non-localhost KG_SEARCH_API is rejected by the script's own check, not a network failure (exit $rc)"

set +e
KG_SEARCH_API="http://127.0.0.1:$PORT" bash "$WORKDIR/kg-search.sh" search --q x --project y --k '3&project=*' \
  >/dev/null 2>/dev/null
rc=$?
set -e
[ "$rc" -ne 0 ]
check "$?" "F3: non-digit --k is rejected (exit $rc)"

# F1 MEDIUM (card 34c2d2a2, WhiteHat comment 24241): an unencoded "/" in the for-card ID let
# `for-card '../../memories'` resolve one directory level up from /api/kg/for-card/, reaching
# /api/memories with the Bearer token attached. Assert the server never saw that path.
: > "$PATH_LOG"
KG_SEARCH_API="http://127.0.0.1:$PORT" bash "$WORKDIR/kg-search.sh" for-card '../../memories' --json \
  >/dev/null 2>"$WORKDIR/f1id.err"
rc=$?
seen_path=$(cat "$PATH_LOG")
case "$seen_path" in
  *api/memories*) ok=1 ;;
  *) ok=0 ;;
esac
[ "$ok" = "0" ] && [ -n "$seen_path" ]
check "$?" "F1: for-card '../../memories' never reaches /api/memories (server saw: $seen_path)"

# F6 (card 34c2d2a2, WhiteHat comment 24241, since 409dded5): the default (non --json) human
# summary crashed with a Python SyntaxError on every real result -- backslash-escaped quotes
# inside an f-string's {} expression are invalid Python, {} braces or not.
set +e
out=$(KG_SEARCH_API="http://127.0.0.1:$PORT" bash "$WORKDIR/kg-search.sh" search --q prettytest --project x 2>"$WORKDIR/f6.err")
rc=$?
set -e
[ "$rc" = "0" ] && ! grep -qi "SyntaxError" "$WORKDIR/f6.err" && [ -n "$out" ]
check "$?" "F6: plain (non --json) output exits 0 with readable text, no SyntaxError (exit $rc)"

if [ "$FAILS" -gt 0 ]; then
  echo "$FAILS check(s) failed"
  exit 1
fi
echo "All $CHECKS checks pass."
