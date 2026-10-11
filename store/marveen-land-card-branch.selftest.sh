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
stub_pid=""
stub_up() {
  local portfile="$WORK/stub.port"
  rm -f "$portfile"
  python3 - "$CAPTURE_DIR" "$portfile" "$GET_DIR" <<'PYSTUB' &
import http.server, json, sys, re, os
CAPTURE_DIR, PORTFILE, GET_DIR = sys.argv[1:4]

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
        m = re.search(r'/api/kanban/([^/]+)/comments', self.path)
        resp = b"[]"
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

rm -rf "$WORK"

echo ""
echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
