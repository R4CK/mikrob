#!/usr/bin/env bash
# Self-test for the push-time gate-DESIGNATION recheck wired into mopsion-land.sh (card acc197c8
# itself, sibling to the verdict recheck in mopsion-land-verdict-recheck.selftest.sh / card
# 517cbcbe). Runs the REAL mopsion-land.sh end to end against a minimal scratch repo, same fixture
# shape as its sibling selftest -- borrowed deliberately rather than re-invented.
#
# THE DIFFERENCE FROM THE SIBLING STUB: the verdict recheck reads /api/kanban/<card>/comments; the
# designation recheck reads /api/kanban (the bulk list, for labels + the card's Gate: line -- there
# is no single-card GET, same as every other designation reader on this board). The stub here is
# path-aware so it can hold the VERDICT stable (always a passing QA PASS) while flipping only the
# DESIGNATION between the first and second /api/kanban request -- otherwise the verdict recheck
# would refuse first and this test would never reach the code it exists to exercise.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAND="$HERE/mopsion-land.sh"
fail=0
n=0

WORK="$(mktemp -d)"
MAIN="$WORK/main"
git init -q -b main "$MAIN"
git -C "$MAIN" config user.email s@s
git -C "$MAIN" config user.name s
echo base > "$MAIN/notes.txt"
git -C "$MAIN" add "$MAIN/notes.txt"
git -C "$MAIN" commit -qm base

ORIGIN="$WORK/origin.git"
git init -q --bare -b main "$ORIGIN"
git -C "$MAIN" remote add origin "$ORIGIN"
git -C "$MAIN" push -q origin main

git -C "$MAIN" checkout -q -b work-branch
echo "work change" >> "$MAIN/notes.txt"
git -C "$MAIN" add "$MAIN/notes.txt"
git -C "$MAIN" commit -qm "the gated work"
SHA="$(git -C "$MAIN" rev-parse work-branch)"
git -C "$MAIN" checkout -q main

MODE_FILE="$WORK/mode.json"
echo '{"mode":"off"}' > "$MODE_FILE"
TOKEN_TMP="$WORK/token"; echo tok > "$TOKEN_TMP"

# A stub dashboard: /api/kanban/<card>/comments ALWAYS answers a passing QA verdict for $SHA (so
# the verdict recheck never refuses first); /api/kanban (bulk list) answers $1 (labels) for the
# FIRST request to that path and $2 for every request from $3 onward -- same flip-at contract as
# the sibling stub, scoped to the bulk path only.
stub_pid=""
stub_port=""
stub_up() { # $1 = labels-csv BEFORE, $2 = labels-csv AFTER, $3 = flip-at request number (to /api/kanban)
  local portfile="$WORK/stub.port"
  rm -f "$portfile"
  python3 - "$1" "$2" "$3" "$portfile" "$SHA" <<'PYSTUB' &
import http.server, json, sys
LABELS_BEFORE, LABELS_AFTER, FLIP_AT, PORTFILE, SHA = sys.argv[1:6]
FLIP_AT = int(FLIP_AT)
count = {"bulk": 0}

def card_doc(labels_csv):
    labels = [{"name": n} for n in labels_csv.split(",") if n]
    return [{"id": "card-x", "labels": labels, "description": ""}]

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.endswith("/comments"):
            body = {"comments": [{"author": "qa", "content": "QA PASS\nGate-SHA: " + SHA}]}
        else:
            count["bulk"] += 1
            labels = LABELS_BEFORE if count["bulk"] < FLIP_AT else LABELS_AFTER
            body = card_doc(labels)
        b = json.dumps(body).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
srv = http.server.HTTPServer(('127.0.0.1', 0), H)
with open(PORTFILE, 'w') as f:
    f.write(str(srv.server_address[1]))
srv.serve_forever()
PYSTUB
  stub_pid=$!
  stub_port=""
  local i
  for i in $(seq 1 200); do
    if [ -s "$portfile" ]; then stub_port="$(cat "$portfile")"; break; fi
    sleep 0.05
  done
  if [ -z "$stub_port" ]; then echo "  FAIL stub server never reported a port"; fail=1; fi
}
stub_down() { [ -n "$stub_pid" ] && kill "$stub_pid" 2>/dev/null; wait "$stub_pid" 2>/dev/null; stub_pid=""; }

OUT_FILE="$WORK/out.txt"
land() { # $1 = labels-before, $2 = labels-after, $3 = flip-at. Sets $rc; output in $OUT_FILE.
  stub_up "$1" "$2" "$3"
  GATE_CHECK_API="http://127.0.0.1:$stub_port" GATE_CHECK_TOKEN_FILE="$TOKEN_TMP" \
    CLEANCORE_MAIN="$MAIN" MOPSION_SUITE_EVIDENCE_MODE_FILE="$MODE_FILE" \
    timeout 40 bash "$LAND" card-x "$SHA" --dry-run --skip-typecheck --skip-bundle >"$OUT_FILE" 2>&1
  rc=$?
  stub_down
}

echo "mopsion-land.sh push-time designation recheck selftest (card acc197c8)"

n=$((n + 1))
land "qa,cybersec" "qa,cybersec" 999
if [ "$rc" = 0 ] && grep -q "DRY-RUN: not pushing" "$OUT_FILE"; then
  echo "  ok   a stable designation across both checks proceeds to the (dry-run) push"
else
  echo "  FAIL stable designation should proceed -> rc=$rc:"; tail -8 "$OUT_FILE" | sed 's/^/       /'
  fail=1
fi

n=$((n + 1))
land "qa,cybersec" "qa,cybersec,cybered" 2
if [ "$rc" = 3 ] && grep -q "gate designation changed" "$OUT_FILE"; then
  echo "  ok   designation WIDENING (2-gate -> 3-gate, the e792cfea shape) REFUSES at the recheck"
else
  echo "  FAIL a widening designation should refuse (rc 3, named) -> rc=$rc:"; tail -8 "$OUT_FILE" | sed 's/^/       /'
  fail=1
fi

n=$((n + 1))
if grep -q "was 'cybersec,qa,qa2', now 'cybered,cybersec,qa,qa2'" "$OUT_FILE"; then
  echo "  ok   the refusal names the OLD and NEW designation, not just that something changed"
else
  echo "  FAIL the refusal message did not name both designations as expected:"
  tail -8 "$OUT_FILE" | sed 's/^/       /'
  fail=1
fi

n=$((n + 1))
land "qa,cybersec,cybered" "qa,cybersec" 2
if [ "$rc" = 3 ] && grep -q "gate designation changed" "$OUT_FILE"; then
  echo "  ok   designation NARROWING also REFUSES -- the rule is symmetric, not just anti-widening"
else
  echo "  FAIL a narrowing designation should also refuse (rc 3, named) -> rc=$rc:"; tail -8 "$OUT_FILE" | sed 's/^/       /'
  fail=1
fi

rm -rf "$WORK"

echo ""
echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
