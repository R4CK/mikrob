#!/usr/bin/env bash
# Self-test for marveen-land.sh's `--card <id> --agent <agent>` mode (card cd3e577b, F1 of the
# b8ac0ef1 "software factory" phase). Runs the REAL marveen-land.sh end to end against a throwaway
# repo -- same fixture shape as mopsion-land-designation-recheck.selftest.sh.
#
# Exercises the card's own acceptance criterion (6): "two cards in parallel, the landing only
# carries its own card's files" -- by giving TWO card branches real, distinct content and checking
# that landing ONE never lands the OTHER's file. Also checks the automated Gate-SHA post (via a
# stub dashboard capturing the real HTTP request) names the card that was actually landed, not
# whichever card happens to be the agent's current in_progress one (kanban_comment_on, not
# kanban_comment -- see the comment in land_one).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAND="$HERE/marveen-land.sh"
fail=0
n=0

WORK="$(mktemp -d)"
MAIN="$WORK/main"
git init -q -b develop "$MAIN"
git -C "$MAIN" config user.email s@s
git -C "$MAIN" config user.name s
mkdir -p "$MAIN/store"
echo base > "$MAIN/notes.txt"
git -C "$MAIN" add .
git -C "$MAIN" commit -qm base

ORIGIN="$WORK/origin.git"
git init -q --bare -b develop "$ORIGIN"
git -C "$MAIN" remote add origin "$ORIGIN"
git -C "$MAIN" push -q origin develop
git -C "$MAIN" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/develop

# Two independent card branches, each adding a FILE OF ITS OWN -- the simplest observable proxy for
# "carries only its own card's work".
git -C "$MAIN" checkout -q -b card/aaa111 develop
echo "aaa111 content" > "$MAIN/aaa111.txt"
git -C "$MAIN" add aaa111.txt
git -C "$MAIN" commit -qm "card aaa111: add aaa111.txt"
git -C "$MAIN" checkout -q develop

git -C "$MAIN" checkout -q -b card/bbb222 develop
echo "bbb222 content" > "$MAIN/bbb222.txt"
git -C "$MAIN" add bbb222.txt
git -C "$MAIN" commit -qm "card bbb222: add bbb222.txt"
git -C "$MAIN" checkout -q develop

# card cd3e577b R1: gate_verdict_check reads the sha being landed BEFORE the merge (the card
# branch's own tip), so it is knowable up front -- not the merge commit the lander produces.
SHA_AAA111="$(git -C "$MAIN" rev-parse card/aaa111)"
SHA_BBB222="$(git -C "$MAIN" rev-parse card/bbb222)"

LOCK_DIR="$WORK/store"; mkdir -p "$LOCK_DIR"
TOKEN_TMP="$WORK/token"; echo tok > "$TOKEN_TMP"

# Stub dashboard: /api/kanban/<card>/comments captures every POST body into a file named after the
# card id, so the test can tell exactly which card a Gate-SHA comment landed on. GET on the same
# path serves a fixture file ($GET_DIR/<card>.json), or an empty list if none was placed -- this is
# what gate_verdict_check (card cd3e577b R1) reads to decide whether a --card landing may proceed.
CAPTURE_DIR="$WORK/captured"; mkdir -p "$CAPTURE_DIR"
GET_DIR="$WORK/get-fixtures"; mkdir -p "$GET_DIR"
# card cd3e577b, MikroB decisions 16324/16402: card_designated_gates_agree reads the card's
# description "Gate:" line(s) off the BULK /api/kanban listing (same shape mopsion-land.sh's
# _gate_designation_snapshot already reads in production, minus the labels source -- N1 (16402)
# dropped that one), not the per-card endpoint above. Defaults to "[]"; set_gate_line() below
# registers each test card with a real (possibly empty) description before it lands, since N1
# made BOTH "card absent from the board" and "no interpretable Gate: line" refuse (rc 1,
# overridable) rather than pass through as "nothing extra to require".
BULK_FILE="$WORK/kanban-bulk.json"; echo '[]' > "$BULK_FILE"
set_gate_line() { # $1 = card id, $2 = the text after "Gate:" in the card's description
  python3 -c "
import json
cid, line = '$1', '''$2'''
with open('$BULK_FILE') as f:
    cards = json.load(f)
cards = [c for c in cards if c.get('id') != cid]
cards.append({'id': cid, 'description': 'Gate: ' + line, 'labels': []})
with open('$BULK_FILE', 'w') as f:
    json.dump(cards, f)
"
}
stub_pid=""
stub_up() {
  local portfile="$WORK/stub.port"
  rm -f "$portfile"
  python3 - "$CAPTURE_DIR" "$portfile" "$GET_DIR" "$BULK_FILE" <<'PYSTUB' &
import http.server, json, sys, re, os
CAPTURE_DIR, PORTFILE, GET_DIR, BULK_FILE = sys.argv[1:5]

class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        m = re.search(r'/api/kanban/([^/]+)/comments', self.path)
        if m:
            with open(f"{CAPTURE_DIR}/{m.group(1)}.ndjson", "a") as f:
                f.write(body.decode() + "\n")
        resp = json.dumps({"ok": True}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(resp)))
        self.end_headers(); self.wfile.write(resp)
    def do_GET(self):
        resp = b"[]"
        if self.path.rstrip('/') == '/api/kanban':
            if os.path.isfile(BULK_FILE):
                with open(BULK_FILE, "rb") as f:
                    resp = f.read()
        else:
            m = re.search(r'/api/kanban/([^/]+)/comments', self.path)
            if m:
                fp = os.path.join(GET_DIR, f"{m.group(1)}.json")
                if os.path.isfile(fp):
                    with open(fp, "rb") as f:
                        resp = f.read()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(resp)))
        self.end_headers(); self.wfile.write(resp)
    def log_message(self, *a): pass

srv = http.server.HTTPServer(('127.0.0.1', 0), H)
with open(PORTFILE, 'w') as f:
    f.write(str(srv.server_address[1]))
srv.serve_forever()
PYSTUB
  stub_pid=$!
  local portfile="$WORK/stub.port" i
  for i in $(seq 1 200); do
    if [ -s "$portfile" ]; then stub_port="$(cat "$portfile")"; break; fi
    sleep 0.05
  done
  [ -n "${stub_port:-}" ] || { echo "  FAIL stub server never reported a port"; fail=1; }
}
stub_down() { [ -n "$stub_pid" ] && kill "$stub_pid" 2>/dev/null; wait "$stub_pid" 2>/dev/null; stub_pid=""; }

stub_up
trap stub_down EXIT

# Register the pre-existing test cards up front, so card_designated_gates_agree's new check (card
# cd3e577b, MikroB decisions 16324/16402) finds them on the board instead of "card not found" --
# a fail-closed refusal that would otherwise sink every test below that never cared about a
# designated-gate set at all. aaa111/bbb222 land WITHOUT --allow-ungated further down, so (N1,
# 16402: an empty/uninterpretable "Gate:" line now REFUSES rather than passing through) they get a
# real, satisfiable "Gate: QA" designation matching their existing QA PASS fixture. ccc333/ddd444
# are only ever landed via gate_verdict_check's OWN missing/failing-verdict paths (which refuse
# before card_designated_gates_agree is even reached, or via --allow-ungated), so an empty clause
# is still fine for them and keeps those two cases about what they were built to test.
set_gate_line aaa111 "QA"
set_gate_line bbb222 "QA"
for c in ccc333 ddd444; do set_gate_line "$c" ""; done

OUT_FILE="$WORK/out.txt"
land_card() { # $1 = card id, $2 = agent, extra args passed through
  local card="$1" agent="$2"; shift 2
  MARVEEN_MAIN="$MAIN" \
    MARVEEN_LAND_TEST="true" MARVEEN_LAND_BUILD="true" \
    MARVEEN_LAND_DEVELOP_LOCK_FILE="$LOCK_DIR/.marveen-land-develop.lock" \
    KANBAN_COMMENT_API="http://127.0.0.1:$stub_port" KANBAN_COMMENT_TOKEN_FILE="$TOKEN_TMP" \
    GATE_CHECK_API="http://127.0.0.1:$stub_port" GATE_CHECK_TOKEN_FILE="$TOKEN_TMP" \
    timeout 30 bash "$LAND" --card "$card" --agent "$agent" "$@" >"$OUT_FILE" 2>&1
  rc=$?
}

# card cd3e577b R1 (MikroB decision 16277): writes a GET fixture for card <id>'s /comments so
# gate_verdict_check (refuse mode, now the --card default) sees a verdict. $2 = QA PASS author, or
# omit for no fixture at all (NONE).
set_verdict() { # $1 = card id, $2 = "pass"|"fail"|none (default: remove fixture)
  local card="$1" kind="${2:-}"
  case "$kind" in
    pass) printf '[{"author":"qa","content":"QA PASS\\nGate-SHA: %s"}]' "$3" > "$GET_DIR/$card.json" ;;
    fail) printf '[{"author":"qa","content":"QA FAIL\\nGate-SHA: %s"}]' "$3" > "$GET_DIR/$card.json" ;;
    *) rm -f "$GET_DIR/$card.json" ;;
  esac
}

echo "marveen-land.sh --card <id> --agent <agent> selftest (card cd3e577b)"

# card cd3e577b R1: --card mode defaults to refuse-mode gate_verdict_check, so these mechanics
# tests need a passing QA verdict on the sha being landed, same as a real gated card would carry.
set_verdict aaa111 pass "$SHA_AAA111"

n=$((n + 1))
land_card aaa111 backend --dry-run
if [ "$rc" = 0 ] && grep -q "DRY-RUN -- not pushing" "$OUT_FILE"; then
  echo "  ok   --card --dry-run merges+tests but does not push"
else
  echo "  FAIL --card --dry-run should succeed without pushing -> rc=$rc:"; tail -15 "$OUT_FILE" | sed 's/^/       /'
  fail=1
fi

n=$((n + 1))
if ! git -C "$MAIN" merge-base --is-ancestor card/aaa111 origin/develop 2>/dev/null; then
  echo "  ok   a --dry-run landing left card/aaa111 unmerged into origin/develop"
else
  echo "  FAIL --dry-run should not have pushed anything"; fail=1
fi

n=$((n + 1))
land_card aaa111 backend
if [ "$rc" = 0 ] && grep -q "LANDED card/aaa111 -> origin/develop" "$OUT_FILE"; then
  echo "  ok   a real --card landing pushes to origin/develop"
else
  echo "  FAIL --card landing should succeed -> rc=$rc:"; tail -15 "$OUT_FILE" | sed 's/^/       /'
  fail=1
fi

n=$((n + 1))
git -C "$MAIN" fetch -q origin develop
if git -C "$MAIN" cat-file -e "origin/develop:aaa111.txt" 2>/dev/null \
   && ! git -C "$MAIN" cat-file -e "origin/develop:bbb222.txt" 2>/dev/null; then
  echo "  ok   landing card/aaa111 carried its OWN file onto develop, and NOT card/bbb222's file (acceptance criterion 6)"
else
  echo "  FAIL expected aaa111.txt present, bbb222.txt absent on origin/develop after landing only aaa111"
  fail=1
fi

n=$((n + 1))
if git -C "$MAIN" show-ref --verify --quiet refs/heads/card/aaa111; then
  echo "  ok   the landed card branch itself still exists (cleanup is a separate, later step -- req. 5)"
else
  echo "  FAIL card/aaa111 branch should still exist after landing"; fail=1
fi

n=$((n + 1))
gate_sha_lines="$(grep -c '^Gate-SHA:' "$OUT_FILE" || true)"
if [ "$gate_sha_lines" -ge 1 ]; then
  echo "  ok   the landing printed a Gate-SHA line"
else
  echo "  FAIL expected a printed Gate-SHA line"; fail=1
fi

n=$((n + 1))
# B1 (RedHat NO-GO 16276): the auto-posted comment must NOT use a "Gate-SHA:" line -- that is the
# keyword gate-closure-check.py reads as a freshly-declared, unverdicted sha, which drops a
# successful --card landing's own card to STALE. "Merge-SHA:" is not that keyword.
if [ -f "$CAPTURE_DIR/aaa111.ndjson" ] && grep -q "Merge-SHA:" "$CAPTURE_DIR/aaa111.ndjson" \
   && ! grep -q "^Gate-SHA:" "$CAPTURE_DIR/aaa111.ndjson"; then
  echo "  ok   the automated post-landing comment names the merge sha as Merge-SHA:, not Gate-SHA: (B1)"
else
  echo "  FAIL expected a Merge-SHA: (not Gate-SHA:) comment captured for card aaa111"; fail=1
fi

n=$((n + 1))
if [ ! -f "$CAPTURE_DIR/bbb222.ndjson" ]; then
  echo "  ok   NO Gate-SHA comment was posted to the other, still-unlanded card (bbb222)"
else
  echo "  FAIL card bbb222 should not have received any comment from landing aaa111"; fail=1
fi

set_verdict bbb222 pass "$SHA_BBB222"

n=$((n + 1))
land_card bbb222 backend2
if [ "$rc" = 0 ] && grep -q "LANDED card/bbb222 -> origin/develop" "$OUT_FILE"; then
  echo "  ok   a second, independent card lands cleanly after the first (no cross-contamination)"
else
  echo "  FAIL landing the second card should also succeed -> rc=$rc:"; tail -15 "$OUT_FILE" | sed 's/^/       /'
  fail=1
fi

n=$((n + 1))
git -C "$MAIN" fetch -q origin develop
if git -C "$MAIN" cat-file -e "origin/develop:aaa111.txt" 2>/dev/null \
   && git -C "$MAIN" cat-file -e "origin/develop:bbb222.txt" 2>/dev/null; then
  echo "  ok   after landing both cards, develop carries both files"
else
  echo "  FAIL expected both aaa111.txt and bbb222.txt on origin/develop after both cards landed"
  fail=1
fi

n=$((n + 1))
if [ -f "$CAPTURE_DIR/bbb222.ndjson" ] && grep -q "Merge-SHA:" "$CAPTURE_DIR/bbb222.ndjson" \
   && ! grep -q "^Gate-SHA:" "$CAPTURE_DIR/bbb222.ndjson"; then
  echo "  ok   the second landing posted ITS Merge-SHA to bbb222, not to aaa111 (B1)"
else
  echo "  FAIL expected an automated Merge-SHA comment captured for card bbb222"; fail=1
fi

n=$((n + 1))
out="$(MARVEEN_MAIN="$MAIN" bash "$LAND" --card 2>&1)"; rc=$?
if [ "$rc" = 2 ] && printf '%s' "$out" | grep -q "needs a card id"; then
  echo "  ok   --card with no id is refused (exit 2)"
else
  echo "  FAIL --card with no id should be refused -> rc=$rc: $out"; fail=1
fi

n=$((n + 1))
out="$(MARVEEN_MAIN="$MAIN" bash "$LAND" --card aaa111 2>&1)"; rc=$?
if [ "$rc" = 2 ] && printf '%s' "$out" | grep -q "requires --agent"; then
  echo "  ok   --card without --agent is refused (exit 2)"
else
  echo "  FAIL --card without --agent should be refused -> rc=$rc: $out"; fail=1
fi

n=$((n + 1))
out="$(MARVEEN_MAIN="$MAIN" bash "$LAND" --card BADID --agent backend 2>&1)"; rc=$?
if [ "$rc" = 2 ] && printf '%s' "$out" | grep -q "card id must be hex"; then
  echo "  ok   --card with a non-hex id is refused (exit 2)"
else
  echo "  FAIL --card BADID should be refused -> rc=$rc: $out"; fail=1
fi

# R1 (MikroB decision 16277): a --card landing with NO gate verdict at all must be REFUSED by
# default, and tolerated only with --allow-ungated.
git -C "$MAIN" checkout -q -b card/ccc333 develop
echo "ccc333 content" > "$MAIN/ccc333.txt"
git -C "$MAIN" add ccc333.txt
git -C "$MAIN" -c user.email=s@s -c user.name=s commit -qm "card ccc333: add ccc333.txt"
git -C "$MAIN" checkout -q develop
set_verdict ccc333 none

n=$((n + 1))
land_card ccc333 backend3
if [ "$rc" != 0 ] && grep -q "no passing gate verdict" "$OUT_FILE"; then
  echo "  ok   --card REFUSES to land with no gate verdict at all (R1)"
else
  echo "  FAIL expected a refusal for an ungated card -> rc=$rc:"; tail -15 "$OUT_FILE" | sed 's/^/       /'; fail=1
fi

n=$((n + 1))
if ! git -C "$MAIN" merge-base --is-ancestor card/ccc333 origin/develop 2>/dev/null; then
  echo "  ok   the refused ungated landing pushed nothing"
else
  echo "  FAIL an R1-refused landing should not have pushed anything"; fail=1
fi

n=$((n + 1))
land_card ccc333 backend3 --allow-ungated
if [ "$rc" = 0 ] && grep -q "LANDED card/ccc333 -> origin/develop" "$OUT_FILE"; then
  echo "  ok   --allow-ungated tolerates the missing verdict and lands anyway (R1 override)"
else
  echo "  FAIL --allow-ungated should have let ccc333 land -> rc=$rc:"; tail -15 "$OUT_FILE" | sed 's/^/       /'; fail=1
fi

# A FAILING verdict is never overridden by --allow-ungated, same as cleancore-land.sh.
git -C "$MAIN" checkout -q -b card/ddd444 develop
echo "ddd444 content" > "$MAIN/ddd444.txt"
git -C "$MAIN" add ddd444.txt
git -C "$MAIN" -c user.email=s@s -c user.name=s commit -qm "card ddd444: add ddd444.txt"
git -C "$MAIN" checkout -q develop
SHA_DDD444="$(git -C "$MAIN" rev-parse card/ddd444)"
set_verdict ddd444 fail "$SHA_DDD444"

n=$((n + 1))
land_card ddd444 backend3 --allow-ungated
if [ "$rc" != 0 ] && grep -q "FAILING gate verdict" "$OUT_FILE"; then
  echo "  ok   a FAILING verdict refuses even with --allow-ungated (never overridden)"
else
  echo "  FAIL a FAILING verdict should refuse regardless of --allow-ungated -> rc=$rc:"; tail -15 "$OUT_FILE" | sed 's/^/       /'; fail=1
fi

# B1, confirmed against the REAL gate-closure-check.py: a REVIEW + QA PASS + the auto-posted
# post-landing comment must still read AGREE for the gated sha, not STALE.
n=$((n + 1))
closure_comments="$(python3 -c "
import json
base = [
    {'author': 'fullstack', 'content': 'REVIEW: ready\nGate-SHA: $SHA_AAA111'},
    {'author': 'qa', 'content': 'QA PASS\nGate-SHA: $SHA_AAA111'},
]
with open('$CAPTURE_DIR/aaa111.ndjson') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        c = json.loads(line)
        base.append({'author': c.get('author', 'fullstack'), 'content': c.get('content', '')})
print(json.dumps(base))
")"
# --no-landed: this is a scratch repo the real tool's hardcoded MARVEEN_MAIN clone knows nothing
# about, and landedness is not what B1 is about -- RedHat's own measurement used the same flag.
closure_verdict="$(printf '%s' "$closure_comments" | python3 "$HERE/gate-closure-check.py" qa --expect "$SHA_AAA111" --no-landed)"
if printf '%s' "$closure_verdict" | grep -q "^AGREE"; then
  echo "  ok   gate-closure-check.py still gives AGREE after the auto-posted comment (B1): $closure_verdict"
else
  echo "  FAIL expected AGREE from gate-closure-check.py, got: $closure_verdict"; fail=1
fi

# card cd3e577b, MikroB decision 16324 (RedHat NO-GO 16322, finding B1): QA-mandatory alone must
# not be enough -- a card designating "QA + RedHat" with a FRESH QA PASS but only an OLD RedHat
# NO-GO (naming a sha that is not the one being landed) must still REFUSE.
git -C "$MAIN" checkout -q -b card/eee555 develop
echo "eee555 content" > "$MAIN/eee555.txt"
git -C "$MAIN" add eee555.txt
git -C "$MAIN" -c user.email=s@s -c user.name=s commit -qm "card eee555: add eee555.txt"
git -C "$MAIN" checkout -q develop
SHA_EEE555="$(git -C "$MAIN" rev-parse card/eee555)"
set_gate_line eee555 "QA + RedHat (trust boundary)"
printf '[{"author":"qa","content":"QA PASS\\nGate-SHA: %s"},{"author":"cybered","content":"CYBERED NO-GO\\nGate-SHA: 0000000deadbeef"}]' \
  "$SHA_EEE555" > "$GET_DIR/eee555.json"

n=$((n + 1))
land_card eee555 backend3
if [ "$rc" != 0 ] && grep -q "card eee555's designated gates" "$OUT_FILE"; then
  echo "  ok   a fresh QA PASS does not land a card whose designated RedHat gate only NO-GO'd an OLDER sha (B1)"
else
  echo "  FAIL expected a designated-gate refusal -> rc=$rc:"; tail -15 "$OUT_FILE" | sed 's/^/       /'; fail=1
fi

n=$((n + 1))
if ! git -C "$MAIN" merge-base --is-ancestor card/eee555 origin/develop 2>/dev/null; then
  echo "  ok   the B1-refused landing pushed nothing"
else
  echo "  FAIL a B1-refused landing should not have pushed anything"; fail=1
fi

# Now RedHat re-gates the ACTUAL sha with a GO: both designated gates agree, so the same card lands.
printf '[{"author":"qa","content":"QA PASS\\nGate-SHA: %s"},{"author":"cybered","content":"CYBERED GO\\nGate-SHA: %s"}]' \
  "$SHA_EEE555" "$SHA_EEE555" > "$GET_DIR/eee555.json"

n=$((n + 1))
land_card eee555 backend3
if [ "$rc" = 0 ] && grep -q "LANDED card/eee555 -> origin/develop" "$OUT_FILE"; then
  echo "  ok   a fresh QA PASS + a fresh RedHat GO on the SAME sha lands cleanly (B1 fixed)"
else
  echo "  FAIL expected eee555 to land once both designated gates agree -> rc=$rc:"; tail -15 "$OUT_FILE" | sed 's/^/       /'; fail=1
fi

# card cd3e577b, MikroB decision 16402 (RedHat NO-GO 16401, finding N1): the designated-gate set
# is now the UNION of EVERY "Gate:" line in the description, labels no longer count at all, and a
# card with no interpretable "Gate:" line refuses instead of passing through.
set_card_desc() { # $1 = card id, $2 = full description text, $3 = CSV of @-prefixed label names (optional)
  python3 -c "
import json
cid, desc, labels_csv = '$1', '''$2''', '''${3:-}'''
with open('$BULK_FILE') as f:
    cards = json.load(f)
cards = [c for c in cards if c.get('id') != cid]
labels = [{'name': n} for n in labels_csv.split(',') if n]
cards.append({'id': cid, 'description': desc, 'labels': labels})
with open('$BULK_FILE', 'w') as f:
    json.dump(cards, f)
"
}

# N1a: no interpretable "Gate:" line at all -- refuses without --allow-ungated, lands with it.
git -C "$MAIN" checkout -q -b card/fff666 develop
echo "fff666 content" > "$MAIN/fff666.txt"
git -C "$MAIN" add fff666.txt
git -C "$MAIN" -c user.email=s@s -c user.name=s commit -qm "card fff666: add fff666.txt"
git -C "$MAIN" checkout -q develop
SHA_FFF666="$(git -C "$MAIN" rev-parse card/fff666)"
set_card_desc fff666 "no Gate line here at all"
set_verdict fff666 pass "$SHA_FFF666"

n=$((n + 1))
land_card fff666 backend3
if [ "$rc" != 0 ] && grep -q "no interpretable 'Gate:' line" "$OUT_FILE"; then
  echo "  ok   a QA PASS alone does not land a card with no interpretable Gate: line (N1)"
else
  echo "  FAIL expected a no-interpretable-Gate-line refusal -> rc=$rc:"; tail -15 "$OUT_FILE" | sed 's/^/       /'; fail=1
fi

n=$((n + 1))
land_card fff666 backend3 --allow-ungated
if [ "$rc" = 0 ] && grep -q "LANDED card/fff666 -> origin/develop" "$OUT_FILE"; then
  echo "  ok   --allow-ungated tolerates the no-interpretable-Gate-line case and lands anyway (N1)"
else
  echo "  FAIL --allow-ungated should have let fff666 land -> rc=$rc:"; tail -15 "$OUT_FILE" | sed 's/^/       /'; fail=1
fi

n=$((n + 1))
if [ -f "$CAPTURE_DIR/fff666.ndjson" ] && grep -q "UNGATED LANDING" "$CAPTURE_DIR/fff666.ndjson" \
   && grep -q "Designated: nincs kijelolve" "$CAPTURE_DIR/fff666.ndjson"; then
  echo "  ok   the landing comment names the actual (empty) designation it checked, and the ungated note landed too (N1+N2)"
else
  echo "  FAIL expected an UNGATED LANDING comment + Designated: line for fff666"; fail=1
fi

# N1b: the designated set is the UNION of every "Gate:" line, not just the last one -- a card that
# grew a second Gate: line in a later delta round still requires BOTH.
git -C "$MAIN" checkout -q -b card/bad777 develop
echo "bad777 content" > "$MAIN/bad777.txt"
git -C "$MAIN" add bad777.txt
git -C "$MAIN" -c user.email=s@s -c user.name=s commit -qm "card bad777: add bad777.txt"
git -C "$MAIN" checkout -q develop
SHA_GGG777="$(git -C "$MAIN" rev-parse card/bad777)"
set_card_desc bad777 "First delta round.
Gate: QA

Second delta round, a new finding needs a security gate too.
Gate: RedHat (trust boundary)"
printf '[{"author":"qa","content":"QA PASS\\nGate-SHA: %s"}]' "$SHA_GGG777" > "$GET_DIR/bad777.json"

n=$((n + 1))
land_card bad777 backend3
if [ "$rc" != 0 ] && grep -q "card bad777's designated gates" "$OUT_FILE"; then
  echo "  ok   a QA PASS alone does not land a card whose SECOND Gate: line also designates RedHat (N1, union)"
else
  echo "  FAIL expected a designated-gate refusal (union includes the second Gate: line) -> rc=$rc:"; tail -15 "$OUT_FILE" | sed 's/^/       /'; fail=1
fi

printf '[{"author":"qa","content":"QA PASS\\nGate-SHA: %s"},{"author":"cybered","content":"CYBERED GO\\nGate-SHA: %s"}]' \
  "$SHA_GGG777" "$SHA_GGG777" > "$GET_DIR/bad777.json"

n=$((n + 1))
land_card bad777 backend3
if [ "$rc" = 0 ] && grep -q "LANDED card/bad777 -> origin/develop" "$OUT_FILE"; then
  echo "  ok   QA PASS + RedHat GO (the union of both Gate: lines) lands cleanly (N1, union)"
else
  echo "  FAIL expected bad777 to land once both unioned gates agree -> rc=$rc:"; tail -15 "$OUT_FILE" | sed 's/^/       /'; fail=1
fi

# N1c: a label alone, with no "Gate:" line in the description, no longer counts as designation --
# "A @qa cimke nem kijeloles" (MikroB 16402). A QA PASS verdict exists, but with no interpretable
# Gate: line the landing must still refuse without --allow-ungated.
git -C "$MAIN" checkout -q -b card/dead88 develop
echo "dead88 content" > "$MAIN/dead88.txt"
git -C "$MAIN" add dead88.txt
git -C "$MAIN" -c user.email=s@s -c user.name=s commit -qm "card dead88: add dead88.txt"
git -C "$MAIN" checkout -q develop
SHA_HHH888="$(git -C "$MAIN" rev-parse card/dead88)"
set_card_desc dead88 "no Gate line, only a label" "@qa"
set_verdict dead88 pass "$SHA_HHH888"

n=$((n + 1))
land_card dead88 backend3
if [ "$rc" != 0 ] && grep -q "no interpretable 'Gate:' line" "$OUT_FILE"; then
  echo "  ok   a @qa LABEL alone (no Gate: line) does not designate -- still refuses (N1c)"
else
  echo "  FAIL expected the label-only card to refuse as no-interpretable-Gate-line -> rc=$rc:"; tail -15 "$OUT_FILE" | sed 's/^/       /'; fail=1
fi

# N-a (RedHat NO-GO 16486, measured tool gap): the union must be read from EVERY "Gate:" line, not
# just the LAST one -- bad777/N1b above only grows the designation (QA, then QA+RedHat), so a
# last-line-only mutant happens to refuse there too and the gap goes uncaught. Here the order is
# REVERSED: the first round designates "QA + RedHat", a later round's line narrows the TEXT to just
# "Gate: QA" -- the union must still require RedHat (a card cannot un-designate a gate by writing a
# weaker line later), while a last-line-only reader would wrongly settle for QA alone.
git -C "$MAIN" checkout -q -b card/cafe66 develop
echo "cafe66 content" > "$MAIN/cafe66.txt"
git -C "$MAIN" add cafe66.txt
git -C "$MAIN" -c user.email=s@s -c user.name=s commit -qm "card cafe66: add cafe66.txt"
git -C "$MAIN" checkout -q develop
SHA_CAFE66="$(git -C "$MAIN" rev-parse card/cafe66)"
set_card_desc cafe66 "First round, high risk.
Gate: QA + RedHat

Second round, text narrowed by mistake -- the union must not shrink.
Gate: QA"
printf '[{"author":"qa","content":"QA PASS\\nGate-SHA: %s"}]' "$SHA_CAFE66" > "$GET_DIR/cafe66.json"

n=$((n + 1))
land_card cafe66 backend3
if [ "$rc" != 0 ] && grep -q "card cafe66's designated gates" "$OUT_FILE"; then
  echo "  ok   a QA PASS alone does not land cafe66 even though its LAST Gate: line only says QA (N-a, union over last-line)"
else
  echo "  FAIL expected cafe66 to refuse on the union (RedHat still required from the first Gate: line) -> rc=$rc:"; tail -15 "$OUT_FILE" | sed 's/^/       /'; fail=1
fi

printf '[{"author":"qa","content":"QA PASS\\nGate-SHA: %s"},{"author":"cybered","content":"CYBERED GO\\nGate-SHA: %s"}]' \
  "$SHA_CAFE66" "$SHA_CAFE66" > "$GET_DIR/cafe66.json"

n=$((n + 1))
land_card cafe66 backend3
if [ "$rc" = 0 ] && grep -q "LANDED card/cafe66 -> origin/develop" "$OUT_FILE"; then
  echo "  ok   QA PASS + RedHat GO (the union of both Gate: lines) lands cafe66 cleanly (N-a)"
else
  echo "  FAIL expected cafe66 to land once both unioned gates agree -> rc=$rc:"; tail -15 "$OUT_FILE" | sed 's/^/       /'; fail=1
fi

# Card 3731c807 (U4, RedHat 16520): fff666 above already pins the EMPTY "Designated: nincs
# kijelolve" case, but nothing pinned the NON-EMPTY case -- a bug that dropped the real CSV before
# it reached the comment (e.g. always printing the fallback) would still read "Designated:
# <something>" and every existing grep for "Designated:" alone would stay green. cafe66 just landed
# with a real union (QA + RedHat), so its own LANDED comment must carry that exact, non-empty CSV
# (gate_designation.py sorts it: cybered,qa,qa2), not the "nincs kijelolve" fallback.
n=$((n + 1))
if [ -f "$CAPTURE_DIR/cafe66.ndjson" ] && grep -q "Designated: cybered,qa,qa2" "$CAPTURE_DIR/cafe66.ndjson"; then
  echo "  ok   the landing comment names the actual NON-EMPTY designation it checked (U4): Designated: cybered,qa,qa2"
else
  echo "  FAIL expected 'Designated: cybered,qa,qa2' in cafe66's landing comment"; fail=1
fi

# Card 3731c807 (W2, RedHat 16520): a FAILING verdict on a card's own DESIGNATED security gate
# must never be overridden by --allow-ungated. Measured here rather than assumed: a CYBERED NO-GO
# on the sha being landed is ALSO caught by the earlier, broader gate_verdict_check step (it scans
# every gate's PASS/FAIL on the sha, not only QA's) -- so this scenario refuses there first, before
# card_designated_gates_agree's OWN designation_rc==2 branch is ever reached. That branch's message
# ("card ...'s designated gates (...) carry a FAILING verdict") is therefore currently UNREACHABLE
# through land_one's public interface whenever the failing gate is one gate_verdict_check already
# recognises (QA/cybersec/cybered) -- a non-blocking observation for MikroB, not a bug: the net
# effect (refuse, never overridden by --allow-ungated) is correct either way, just via the first
# of the two checks rather than the second. This case pins that net effect with the ACTUAL message
# the broader check prints, so a future change that weakens EITHER check's --allow-ungated handling
# still gets caught by at least one of them.
git -C "$MAIN" checkout -q -b card/beeffa develop
echo "beeffa content" > "$MAIN/beeffa.txt"
git -C "$MAIN" add beeffa.txt
git -C "$MAIN" -c user.email=s@s -c user.name=s commit -qm "card beeffa: add beeffa.txt"
git -C "$MAIN" checkout -q develop
SHA_BEEFFA="$(git -C "$MAIN" rev-parse card/beeffa)"
set_card_desc beeffa "Gate: RedHat (trust boundary)"
printf '[{"author":"qa","content":"QA PASS\\nGate-SHA: %s"},{"author":"cybered","content":"CYBERED NO-GO\\nGate-SHA: %s"}]' \
  "$SHA_BEEFFA" "$SHA_BEEFFA" > "$GET_DIR/beeffa.json"

n=$((n + 1))
land_card beeffa backend3 --allow-ungated
if [ "$rc" != 0 ] && grep -q "carries a FAILING gate verdict" "$OUT_FILE"; then
  echo "  ok   a FAILING verdict on a card's own designated security gate refuses even with --allow-ungated (W2, via gate_verdict_check's broader FAIL scan)"
else
  echo "  FAIL expected a FAILING-verdict refusal regardless of --allow-ungated -> rc=$rc:"; tail -15 "$OUT_FILE" | sed 's/^/       /'; fail=1
fi

n=$((n + 1))
if ! git -C "$MAIN" merge-base --is-ancestor card/beeffa origin/develop 2>/dev/null; then
  echo "  ok   the W2-refused landing pushed nothing"
else
  echo "  FAIL a W2-refused landing should not have pushed anything"; fail=1
fi

# N2: the "UNGATED LANDING" note must be posted ONLY after a successful merge+push -- not when the
# gate-check tolerance was granted but the landing failed for an UNRELATED reason afterwards (here:
# a forced fleet-test failure). Bypasses land_card() to override MARVEEN_LAND_TEST per-call.
git -C "$MAIN" checkout -q -b card/face99 develop
echo "face99 content" > "$MAIN/face99.txt"
git -C "$MAIN" add face99.txt
git -C "$MAIN" -c user.email=s@s -c user.name=s commit -qm "card face99: add face99.txt"
git -C "$MAIN" checkout -q develop
set_card_desc face99 "no Gate line here either"

n=$((n + 1))
MARVEEN_MAIN="$MAIN" MARVEEN_LAND_TEST="false" MARVEEN_LAND_BUILD="true" \
  MARVEEN_LAND_DEVELOP_LOCK_FILE="$LOCK_DIR/.marveen-land-develop.lock" \
  KANBAN_COMMENT_API="http://127.0.0.1:$stub_port" KANBAN_COMMENT_TOKEN_FILE="$TOKEN_TMP" \
  GATE_CHECK_API="http://127.0.0.1:$stub_port" GATE_CHECK_TOKEN_FILE="$TOKEN_TMP" \
  timeout 30 bash "$LAND" --card face99 --agent backend3 --allow-ungated >"$OUT_FILE" 2>&1; rc=$?
if [ "$rc" != 0 ] && grep -q "fleet-test failed" "$OUT_FILE"; then
  echo "  ok   a forced fleet-test failure still refuses even though the gate-check was tolerated (N2 setup)"
else
  echo "  FAIL expected a fleet-test refusal for face99 -> rc=$rc:"; tail -15 "$OUT_FILE" | sed 's/^/       /'; fail=1
fi

n=$((n + 1))
if ! git -C "$MAIN" merge-base --is-ancestor card/face99 origin/develop 2>/dev/null; then
  echo "  ok   the fleet-test-refused landing pushed nothing"
else
  echo "  FAIL a fleet-test-refused landing should not have pushed anything"; fail=1
fi

n=$((n + 1))
if [ ! -f "$CAPTURE_DIR/face99.ndjson" ] || ! grep -q "UNGATED LANDING" "$CAPTURE_DIR/face99.ndjson"; then
  echo "  ok   NO 'UNGATED LANDING' comment was posted for a tolerated-but-never-landed card (N2 fix)"
else
  echo "  FAIL an UNGATED LANDING comment should not have been posted before the landing actually succeeded"; fail=1
fi

# card cd3e577b, MikroB decision 16324 (RedHat NO-GO 16322, finding B2): the --all sweep must list,
# never land, agent/*/work AND card/* branches -- and must not keep re-listing an already-landed
# card/* branch. Same repro shape as the RedHat/QA reports: 2 agent branches + 1 card branch.
git -C "$MAIN" branch -q agent/zalpha/work develop
git -C "$MAIN" worktree add -q "$WORK/zalpha-wt" agent/zalpha/work >/dev/null
echo alpha > "$WORK/zalpha-wt/zalpha.txt"
git -C "$WORK/zalpha-wt" add zalpha.txt
git -C "$WORK/zalpha-wt" -c user.email=s@s -c user.name=s commit -qm "agent zalpha: add zalpha.txt"
git -C "$MAIN" worktree remove --force "$WORK/zalpha-wt" >/dev/null

git -C "$MAIN" checkout -q -b card/zzz999 develop
echo "zzz999 content" > "$MAIN/zzz999.txt"
git -C "$MAIN" add zzz999.txt
git -C "$MAIN" -c user.email=s@s -c user.name=s commit -qm "card zzz999: add zzz999.txt"
git -C "$MAIN" checkout -q develop

all_out="$(MARVEEN_MAIN="$MAIN" MARVEEN_LAND_DEVELOP_LOCK_FILE="$LOCK_DIR/.marveen-land-develop.lock" \
  timeout 30 bash "$LAND" --all --dry-run 2>&1)"; all_rc=$?

n=$((n + 1))
if printf '%s' "$all_out" | grep -q "agent/zalpha/work has unlanded commit"; then
  echo "  ok   --all lists an unlanded agent/*/work branch instead of landing it (B2/R4)"
else
  echo "  FAIL expected --all to list agent/zalpha/work -> rc=$all_rc: $all_out"; fail=1
fi

n=$((n + 1))
if ! git -C "$MAIN" merge-base --is-ancestor agent/zalpha/work origin/develop 2>/dev/null; then
  echo "  ok   --all did not land agent/zalpha/work (R4: the owner lands it themselves)"
else
  echo "  FAIL --all should not have landed agent/zalpha/work"; fail=1
fi

n=$((n + 1))
if printf '%s' "$all_out" | grep -q "card/zzz999 exists but card/\* branches are not swept"; then
  echo "  ok   --all lists the unlanded card/zzz999 branch (B2)"
else
  echo "  FAIL expected --all to list card/zzz999 -> rc=$all_rc: $all_out"; fail=1
fi

# The already-landed card/aaa111 (landed earlier in this file) must NOT keep showing up in --all's
# card/* notice (MikroB 16324, "a landolt card/* agakat az --all ne sorolja").
n=$((n + 1))
if ! printf '%s' "$all_out" | grep -q "card/aaa111 exists but"; then
  echo "  ok   --all does not re-list the already-landed card/aaa111 (MikroB 16324)"
else
  echo "  FAIL --all should not list an already-landed card/* branch -> $all_out"; fail=1
fi

# The brace-group mutation test (reverting the bare `exec {FD}>&- 2>/dev/null`, card cd3e577b B2)
# does NOT belong here any more: R4 (MikroB decision 16324) made --all never call land_one/cleanup
# at all, so the stderr-muting bug is structurally unreachable from --all now -- there is nothing
# left for that mutation to silence in THIS fixture. The mechanism itself (a bare `exec` permanently
# reassigning the whole script's stderr vs. the brace-group scoping it to one close) is tested
# directly, isolated from git/network, in marveen-land.sh's own --selftest block.

rm -rf "$WORK"

echo ""
echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
