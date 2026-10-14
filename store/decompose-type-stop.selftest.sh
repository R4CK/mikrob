#!/usr/bin/env bash
# decompose-type-stop.selftest.sh -- unit tests for decompose-type-stop.sh (card d39fc5e7,
# requirement 3). Two layers:
#   1. The PURE --test threshold rule (no network) across the boundary cases.
#   2. An end-to-end pass against a throwaway Python stub HTTP server standing in for the
#      dashboard API, so the comment-scanning/aggregation logic is exercised exactly as the real
#      run exercises it, with a fixed, known fixture instead of the live board.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/decompose-type-stop.sh"
TMPDIR="$(mktemp -d)"

PASS=0
FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    echo "FAIL: $desc"
    echo "  want: $want"
    echo "  got:  $got"
  fi
}

# --- layer 1: pure threshold rule ----------------------------------------------------------------
check "below MIN_JUDGED (4 judged) -> KEEP even at 0% accept" "$(bash "$SCRIPT" --test 4 0)" "KEEP"
check "at MIN_JUDGED (5 judged), 1 accepted (20%) -> DISABLE" "$(bash "$SCRIPT" --test 5 1)" "DISABLE"
check "at MIN_JUDGED (5 judged), exactly 30% (rate not < 30) -> KEEP" "$(bash "$SCRIPT" --test 10 3)" "KEEP"
check "at MIN_JUDGED (5 judged), just under 30% (29%) -> DISABLE" "$(bash "$SCRIPT" --test 100 29)" "DISABLE"
check "well above MIN_JUDGED, 100% accept -> KEEP" "$(bash "$SCRIPT" --test 20 20)" "KEEP"
check "0 judged -> KEEP (no data, nothing to stop)" "$(bash "$SCRIPT" --test 0 0)" "KEEP"
check "custom thresholds (--min-judged 2 --min-accept-pct 50): 2 judged, 0 accepted -> DISABLE" \
  "$(bash "$SCRIPT" --min-judged 2 --min-accept-pct 50 --test 2 0)" "DISABLE"

# --- layer 2: end-to-end against a stub dashboard -------------------------------------------------
# One card per scenario (the script scans every card's comments independently, so one card per type
# keeps the fixture readable without needing cross-card aggregation logic in the stub).
STATE_FILE="$TMPDIR/decompose-type-disabled.json"
TOKEN_FILE="$TMPDIR/token"
echo "test-token" > "$TOKEN_FILE"

cat > "$TMPDIR/server.py" <<'PY'
import http.server, json, sys

CARDS = [{"id": "cardTS"}, {"id": "cardTD"}, {"id": "cardI18N"}, {"id": "cardDOC"}]

def draft(dtype, at):
    return {"author": "local-llm", "created_at": at,
            "content": f"[LOCAL-LLM DRAFT | dispatch-offload] #### Parent title — {dtype} (mechanikus reszfeladat, card 501c489f)\nsome draft body"}

def verdict(word, at):
    return {"author": "backend", "created_at": at, "content": f"Draft-Review: {word}\nrest of comment"}

now = 2_000_000_000
COMMENTS = {
    # test-scaffold: 6 judged (1 accept, 5 reject) -> rate 16% -> DISABLE (judged>=5)
    "cardTS": [
        draft("test-scaffold", now + 1), verdict("ELFOGADVA", now + 2),
        draft("test-scaffold", now + 3), verdict("ELUTASITVA", now + 4),
        draft("test-scaffold", now + 5), verdict("ELUTASITVA", now + 6),
        draft("test-scaffold", now + 7), verdict("ELUTASITVA", now + 8),
        draft("test-scaffold", now + 9), verdict("ELUTASITVA", now + 10),
        draft("test-scaffold", now + 11), verdict("ELUTASITVA", now + 12),
        # a FELESLEGES draft must NOT count toward judged at all (card 504ec76f: timing, not quality)
        draft("test-scaffold", now + 13), verdict("FELESLEGES", now + 14),
    ],
    # type-def: 4 judged (3 accept, 1 reject) -> rate 75%, but judged(4) < MIN_JUDGED(5) -> KEEP
    "cardTD": [
        draft("type-def", now + 1), verdict("ELFOGADVA", now + 2),
        draft("type-def", now + 3), verdict("ELFOGADVA", now + 4),
        draft("type-def", now + 5), verdict("RESZBEN", now + 6),
        draft("type-def", now + 7), verdict("ELUTASITVA", now + 8),
    ],
    # i18n-keys: 5 judged, 4 accepted -> rate 80% -> KEEP
    "cardI18N": [
        draft("i18n-keys", now + 1), verdict("ELFOGADVA", now + 2),
        draft("i18n-keys", now + 3), verdict("ELFOGADVA", now + 4),
        draft("i18n-keys", now + 5), verdict("ELFOGADVA", now + 6),
        draft("i18n-keys", now + 7), verdict("ELFOGADVA", now + 8),
        draft("i18n-keys", now + 9), verdict("ELUTASITVA", now + 10),
    ],
    # doc-update: no drafts at all -> 0 judged -> KEEP
    "cardDOC": [],
}

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/kanban":
            self._json(CARDS)
            return
        for cid, comments in COMMENTS.items():
            if self.path == f"/api/kanban/{cid}/comments":
                self._json(comments)
                return
        self._json([])

if __name__ == "__main__":
    port = int(sys.argv[1])
    srv = http.server.HTTPServer(("127.0.0.1", port), Handler)
    srv.serve_forever()  # blocks the main thread -- a daemon thread + stdin.readline() dies
                          # immediately when backgrounded non-interactively (stdin is EOF), which
                          # is exactly what made the first version of this fixture a silent no-op.
PY

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
python3 "$TMPDIR/server.py" "$PORT" &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$TMPDIR"; }
trap cleanup EXIT

# give the stub a moment to bind
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -s "http://127.0.0.1:$PORT/api/kanban" >/dev/null 2>&1 && break
  sleep 0.2
done

DASHBOARD_URL="http://127.0.0.1:$PORT" \
DECOMPOSE_STOP_TOKEN_FILE="$TOKEN_FILE" \
DECOMPOSE_STOP_STATE_FILE="$STATE_FILE" \
  bash "$SCRIPT" --days 3 >/dev/null 2>&1

check "state file was written" "$([ -f "$STATE_FILE" ] && echo yes || echo no)" "yes"

disabled_ts="$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['test-scaffold']['disabled'])")"
check "test-scaffold (6 judged, 16% accept) ends up DISABLED" "$disabled_ts" "True"

disabled_td="$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['type-def']['disabled'])")"
check "type-def (only 4 judged, below MIN_JUDGED) stays enabled despite the low raw rate" "$disabled_td" "False"

disabled_i18n="$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['i18n-keys']['disabled'])")"
check "i18n-keys (5 judged, 80% accept) stays enabled" "$disabled_i18n" "False"

judged_ts="$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['test-scaffold']['judged'])")"
check "test-scaffold judged count EXCLUDES the FELESLEGES draft (7 drafts posted, 6 judged)" "$judged_ts" "6"

disabled_doc="$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['doc-update']['disabled'])")"
check "doc-update (0 drafts) stays enabled" "$disabled_doc" "False"

# --- MUTATION: a later run with a recovered rate RE-ENABLES the type (full recompute, not sticky) -
cat > "$TMPDIR/server2.py" <<'PY'
import http.server, json, sys
CARDS = [{"id": "cardTS"}]
now = 2_000_000_000

def draft(dtype, at):
    return {"author": "local-llm", "created_at": at,
            "content": f"[LOCAL-LLM DRAFT | dispatch-offload] #### Parent title — {dtype} (mechanikus reszfeladat, card 501c489f)\nsome draft body"}

def verdict(word, at):
    return {"author": "backend", "created_at": at, "content": f"Draft-Review: {word}\nrest of comment"}

# recovered: 5 judged, all accepted -> 100%
COMMENTS = [
    draft("test-scaffold", now + 1), verdict("ELFOGADVA", now + 2),
    draft("test-scaffold", now + 3), verdict("ELFOGADVA", now + 4),
    draft("test-scaffold", now + 5), verdict("ELFOGADVA", now + 6),
    draft("test-scaffold", now + 7), verdict("ELFOGADVA", now + 8),
    draft("test-scaffold", now + 9), verdict("ELFOGADVA", now + 10),
]

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def _json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path == "/api/kanban":
            self._json(CARDS); return
        if self.path == "/api/kanban/cardTS/comments":
            self._json(COMMENTS); return
        self._json([])

if __name__ == "__main__":
    port = int(sys.argv[1])
    srv = http.server.HTTPServer(("127.0.0.1", port), Handler)
    srv.serve_forever()
PY
kill "$SERVER_PID" 2>/dev/null || true
PORT2="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
python3 "$TMPDIR/server2.py" "$PORT2" &
SERVER_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -s "http://127.0.0.1:$PORT2/api/kanban" >/dev/null 2>&1 && break
  sleep 0.2
done
DASHBOARD_URL="http://127.0.0.1:$PORT2" \
DECOMPOSE_STOP_TOKEN_FILE="$TOKEN_FILE" \
DECOMPOSE_STOP_STATE_FILE="$STATE_FILE" \
  bash "$SCRIPT" --days 3 >/dev/null 2>&1

disabled_ts_after="$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['test-scaffold']['disabled'])")"
check "MUTATION: a later run with a recovered 100% rate RE-ENABLES test-scaffold (full recompute, not sticky)" "$disabled_ts_after" "False"

# --- B2 fix: dashboard returning 401 JSON must NOT overwrite the state file ---------------
# Scenario: a previously-written state file has test-scaffold DISABLED.  The dashboard
# then returns a 401 JSON error on every card's comments endpoint.  The state file must
# be left untouched (md5 before == md5 after).  Before the B2 fix the file was reset with
# all types enabled because 0 judged / 0 accepted / API_FETCH_OK=0 still wrote the file.
kill "$SERVER_PID" 2>/dev/null || true
PORT3="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
# Stub: /api/kanban returns a valid list; /api/kanban/<id>/comments returns a 401 JSON object
cat > "$TMPDIR/server3.py" <<'PY'
import http.server, json, sys
CARDS = [{"id": "cardA"}]
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if self.path == "/api/kanban":
            self._send(200, CARDS)
        else:
            # 401 JSON error -- valid JSON, but NOT a list
            self._send(401, {"error": "Unauthorized", "message": "Token expired"})
if __name__ == "__main__":
    srv = http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler)
    srv.serve_forever()
PY
# Write a state file with test-scaffold DISABLED
python3 -c "
import json, time
state = {t: {'judged':6,'accepted':1,'disabled': t=='test-scaffold','updated_at':int(time.time())}
         for t in ['test-scaffold','i18n-keys','doc-update','type-def']}
with open('$STATE_FILE', 'w') as f: json.dump(state, f)
"
MD5_BEFORE="$(md5sum "$STATE_FILE" | cut -d' ' -f1)"
python3 "$TMPDIR/server3.py" "$PORT3" &
SERVER_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -s "http://127.0.0.1:$PORT3/api/kanban" >/dev/null 2>&1 && break
  sleep 0.2
done
DASHBOARD_URL="http://127.0.0.1:$PORT3" \
DECOMPOSE_STOP_TOKEN_FILE="$TOKEN_FILE" \
DECOMPOSE_STOP_STATE_FILE="$STATE_FILE" \
  bash "$SCRIPT" --days 3 >/dev/null 2>&1
MD5_AFTER="$(md5sum "$STATE_FILE" | cut -d' ' -f1)"
check "B2: 401-on-comments does not overwrite the state file (md5 unchanged)" "$MD5_BEFORE" "$MD5_AFTER"
disabled_ts_401="$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['test-scaffold']['disabled'])")"
check "B2: test-scaffold stays DISABLED after the 401-stub run" "$disabled_ts_401" "True"

echo
echo "decompose-type-stop.selftest: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
