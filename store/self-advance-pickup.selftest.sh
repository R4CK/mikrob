#!/usr/bin/env bash
# self-advance-pickup.selftest.sh -- does the single self-advance entry point (card 3906d77b) hold
# its one hard invariant: PICKUP NEVER BLOCKS ON DRAFTING?
#
# A FAKE DASHBOARD, never localhost:3420 -- same discipline as card-build-route-24h-measure.selftest.sh:
# this script makes exactly one network call (the move POST), and a selftest must never depend on, or
# mutate, the live board.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/self-advance-pickup.sh"
TMP="$(mktemp -d)"

PASS=0; FAIL=0
declare -a FAILED=()

# --- fake dashboard: POST /api/kanban/<id>/move -> 200 unless FAIL_MOVE file exists; records the
# last request body to $TMP/last-move-body.json --------------------------------------------------
mkdir -p "$TMP/reqs"
cat > "$TMP/fake-dashboard.py" <<'PYEOF'
import http.server, sys, os
DIR = sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length) if length else b''
        with open(os.path.join(DIR, 'last-move-body.json'), 'wb') as f:
            f.write(body)
        code = 500 if os.path.exists(os.path.join(DIR, 'FAIL_MOVE')) else 200
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(b'{"ok":true}' if code == 200 else b'{"error":"boom"}')
    def do_GET(self):
        # card cd3e577b, step 4b: the bulk kanban list, used to read a card's title/status (there
        # is no single-card GET anywhere on this board). Served from a file the test controls, or
        # an empty list if none was set up.
        board_file = os.path.join(DIR, 'board.json')
        body = open(board_file, 'rb').read() if os.path.exists(board_file) else b'[]'
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(body)
port = int(sys.argv[1])
http.server.HTTPServer(('127.0.0.1', port), H).serve_forever()
PYEOF

port=$((22000 + RANDOM % 9000))
python3 "$TMP/fake-dashboard.py" "$port" "$TMP/reqs" &
server_pid=$!
sleep 0.3
trap 'kill "$server_pid" 2>/dev/null; wait "$server_pid" 2>/dev/null; rm -rf "$TMP"' EXIT
printf 'throwaway-not-real\n' > "$TMP/fake-token"

# --- stubs -------------------------------------------------------------------------------------
# Ollama health: exit 0 = up, exit 2 = down (mirrors local-llm.sh --health's own contract).
printf '#!/usr/bin/env bash\n[ "${1:-}" = "--health" ] && exit 0\nexit 4\n' > "$TMP/llm-up.sh"
printf '#!/usr/bin/env bash\n[ "${1:-}" = "--health" ] && exit 2\nexit 4\n' > "$TMP/llm-down.sh"
# card-build-route.sh stub: echoes a fixed verdict, records whether DISPATCHER was passed through.
printf '#!/usr/bin/env bash\necho "${CARD_BUILD_ROUTE_DISPATCHER:-unset}" > "%s/route-saw-dispatcher"\necho LOCAL\n' "$TMP" > "$TMP/route-local.sh"
printf '#!/usr/bin/env bash\necho "${CARD_BUILD_ROUTE_DISPATCHER:-unset}" > "%s/route-saw-dispatcher"\necho ONLINE\n' "$TMP" > "$TMP/route-online.sh"
# offload-dispatch.sh stub: just proves it was (or was not) invoked.
printf '#!/usr/bin/env bash\ntouch "%s/offload-was-called"\n' "$TMP" > "$TMP/offload-stub.sh"
# local-llm-installed.sh stub: default installed=yes (the pre-existing sections all assume a local
# model is present, same as before this gate existed); a dedicated not-installed stub for section G.
printf '#!/usr/bin/env bash\necho installed\nexit 0\n' > "$TMP/installed-yes.sh"
printf '#!/usr/bin/env bash\necho "not-installed: no ollama binary"\nexit 1\n' > "$TMP/installed-no.sh"

# card cd3e577b, step 4b: a stand-in for agent-worktree-marveen.sh. `--path` echoes a deterministic
# path under $TMP/cardtrees/<id> without touching git; otherwise it records that it was asked to
# create that card's worktree (append-only log, so the H-section tests can assert exactly how many
# times -- and for which card -- it was called) and makes the directory a real git worktree of the
# fake-main repo, so the cleanup path's `git worktree remove` has something real to remove.
cat > "$TMP/worktree-stub.sh" <<EOF
#!/usr/bin/env bash
AGENT="\$1"; shift
CARD=""; PATH_ONLY=0
while [ \$# -gt 0 ]; do
  case "\$1" in
    --card) shift; CARD="\$1" ;;
    --path) PATH_ONLY=1 ;;
  esac
  shift
done
TREE="$TMP/cardtrees/\$CARD"
if [ "\$PATH_ONLY" = 1 ]; then echo "\$TREE"; exit 0; fi
echo "\$AGENT \$CARD" >> "$TMP/worktree-create-calls.log"
mkdir -p "$TMP/cardtrees"
git -C "$TMP/fake-main" worktree add -q "\$TREE" -b "card/\$CARD" HEAD >/dev/null 2>&1
EOF

chmod +x "$TMP"/*.sh

# A tiny real git repo for MARVEEN_MAIN, so the cleanup path's `git -C "$MARVEEN_MAIN" worktree
# remove` has a real worktree to act on, not a stub.
git init -q "$TMP/fake-main"
git -C "$TMP/fake-main" config user.email s@s
git -C "$TMP/fake-main" config user.name s
echo base > "$TMP/fake-main/f.txt"
git -C "$TMP/fake-main" add f.txt
git -C "$TMP/fake-main" commit -qm base

board() { # writes $TMP/reqs/board.json from "<id>:<title>:<status>" triples
  python3 -c '
import json, sys
rows = []
for triple in sys.argv[1:]:
    cid, title, status = triple.split(":", 2)
    rows.append({"id": cid, "title": title, "status": status})
print(json.dumps(rows))
' "$@" > "$TMP/reqs/board.json"
}

CARD="abcdef0123456789"

run() { # env overrides via caller, then the two positional args
  rm -f "$TMP/offload-was-called" "$TMP/route-saw-dispatcher" "$TMP/reqs/last-move-body.json"
  SELF_ADVANCE_PICKUP_LLM="${STUB_LLM:-$TMP/llm-up.sh}" \
  SELF_ADVANCE_PICKUP_ROUTE="${STUB_ROUTE:-$TMP/route-online.sh}" \
  SELF_ADVANCE_PICKUP_OFFLOAD="${STUB_OFFLOAD:-$TMP/offload-stub.sh}" \
  SELF_ADVANCE_PICKUP_INSTALLED="${STUB_INSTALLED:-$TMP/installed-yes.sh}" \
  SELF_ADVANCE_PICKUP_API="http://127.0.0.1:$port" \
  SELF_ADVANCE_PICKUP_TOKEN_FILE="${STUB_TOKEN:-$TMP/fake-token}" \
  SELF_ADVANCE_PICKUP_FLAG_FILE="${STUB_FLAG:-$TMP/nonexistent-flag.json}" \
  SELF_ADVANCE_PICKUP_LOG="$TMP/route.log" \
  LOCAL_FIRST_DRAFT="${STUB_LOCAL_FIRST_DRAFT:-}" \
  MARVEEN_CARD_WORKTREE="${STUB_CARD_WORKTREE:-}" \
  SELF_ADVANCE_PICKUP_WORKTREE_SCRIPT="${STUB_WORKTREE_SCRIPT:-$TMP/worktree-stub.sh}" \
  MARVEEN_MAIN="${STUB_MARVEEN_MAIN:-$TMP/fake-main}" \
  SELF_ADVANCE_PICKUP_MARKER_DIR="${STUB_MARKER_DIR:-$TMP/markers}" \
    bash "$SCRIPT" "${1:-backend2}" "${2:-$CARD}"
}

assert_moved() { # $1 label -- the move POST reached the fake dashboard with status=in_progress
  if [ -s "$TMP/reqs/last-move-body.json" ] && grep -q '"status": *"in_progress"' "$TMP/reqs/last-move-body.json"; then
    PASS=$((PASS+1)); printf 'OK   moved to in_progress                    %s\n' "$1"
  else
    FAIL=$((FAIL+1)); FAILED+=("$1 (no in_progress move reached the fake dashboard)")
    printf 'FAIL no in_progress move reached the dashboard  %s\n' "$1"
  fi
}
assert_not_moved() { # $1 label
  if [ ! -s "$TMP/reqs/last-move-body.json" ]; then
    PASS=$((PASS+1)); printf 'OK   no move attempted                       %s\n' "$1"
  else
    FAIL=$((FAIL+1)); FAILED+=("$1 (a move reached the dashboard, expected none)")
    printf 'FAIL a move reached the dashboard, expected none  %s\n' "$1"
  fi
}
assert_offload_called() { # $1 expect(yes|no) $2 label
  local called=no; [ -f "$TMP/offload-was-called" ] && called=yes
  if [ "$called" = "$1" ]; then
    PASS=$((PASS+1)); printf 'OK   offload-dispatch called=%-4s            %s\n' "$1" "$2"
  else
    FAIL=$((FAIL+1)); FAILED+=("$2 (wanted offload-dispatch called=$1, got $called)")
    printf 'FAIL offload-dispatch called=%s wanted %s      %s\n' "$called" "$1" "$2"
  fi
}
assert_dispatcher_seen() { # $1 expected $2 label
  local got; got="$(cat "$TMP/route-saw-dispatcher" 2>/dev/null || echo none)"
  if [ "$got" = "$1" ]; then
    PASS=$((PASS+1)); printf 'OK   card-build-route saw DISPATCHER=%-14s %s\n' "$1" "$2"
  else
    FAIL=$((FAIL+1)); FAILED+=("$2 (wanted DISPATCHER=$1, got $got)")
    printf 'FAIL DISPATCHER=%s wanted %s                 %s\n' "$got" "$1" "$2"
  fi
}
assert_exit() { # $1 got-rc $2 expected-rc $3 label
  if [ "$1" -eq "$2" ]; then
    PASS=$((PASS+1)); printf 'OK   exit %-3s                                %s\n' "$1" "$3"
  else
    FAIL=$((FAIL+1)); FAILED+=("$3 (wanted exit $2, got $1)")
    printf 'FAIL exit %s wanted %s                        %s\n' "$1" "$2" "$3"
  fi
}

echo "=== A. THE HARD INVARIANT: pickup always happens, whatever step 1-4 decide ==="
STUB_ROUTE="$TMP/route-online.sh" run >/dev/null 2>&1; rc=$?
assert_exit "$rc" 0 "ONLINE verdict -> still picks up"
assert_moved "ONLINE verdict"
assert_offload_called no "ONLINE verdict never drafts"
assert_dispatcher_seen self-advance "card-build-route.sh sees the attribution env var"

STUB_ROUTE="$TMP/route-local.sh" run >/dev/null 2>&1; rc=$?
assert_exit "$rc" 0 "LOCAL verdict -> picks up AND drafts"
assert_moved "LOCAL verdict"
assert_offload_called yes "LOCAL verdict triggers offload-dispatch"

echo
echo "=== B. FLAG OFF -- skips the draft entirely, still picks up (grilling point 2) ==="
STUB_LOCAL_FIRST_DRAFT=off STUB_ROUTE="$TMP/route-local.sh" run >/dev/null 2>&1; rc=$?
assert_exit "$rc" 0 "flag off -> still picks up"
assert_moved "flag off"
assert_offload_called no "flag off never even asks the router"

echo
echo "=== B2. FLAG FILE (no env var) -- store/local-first-draft.json {\"enabled\":false} ==="
printf '{"enabled":false}\n' > "$TMP/flag-off.json"
STUB_FLAG="$TMP/flag-off.json" STUB_ROUTE="$TMP/route-local.sh" run >/dev/null 2>&1; rc=$?
assert_exit "$rc" 0 "flag-file off -> still picks up"
assert_offload_called no "flag-file off never asks the router"

echo
echo "=== C. OLLAMA DOWN -- skips the draft, NEVER blocks pickup (grilling point 3) ==="
STUB_LLM="$TMP/llm-down.sh" STUB_ROUTE="$TMP/route-local.sh" run >/dev/null 2>&1; rc=$?
assert_exit "$rc" 0 "ollama down -> still picks up"
assert_moved "ollama down"
assert_offload_called no "ollama down never reaches the router or offload-dispatch"

echo
echo "=== D. BAD USAGE -- exit 2, never touches the board ==="
rm -f "$TMP/reqs/last-move-body.json"
bash "$SCRIPT" >/dev/null 2>&1; rc=$?
assert_exit "$rc" 2 "no arguments at all"
assert_not_moved "no arguments"

rm -f "$TMP/reqs/last-move-body.json"
SELF_ADVANCE_PICKUP_API="http://127.0.0.1:$port" bash "$SCRIPT" backend2 "not-a-hex-id!!" >/dev/null 2>&1; rc=$?
assert_exit "$rc" 2 "bad card id"
assert_not_moved "bad card id"

echo
echo "=== E. PUT in_progress ITSELF FAILS -- the one failure the caller must see (exit 1) ==="
touch "$TMP/reqs/FAIL_MOVE"
STUB_ROUTE="$TMP/route-online.sh" run >/dev/null 2>&1; rc=$?
assert_exit "$rc" 1 "dashboard 500s the move"
rm -f "$TMP/reqs/FAIL_MOVE"

echo
echo "=== F. NO TOKEN -- exit 1, never attempts the move ==="
printf '' > "$TMP/empty-token"
rm -f "$TMP/reqs/last-move-body.json"
STUB_TOKEN="$TMP/empty-token" STUB_ROUTE="$TMP/route-online.sh" run >/dev/null 2>&1; rc=$?
assert_exit "$rc" 1 "empty token file"
assert_not_moved "empty token file"

echo
echo "=== G. NOT INSTALLED -- whole branch skipped, still picks up (Peti Telegram 8928) ==="
STUB_INSTALLED="$TMP/installed-no.sh" STUB_ROUTE="$TMP/route-local.sh" run >/dev/null 2>&1; rc=$?
assert_exit "$rc" 0 "not installed -> still picks up"
assert_moved "not installed"
assert_offload_called no "not installed never even asks the router"
tail_reason="$(awk -F'\t' 'END{print $4}' "$TMP/route.log" 2>/dev/null)"
if [ "$tail_reason" = "not-installed" ]; then
  PASS=$((PASS+1)); printf 'OK   log reason=not-installed                 not-installed logs its own reason, distinct from ollama-down/flag-off\n'
else
  FAIL=$((FAIL+1)); FAILED+=("not-installed log reason (wanted not-installed, got ${tail_reason:-none})")
  printf 'FAIL log reason=%s wanted not-installed       not-installed\n' "${tail_reason:-none}"
fi

echo
echo "=== H. CARD-WORKTREE, step 4b (card cd3e577b) ==="

echo "-- default OFF: no GET to the board, no worktree-create call --"
board "$CARD:[MikroB] something:in_progress"
rm -f "$TMP/worktree-create-calls.log"
STUB_ROUTE="$TMP/route-online.sh" run backend2 "$CARD" >/dev/null 2>&1; rc=$?
assert_exit "$rc" 0 "flag unset -> still picks up"
assert_moved "flag unset"
if [ ! -f "$TMP/worktree-create-calls.log" ]; then
  PASS=$((PASS+1)); printf 'OK   no worktree-create call                  flag unset (default OFF)\n'
else
  FAIL=$((FAIL+1)); FAILED+=("flag unset (default OFF) should never call the worktree script")
  printf 'FAIL worktree-create was called                flag unset (default OFF)\n'
fi

echo
echo "-- ON + [MikroB] title -> creates the per-card worktree --"
board "$CARD:[MikroB][INFRA][HIGH] F1 something:in_progress"
rm -f "$TMP/worktree-create-calls.log"
STUB_CARD_WORKTREE=1 STUB_ROUTE="$TMP/route-online.sh" run backend2 "$CARD" >/dev/null 2>&1; rc=$?
assert_exit "$rc" 0 "ON + [MikroB] tag -> still picks up"
assert_moved "ON + [MikroB] tag"
if grep -qx "backend2 $CARD" "$TMP/worktree-create-calls.log" 2>/dev/null; then
  PASS=$((PASS+1)); printf 'OK   worktree-create called for backend2/%s   ON + [MikroB] tag\n' "$CARD"
else
  FAIL=$((FAIL+1)); FAILED+=("ON + [MikroB] tag should call the worktree script for this card")
  printf 'FAIL worktree-create not called as expected    ON + [MikroB] tag\n'
fi

echo
echo "-- ON + NO [MikroB] title -> skipped (mopsion-card heuristic) --"
MOPSION_CARD="1122334455"
board "$MOPSION_CARD:Sima mopsion feature kartya, semmi MikroB tag:in_progress"
rm -f "$TMP/worktree-create-calls.log"
STUB_CARD_WORKTREE=1 STUB_ROUTE="$TMP/route-online.sh" run backend2 "$MOPSION_CARD" >/dev/null 2>&1; rc=$?
assert_exit "$rc" 0 "ON, mopsion-looking card -> still picks up"
if [ ! -f "$TMP/worktree-create-calls.log" ]; then
  PASS=$((PASS+1)); printf 'OK   no worktree-create call                  ON, no [MikroB] tag (mopsion card)\n'
else
  FAIL=$((FAIL+1)); FAILED+=("ON, no [MikroB] tag should never call the worktree script")
  printf 'FAIL worktree-create was called                ON, no [MikroB] tag (mopsion card)\n'
fi

echo
echo "-- cleanup: a DONE previous card's worktree is removed, branch untouched --"
rm -rf "$TMP/markers" "$TMP/cardtrees"
PREV_CARD="aaaa1111"
NEXT_CARD="bbbb2222"
board "$PREV_CARD:[MikroB] previous card:done" "$NEXT_CARD:[MikroB] next card:in_progress"
mkdir -p "$TMP/markers"
printf '%s' "$PREV_CARD" > "$TMP/markers/backend2"
mkdir -p "$TMP/cardtrees"
git -C "$TMP/fake-main" worktree add -q "$TMP/cardtrees/$PREV_CARD" -b "card/$PREV_CARD" HEAD
rm -f "$TMP/worktree-create-calls.log"
STUB_CARD_WORKTREE=1 STUB_ROUTE="$TMP/route-online.sh" run backend2 "$NEXT_CARD" >/dev/null 2>&1; rc=$?
assert_exit "$rc" 0 "cleanup round -> still picks up"
if [ ! -d "$TMP/cardtrees/$PREV_CARD" ]; then
  PASS=$((PASS+1)); printf 'OK   done previous card worktree removed      cleanup\n'
else
  FAIL=$((FAIL+1)); FAILED+=("cleanup should have removed the done previous card's worktree")
  printf 'FAIL previous card worktree still present       cleanup\n'
fi
if git -C "$TMP/fake-main" show-ref --verify --quiet "refs/heads/card/$PREV_CARD"; then
  PASS=$((PASS+1)); printf 'OK   the previous card BRANCH is untouched    cleanup (req. 5)\n'
else
  FAIL=$((FAIL+1)); FAILED+=("cleanup must never delete the card BRANCH, only the worktree (req. 5)")
  printf 'FAIL the previous card branch was removed        cleanup (req. 5)\n'
fi
if [ "$(cat "$TMP/markers/backend2" 2>/dev/null)" = "$NEXT_CARD" ]; then
  PASS=$((PASS+1)); printf 'OK   the marker now points at the new card    cleanup\n'
else
  FAIL=$((FAIL+1)); FAILED+=("cleanup should update the agent's marker to the new card")
  printf 'FAIL marker not updated to the new card          cleanup\n'
fi

echo
echo "-- a previous card that is NOT done yet is left alone --"
rm -rf "$TMP/markers" "$TMP/cardtrees"
board "$PREV_CARD:[MikroB] still in progress:in_progress" "$NEXT_CARD:[MikroB] next card:in_progress"
mkdir -p "$TMP/markers"
printf '%s' "$PREV_CARD" > "$TMP/markers/backend2"
mkdir -p "$TMP/cardtrees"
git -C "$TMP/fake-main" worktree add -q "$TMP/cardtrees/$PREV_CARD" -b "card/$PREV_CARD-2" HEAD
STUB_CARD_WORKTREE=1 STUB_ROUTE="$TMP/route-online.sh" run backend2 "$NEXT_CARD" >/dev/null 2>&1; rc=$?
assert_exit "$rc" 0 "not-done-previous round -> still picks up"
if [ -d "$TMP/cardtrees/$PREV_CARD" ]; then
  PASS=$((PASS+1)); printf 'OK   a not-yet-done previous worktree is left alone\n'
else
  FAIL=$((FAIL+1)); FAILED+=("a not-yet-done previous card worktree must not be removed")
  printf 'FAIL the not-yet-done previous worktree was removed\n'
fi
git -C "$TMP/fake-main" worktree remove --force "$TMP/cardtrees/$PREV_CARD" >/dev/null 2>&1

echo
echo "-------------------------------------------------------------"
echo "passed: $PASS   failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo
  for f in "${FAILED[@]}"; do echo "  - $f"; done
  exit 1
fi
echo "All cases passed."
exit 0
