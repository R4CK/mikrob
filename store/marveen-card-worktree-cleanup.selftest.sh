#!/usr/bin/env bash
# Self-test for marveen-card-worktree-cleanup.sh (card 0ae1166e, F4.4 of ed332869). Same throwaway-
# fixture-repo shape as marveen-land-card-branch.selftest.sh -- never touches the real marveen
# checkout or its real worktrees.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEANUP="$HERE/marveen-card-worktree-cleanup.sh"
fail=0
n=0

check() {
  n=$((n + 1))
  local desc="$1"; shift
  if "$@"; then
    echo "  ok   $desc"
  else
    echo "  FAIL $desc"
    fail=$((fail + 1))
  fi
}

WORK="$(mktemp -d)"
MAIN="$WORK/main"
ROOT="$WORK/worktrees"
git init -q -b develop "$MAIN"
git -C "$MAIN" config user.email s@s
git -C "$MAIN" config user.name s
echo base > "$MAIN/notes.txt"
git -C "$MAIN" add .
git -C "$MAIN" commit -qm base

printf '%s\n' '*.local' 'node_modules/' 'dist/' > "$MAIN/.gitignore"
git -C "$MAIN" add .gitignore
git -C "$MAIN" commit -qm "add gitignore (F3 fixture)"

ORIGIN="$WORK/origin.git"
git init -q --bare -b develop "$ORIGIN"
git -C "$MAIN" remote add origin "$ORIGIN"
git -C "$MAIN" push -q origin develop
git -C "$MAIN" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/develop

export MARVEEN_MAIN="$MAIN"
export MARVEEN_WORKTREES="$ROOT"

mk_card_worktree() {
  # A card branch with NO commit of its own would be trivially "landed" (it IS develop's tip at
  # creation time) regardless of whether it is ever actually merged -- every worktree gets a real,
  # distinguishing commit so the landed/not-landed classification is genuinely exercised, not
  # accidentally true by construction.
  local id="$1"
  git -C "$MAIN" branch "card/$id" develop
  mkdir -p "$ROOT/card"
  git -C "$MAIN" worktree add -q "$ROOT/card/$id" "card/$id"
  echo "$id content" > "$ROOT/card/$id/$id.txt"
  git -C "$ROOT/card/$id" add "$id.txt"
  git -C "$ROOT/card/$id" commit -qm "card $id: add $id.txt"
}

land_card() {
  # Simulate a landed card: merge its branch straight into develop and push.
  local id="$1"
  git -C "$MAIN" checkout -q develop
  git -C "$MAIN" merge -q --no-ff "card/$id" -m "land card/$id"
  git -C "$MAIN" push -q origin develop
  git -C "$MAIN" checkout -q --detach  # leave develop free for the next land_card call
}

# --- Case A: landed + clean + idle -> REMOVABLE, --apply removes it ------------------------------
mk_card_worktree aaa111
land_card aaa111
out_a="$(bash "$CLEANUP" --dry-run 2>&1)"
check "card aaa111 (landed, clean) classifies REMOVABLE in dry-run" \
  bash -c "echo \"\$1\" | grep -q 'REMOVABLE.*card aaa111'" _ "$out_a"
check "dry-run for aaa111 did not remove the worktree" test -d "$ROOT/card/aaa111"

out_apply_noyes="$(bash "$CLEANUP" --apply 2>&1)"
rc_noyes=$?
check "--apply without --yes refuses (exit 2)" test "$rc_noyes" = 2
check "--apply without --yes removed nothing" test -d "$ROOT/card/aaa111"

bash "$CLEANUP" --apply --yes >/dev/null 2>&1
check "--apply --yes removed the landed+clean+idle worktree aaa111" test ! -d "$ROOT/card/aaa111"
check "--apply --yes deleted the card/aaa111 branch" \
  bash -c '! git -C "$1" show-ref --verify --quiet refs/heads/card/aaa111' _ "$MAIN"

# --- Case B: dirty tree -> SKIP, never removed ----------------------------------------------------
mk_card_worktree bbb222
land_card bbb222
echo dirty > "$ROOT/card/bbb222/scratch.txt"
out_b="$(bash "$CLEANUP" --dry-run 2>&1)"
check "card bbb222 (dirty) classifies SKIP in dry-run" \
  bash -c "echo \"\$1\" | grep -q 'SKIP.*card bbb222'" _ "$out_b"
check "dry-run names the dirty-tree reason for bbb222" \
  bash -c "echo \"\$1\" | grep -q 'uncommitted or ignored-but-untracked changes in the worktree'" _ "$out_b"
bash "$CLEANUP" --apply --yes >/dev/null 2>&1
check "--apply --yes did NOT remove the dirty worktree bbb222" test -d "$ROOT/card/bbb222"

# --- Case C: live process cwd'd into the worktree -> SKIP, never removed -------------------------
mk_card_worktree ccc333
land_card ccc333
( cd "$ROOT/card/ccc333" && exec sleep 30 ) &
sleep_pid=$!
sleep 0.3
out_c="$(bash "$CLEANUP" --dry-run 2>&1)"
check "card ccc333 (live process cwd) classifies SKIP in dry-run" \
  bash -c "echo \"\$1\" | grep -q 'SKIP.*card ccc333'" _ "$out_c"
check "dry-run names the live-process reason for ccc333" \
  bash -c "echo \"\$1\" | grep -q 'live process has cwd/fd'" _ "$out_c"
bash "$CLEANUP" --apply --yes >/dev/null 2>&1
check "--apply --yes did NOT remove the in-use worktree ccc333" test -d "$ROOT/card/ccc333"
kill "$sleep_pid" 2>/dev/null
wait "$sleep_pid" 2>/dev/null

# --- Case D: never landed -> SKIP, never removed --------------------------------------------------
mk_card_worktree ddd444
out_d="$(bash "$CLEANUP" --dry-run 2>&1)"
check "card ddd444 (not landed) classifies SKIP in dry-run" \
  bash -c "echo \"\$1\" | grep -q 'SKIP.*card ddd444'" _ "$out_d"
check "dry-run names the not-landed reason for ddd444" \
  bash -c "echo \"\$1\" | grep -q 'not landed'" _ "$out_d"
bash "$CLEANUP" --apply --yes >/dev/null 2>&1
check "--apply --yes did NOT remove the unlanded worktree ddd444" test -d "$ROOT/card/ddd444"

# --- Case E (F1): two REMOVABLE cards in one --apply run, plus an unlanded card sorting LAST ------
# (cybered F1 / cybersec F1: the pre-fix `local path=... card=... branch="card/$card"` expands
# $card from the CALLER's scope before its own assignment lands, so every removal in a multi-
# candidate run resolved the LAST classified card's branch, not its own.)
mk_card_worktree fff666
land_card fff666
mk_card_worktree ggg777
land_card ggg777
mk_card_worktree zzz999  # not landed, sorts alphabetically LAST -- exactly the shape that hid F1
out_apply_e="$(bash "$CLEANUP" --apply --yes 2>&1)"
check "F1: fff666 worktree removed" test ! -d "$ROOT/card/fff666"
check "F1: ggg777 worktree removed" test ! -d "$ROOT/card/ggg777"
check "F1: zzz999 (unlanded) worktree NOT removed" test -d "$ROOT/card/zzz999"
check "F1: card/fff666 branch deleted" \
  bash -c '! git -C "$1" show-ref --verify --quiet refs/heads/card/fff666' _ "$MAIN"
check "F1: card/ggg777 branch deleted" \
  bash -c '! git -C "$1" show-ref --verify --quiet refs/heads/card/ggg777' _ "$MAIN"
check "F1: removing fff666 named its OWN branch, not zzz999's" \
  bash -c "echo \"\$1\" | grep -q 'removing:.*card/fff666 (branch card/fff666)'" _ "$out_apply_e"
check "F1: removing ggg777 named its OWN branch, not zzz999's" \
  bash -c "echo \"\$1\" | grep -q 'removing:.*card/ggg777 (branch card/ggg777)'" _ "$out_apply_e"
check "F1: zzz999's branch was never named by either removal" \
  bash -c "! echo \"\$1\" | grep -q 'branch card/zzz999'" _ "$out_apply_e"

# --- Case F (F2): landed branch, but worktree HEAD is DETACHED with an extra unlanded commit -----
# (cybered F2 / cybersec F2: LANDED was judged on the branch REF, never on what the worktree
# actually has checked out -- a detached commit not on any ref would be orphaned by the removal.)
mk_card_worktree hhh888
land_card hhh888
head_before="$(git -C "$ROOT/card/hhh888" rev-parse HEAD)"
git -C "$ROOT/card/hhh888" checkout -q --detach
echo "unlanded work" > "$ROOT/card/hhh888/UNLANDED_WORK.txt"
git -C "$ROOT/card/hhh888" add UNLANDED_WORK.txt
git -C "$ROOT/card/hhh888" commit -qm "detached unlanded commit"
detached_head="$(git -C "$ROOT/card/hhh888" rev-parse HEAD)"
out_f="$(bash "$CLEANUP" --dry-run 2>&1)"
check "F2: detached-HEAD worktree (extra unlanded commit) classifies SKIP, not REMOVABLE" \
  bash -c "echo \"\$1\" | grep -q 'SKIP.*card hhh888'" _ "$out_f"
bash "$CLEANUP" --apply --yes >/dev/null 2>&1
check "F2: detached-HEAD worktree was NOT removed" test -d "$ROOT/card/hhh888"
check "F2: the detached commit is still HEAD (not orphaned by a removal)" \
  bash -c 'test "$(git -C "$1" rev-parse HEAD)" = "$2"' _ "$ROOT/card/hhh888" "$detached_head"

# --- Case G (F3): landed + clean by porcelain, but an ignored, non-allowlisted file is present ---
# (cybered F3 / cybersec F3: `git status --porcelain` does not list ignored files, and plain
# `git worktree remove` -- even without --force, measured separately -- does not refuse on them
# either, so a "clean" worktree could still lose a real local file like .env on removal.)
mk_card_worktree iii000
land_card iii000
echo "local secret" > "$ROOT/card/iii000/secret.local"
out_g="$(bash "$CLEANUP" --dry-run 2>&1)"
check "F3: ignored-but-present file (secret.local) classifies SKIP, not REMOVABLE" \
  bash -c "echo \"\$1\" | grep -q 'SKIP.*card iii000'" _ "$out_g"
bash "$CLEANUP" --apply --yes >/dev/null 2>&1
check "F3: worktree with the ignored file was NOT removed" test -d "$ROOT/card/iii000"
check "F3: the ignored file itself still exists" test -f "$ROOT/card/iii000/secret.local"

# --- Case G2 (F3 control): an ALLOWLISTED ignored dir (node_modules) must NOT block removal -------
mk_card_worktree jjj111
land_card jjj111
mkdir -p "$ROOT/card/jjj111/node_modules"
echo "x" > "$ROOT/card/jjj111/node_modules/pkg.js"
out_g2="$(bash "$CLEANUP" --dry-run 2>&1)"
check "F3 control: an allowlisted ignored dir (node_modules) still classifies REMOVABLE" \
  bash -c "echo \"\$1\" | grep -q 'REMOVABLE.*card jjj111'" _ "$out_g2"
bash "$CLEANUP" --apply --yes >/dev/null 2>&1
check "F3 control: the node_modules-only worktree WAS removed" test ! -d "$ROOT/card/jjj111"

# --- Case H (F4): a card/<id> entry reached only through a SYMLINK hides a live process -----------
# (cybered F4 / cybersec INFO: IDLE compared the worktree path STRING against /proc's already-
# resolved cwd/fd targets -- a symlinked entry never matched, so a live process under it was
# invisible to the check.)
mk_card_worktree kkk222
land_card kkk222
mv "$ROOT/card/kkk222" "$ROOT/card/kkk222_real"
ln -s kkk222_real "$ROOT/card/kkk222"
( cd "$ROOT/card/kkk222" && exec sleep 30 ) &
sleep_pid_h=$!
sleep 0.3
out_h="$(bash "$CLEANUP" --dry-run 2>&1)"
check "F4: live process under a SYMLINKED card entry classifies SKIP, not REMOVABLE" \
  bash -c "echo \"\$1\" | grep -q 'SKIP.*(card kkk222)'" _ "$out_h"
bash "$CLEANUP" --apply --yes >/dev/null 2>&1
check "F4: the symlinked, in-use worktree was NOT removed" test -e "$ROOT/card/kkk222"
kill "$sleep_pid_h" 2>/dev/null
wait "$sleep_pid_h" 2>/dev/null

# --- Mutant checks: a reader that silently finds zero candidates must not look like success ------
# (guards-that-pin-behaviour point 8: assert non-vacuity)
out_empty_root="$(MARVEEN_WORKTREES="$(mktemp -d)" bash "$CLEANUP" --dry-run 2>&1)"
check "an empty/no card-worktrees root says so explicitly, not a bare empty report" \
  bash -c "echo \"\$1\" | grep -q 'no card worktrees under'" _ "$out_empty_root"

echo
echo "selftest: $n case(s), $([ "$fail" = 0 ] && echo PASS || echo "FAIL ($fail failed)")"
exit "$([ "$fail" = 0 ] && echo 0 || echo 1)"
