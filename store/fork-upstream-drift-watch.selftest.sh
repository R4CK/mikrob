#!/usr/bin/env bash
# Wiring proof for the upstream-drift watcher (card a1ce8952, parent 1f276349).
#
# src/__tests__/fork-upstream-drift-watch.test.ts pins the DECISION offline. This file pins the
# part a pure function cannot: that the decision is actually reached from a command line, and that
# each branch produces the right HTTP writes -- none for the silent ones. A guard that is never
# called is a guard nobody has, so the wiring gets its own proof rather than being assumed
# (the same reason the cd-chain-guard and blast-radius-guard have wiring tests).
#
# Hermetic: a stub dashboard on an ephemeral port, canned DriftResults, a throwaway state file.
# No real upstream fetch, no real board.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WATCH="$ROOT/store/fork-upstream-drift-watch.mjs"
TMP="$(mktemp -d)"
trap 'kill "${STUB_PID:-0}" 2>/dev/null; rm -rf "$TMP"' EXIT

FAILURES=0
PASSES=0
check() { # check <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    PASSES=$((PASSES + 1))
    echo "  ok: $1"
  else
    echo "  FAIL: $1 -- expected [$2], got [$3]"
    FAILURES=$((FAILURES + 1))
  fi
}

[[ -f "$WATCH" ]] || { echo "FAIL: $WATCH is missing"; exit 1; }
if [[ ! -f "$ROOT/dist/fork-upstream/drift-watch.js" ]]; then
  # Loud, not skipped: an unbuilt dist means this selftest proved nothing, and a selftest that
  # quietly proves nothing is the failure mode it exists to catch.
  echo "FAIL: $ROOT/dist/fork-upstream/drift-watch.js is missing -- build first (npx tsc)"
  exit 1
fi

# ---- the stub dashboard ----------------------------------------------------------------------
cat > "$TMP/stub.py" <<'PYEOF'
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

BOARD = os.environ['STUB_BOARD']
LOG = os.environ['STUB_LOG']

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        with open(LOG, 'a') as f: f.write('GET %s\n' % self.path.split('?')[0])
        with open(BOARD) as f: self._send(200, json.load(f))

    def do_POST(self):
        n = int(self.headers.get('content-length') or 0)
        body = self.rfile.read(n).decode()
        with open(LOG, 'a') as f: f.write('POST %s %s\n' % (self.path, body.replace('\n', ' ')))
        self._send(200, {'ok': True, 'id': 'newcard1'})

srv = HTTPServer(('127.0.0.1', 0), H)
print(srv.server_port, flush=True)
srv.serve_forever()
PYEOF

echo '[]' > "$TMP/board.json"
: > "$TMP/log.txt"
export STUB_BOARD="$TMP/board.json" STUB_LOG="$TMP/log.txt"
python3 "$TMP/stub.py" > "$TMP/port.txt" &
STUB_PID=$!
for _ in $(seq 1 50); do [[ -s "$TMP/port.txt" ]] && break; sleep 0.1; done
PORT="$(cat "$TMP/port.txt")"
[[ -n "$PORT" ]] || { echo "FAIL: the stub dashboard did not start"; exit 1; }

printf 'stub-token\n' > "$TMP/token"
export MARVEEN_ROOT="$ROOT"
export MARVEEN_DASHBOARD_URL="http://127.0.0.1:$PORT"
export MARVEEN_TOKEN_FILE="$TMP/token"
export MARVEEN_DRIFT_STATE_FILE="$TMP/state.json"

# ---- canned drift results --------------------------------------------------------------------
cat > "$TMP/unreachable.json" <<'JEOF'
{"reachable": false, "guarded": [], "unwatched": [], "stale": [], "hunks": {}}
JEOF
cat > "$TMP/drift-a.json" <<'JEOF'
{"reachable": true, "guarded": [], "unwatched": [],
 "stale": [{"file": "web/app.js", "recorded": "aaaaaaaaaaaa", "actual": "bbbbbbbbbbbb", "rule": "union of both tails"}],
 "hunks": {}}
JEOF
cat > "$TMP/drift-b.json" <<'JEOF'
{"reachable": true, "guarded": [], "unwatched": ["src/db.ts"],
 "stale": [{"file": "web/app.js", "recorded": "aaaaaaaaaaaa", "actual": "cccccccccccc", "rule": "union of both tails"}],
 "hunks": {}}
JEOF
cat > "$TMP/clean.json" <<'JEOF'
{"reachable": true, "guarded": [], "unwatched": [], "stale": [], "hunks": {}}
JEOF

# grep -c exits 1 on zero matches, so a `|| echo 0` fallback would PRINT TWICE on the very case
# these checks care about most. awk always prints exactly one number.
posts() { awk '/^POST/{n++} END{print n+0}' "$TMP/log.txt"; }

run() { MARVEEN_DRIFT_JSON="$1" node "$WATCH" "${@:2}" 2>&1 | tail -1; }

# 1. an unreachable upstream is an environment fact: no card, and no memory of one
: > "$TMP/log.txt"; rm -f "$TMP/state.json"
check "unreachable stays silent" "SILENT:upstream-unreachable" "$(run "$TMP/unreachable.json")"
check "unreachable writes nothing to the board" "0" "$(posts)"
check "unreachable does NOT write the state file" "absent" "$([[ -f "$TMP/state.json" ]] && echo present || echo absent)"

# 2. first drift with an empty board opens exactly one card
: > "$TMP/log.txt"
check "first drift opens a card" "OPENED:newcard1" "$(run "$TMP/drift-a.json")"
check "exactly one board write" "1" "$(posts)"
check "the card is planned, not in_progress" "yes" "$(grep -q '"status":"planned"' "$TMP/log.txt" && echo yes || echo no)"
check "the card has an assignee (rule 6a)" "yes" "$(grep -qE '"assignee":"backend[23]?"' "$TMP/log.txt" && echo yes || echo no)"
check "the card carries a Gate: line" "yes" "$(grep -q 'Gate: QA + Cybersec' "$TMP/log.txt" && echo yes || echo no)"

# 2b. rule 6a's load balancing actually reads the board, instead of naming one sibling forever
cat > "$TMP/board.json" <<'JEOF'
[{"id": "x1", "title": "más kártya", "assignee": "backend", "created_at": 10},
 {"id": "x2", "title": "más kártya", "assignee": "backend", "created_at": 11},
 {"id": "x3", "title": "más kártya", "assignee": "backend2", "created_at": 12}]
JEOF
: > "$TMP/log.txt"; rm -f "$TMP/state.json"
run "$TMP/drift-a.json" > /dev/null
check "the least loaded BE sibling gets the card" "yes" "$(grep -q '\"assignee\":\"backend3\"' "$TMP/log.txt" && echo yes || echo no)"

# 3. THE POINT OF THE CARD: the same drift with the card open writes nothing at all
cat > "$TMP/board.json" <<'JEOF'
[{"id": "card0001", "title": "[UPSTREAM-DRIFT][marveen][INFRA][SEC] upstream-drift: 1 fájl", "created_at": 100, "assignee": "backend"}]
JEOF
: > "$TMP/log.txt"
check "unchanged drift stays silent" "SILENT:unchanged" "$(run "$TMP/drift-a.json")"
check "unchanged drift writes nothing" "0" "$(posts)"

# 4. a CHANGED drift comments on the existing card instead of opening a second one
: > "$TMP/log.txt"
check "changed drift comments" "COMMENTED:card0001" "$(run "$TMP/drift-b.json")"
check "one write, and it is a comment" "1" "$(posts)"
check "the comment went to the open card" "yes" "$(grep -q 'POST /api/kanban/card0001/comments' "$TMP/log.txt" && echo yes || echo no)"
check "no second card was opened" "no" "$(grep -q 'POST /api/kanban {' "$TMP/log.txt" && echo yes || echo no)"

# 5. THE DECOY: a card that only MENTIONS the marker is not the drift card
cat > "$TMP/board.json" <<'JEOF'
[{"id": "decoy001", "title": "[marveen][INFRA] figyelő, ami [UPSTREAM-DRIFT] kártyát nyit vagy frissít", "created_at": 50}]
JEOF
: > "$TMP/log.txt"; rm -f "$TMP/state.json"
check "a mentioning card is not commented on" "OPENED:newcard1" "$(run "$TMP/drift-a.json")"
check "nothing was posted to the decoy" "no" "$(grep -q 'decoy001' "$TMP/log.txt" && echo yes || echo no)"

# 6. a resolved drift reports itself once on the open card, and never closes it
cat > "$TMP/board.json" <<'JEOF'
[{"id": "card0001", "title": "[UPSTREAM-DRIFT][marveen][INFRA][SEC] upstream-drift: 1 fájl", "created_at": 100}]
JEOF
: > "$TMP/log.txt"
check "the resolution is reported" "COMMENTED:card0001" "$(run "$TMP/clean.json")"
check "the resolution is a comment, not a status write" "0" "$(grep -c 'POST /api/kanban/card0001/move' "$TMP/log.txt")"
: > "$TMP/log.txt"
check "the resolution is reported ONCE" "SILENT:clean-already-reported" "$(run "$TMP/clean.json")"
check "the second clean pass is quiet" "0" "$(posts)"

# 7. --report is read-only: no board traffic at all, not even the listing
: > "$TMP/log.txt"
MARVEEN_DRIFT_JSON="$TMP/drift-a.json" node "$WATCH" --report > "$TMP/report.txt" 2>&1
check "--report prints the drift report" "yes" "$(grep -q 'DRIFT' "$TMP/report.txt" && echo yes || echo no)"
check "--report touches the board zero times" "0" "$(wc -l < "$TMP/log.txt" | tr -d ' ')"

# 8. a missing token is an error, not a silent no-op
: > "$TMP/log.txt"
check "missing token reports" "ERROR:no-token-file" "$(MARVEEN_TOKEN_FILE=/nonexistent/token MARVEEN_DRIFT_JSON="$TMP/drift-a.json" node "$WATCH" 2>&1 | tail -1)"

# The count is not decoration: store-selftests-all-run.test.ts only accepts a summary carrying a
# NON-ZERO number, because a selftest whose loop never entered prints a perfectly happy summary
# over nothing. Reported in an existing recognised shape rather than teaching that file a fourth.
if [[ "$FAILURES" -eq 0 ]]; then
  echo "fork-upstream-drift-watch.selftest: $PASSES passed, 0 failed"
  exit 0
fi
echo "fork-upstream-drift-watch.selftest: $PASSES passed, $FAILURES failed"
exit 1
