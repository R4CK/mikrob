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

LOCK_DIR="$WORK/store"; mkdir -p "$LOCK_DIR"
TOKEN_TMP="$WORK/token"; echo tok > "$TOKEN_TMP"

# Stub dashboard: /api/kanban/<card>/comments captures every POST body into a file named after the
# card id, so the test can tell exactly which card a Gate-SHA comment landed on.
CAPTURE_DIR="$WORK/captured"; mkdir -p "$CAPTURE_DIR"
stub_pid=""
stub_up() {
  local portfile="$WORK/stub.port"
  rm -f "$portfile"
  python3 - "$CAPTURE_DIR" "$portfile" <<'PYSTUB' &
import http.server, json, sys, re
CAPTURE_DIR, PORTFILE = sys.argv[1:3]

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
    timeout 30 bash "$LAND" --card "$card" --agent "$agent" "$@" >"$OUT_FILE" 2>&1
  rc=$?
}

echo "marveen-land.sh --card <id> --agent <agent> selftest (card cd3e577b)"

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
if [ -f "$CAPTURE_DIR/aaa111.ndjson" ] && grep -q "Gate-SHA:" "$CAPTURE_DIR/aaa111.ndjson"; then
  echo "  ok   the automated Gate-SHA comment was posted to card aaa111 (the card actually landed)"
else
  echo "  FAIL expected an automated Gate-SHA comment captured for card aaa111"; fail=1
fi

n=$((n + 1))
if [ ! -f "$CAPTURE_DIR/bbb222.ndjson" ]; then
  echo "  ok   NO Gate-SHA comment was posted to the other, still-unlanded card (bbb222)"
else
  echo "  FAIL card bbb222 should not have received any comment from landing aaa111"; fail=1
fi

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
if [ -f "$CAPTURE_DIR/bbb222.ndjson" ] && grep -q "Gate-SHA:" "$CAPTURE_DIR/bbb222.ndjson"; then
  echo "  ok   the second landing posted ITS Gate-SHA to bbb222, not to aaa111"
else
  echo "  FAIL expected an automated Gate-SHA comment captured for card bbb222"; fail=1
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

rm -rf "$WORK"

echo ""
echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
