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
FIXTURE_ROOT="$WORK/worktrees"
git init -q -b develop "$MAIN"
git -C "$MAIN" config user.email s@s
git -C "$MAIN" config user.name s
echo base > "$MAIN/notes.txt"
git -C "$MAIN" add .
git -C "$MAIN" commit -qm base

printf '%s\n' '*.local' 'node_modules' 'dist/' > "$MAIN/.gitignore"
git -C "$MAIN" add .gitignore
git -C "$MAIN" commit -qm "add gitignore (F3 fixture)"

ORIGIN="$WORK/origin.git"
git init -q --bare -b develop "$ORIGIN"
git -C "$MAIN" remote add origin "$ORIGIN"
git -C "$MAIN" push -q origin develop
git -C "$MAIN" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/develop

export MARVEEN_MAIN="$MAIN"
export MARVEEN_WORKTREES="$FIXTURE_ROOT"

mk_card_worktree() {
  # A card branch with NO commit of its own would be trivially "landed" (it IS develop's tip at
  # creation time) regardless of whether it is ever actually merged -- every worktree gets a real,
  # distinguishing commit so the landed/not-landed classification is genuinely exercised, not
  # accidentally true by construction.
  local id="$1"
  git -C "$MAIN" branch "card/$id" develop
  mkdir -p "$FIXTURE_ROOT/card"
  git -C "$MAIN" worktree add -q "$FIXTURE_ROOT/card/$id" "card/$id"
  echo "$id content" > "$FIXTURE_ROOT/card/$id/$id.txt"
  git -C "$FIXTURE_ROOT/card/$id" add "$id.txt"
  git -C "$FIXTURE_ROOT/card/$id" commit -qm "card $id: add $id.txt"
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
check "dry-run for aaa111 did not remove the worktree" test -d "$FIXTURE_ROOT/card/aaa111"

out_apply_noyes="$(bash "$CLEANUP" --apply 2>&1)"
rc_noyes=$?
check "--apply without --yes refuses (exit 2)" test "$rc_noyes" = 2
check "--apply without --yes removed nothing" test -d "$FIXTURE_ROOT/card/aaa111"

bash "$CLEANUP" --apply --yes >/dev/null 2>&1
check "--apply --yes removed the landed+clean+idle worktree aaa111" test ! -d "$FIXTURE_ROOT/card/aaa111"
check "--apply --yes deleted the card/aaa111 branch" \
  bash -c '! git -C "$1" show-ref --verify --quiet refs/heads/card/aaa111' _ "$MAIN"

# --- Case B: dirty tree -> SKIP, never removed ----------------------------------------------------
mk_card_worktree bbb222
land_card bbb222
echo dirty > "$FIXTURE_ROOT/card/bbb222/scratch.txt"
out_b="$(bash "$CLEANUP" --dry-run 2>&1)"
check "card bbb222 (dirty) classifies SKIP in dry-run" \
  bash -c "echo \"\$1\" | grep -q 'SKIP.*card bbb222'" _ "$out_b"
check "dry-run names the dirty-tree reason for bbb222" \
  bash -c "echo \"\$1\" | grep -q 'uncommitted or ignored-but-untracked changes in the worktree'" _ "$out_b"
bash "$CLEANUP" --apply --yes >/dev/null 2>&1
check "--apply --yes did NOT remove the dirty worktree bbb222" test -d "$FIXTURE_ROOT/card/bbb222"

# --- Case C: live process cwd'd into the worktree -> SKIP, never removed -------------------------
mk_card_worktree ccc333
land_card ccc333
( cd "$FIXTURE_ROOT/card/ccc333" && exec sleep 30 ) &
sleep_pid=$!
sleep 0.3
out_c="$(bash "$CLEANUP" --dry-run 2>&1)"
check "card ccc333 (live process cwd) classifies SKIP in dry-run" \
  bash -c "echo \"\$1\" | grep -q 'SKIP.*card ccc333'" _ "$out_c"
check "dry-run names the live-process reason for ccc333" \
  bash -c "echo \"\$1\" | grep -q 'live process has cwd/fd'" _ "$out_c"
bash "$CLEANUP" --apply --yes >/dev/null 2>&1
check "--apply --yes did NOT remove the in-use worktree ccc333" test -d "$FIXTURE_ROOT/card/ccc333"
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
check "--apply --yes did NOT remove the unlanded worktree ddd444" test -d "$FIXTURE_ROOT/card/ddd444"

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
check "F1: fff666 worktree removed" test ! -d "$FIXTURE_ROOT/card/fff666"
check "F1: ggg777 worktree removed" test ! -d "$FIXTURE_ROOT/card/ggg777"
check "F1: zzz999 (unlanded) worktree NOT removed" test -d "$FIXTURE_ROOT/card/zzz999"
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
head_before="$(git -C "$FIXTURE_ROOT/card/hhh888" rev-parse HEAD)"
git -C "$FIXTURE_ROOT/card/hhh888" checkout -q --detach
echo "unlanded work" > "$FIXTURE_ROOT/card/hhh888/UNLANDED_WORK.txt"
git -C "$FIXTURE_ROOT/card/hhh888" add UNLANDED_WORK.txt
git -C "$FIXTURE_ROOT/card/hhh888" commit -qm "detached unlanded commit"
detached_head="$(git -C "$FIXTURE_ROOT/card/hhh888" rev-parse HEAD)"
out_f="$(bash "$CLEANUP" --dry-run 2>&1)"
check "F2: detached-HEAD worktree (extra unlanded commit) classifies SKIP, not REMOVABLE" \
  bash -c "echo \"\$1\" | grep -q 'SKIP.*card hhh888'" _ "$out_f"
bash "$CLEANUP" --apply --yes >/dev/null 2>&1
check "F2: detached-HEAD worktree was NOT removed" test -d "$FIXTURE_ROOT/card/hhh888"
check "F2: the detached commit is still HEAD (not orphaned by a removal)" \
  bash -c 'test "$(git -C "$1" rev-parse HEAD)" = "$2"' _ "$FIXTURE_ROOT/card/hhh888" "$detached_head"

# --- Case G (F3): landed + clean by porcelain, but an ignored, non-allowlisted file is present ---
# (cybered F3 / cybersec F3: `git status --porcelain` does not list ignored files, and plain
# `git worktree remove` -- even without --force, measured separately -- does not refuse on them
# either, so a "clean" worktree could still lose a real local file like .env on removal.)
mk_card_worktree iii000
land_card iii000
echo "local secret" > "$FIXTURE_ROOT/card/iii000/secret.local"
out_g="$(bash "$CLEANUP" --dry-run 2>&1)"
check "F3: ignored-but-present file (secret.local) classifies SKIP, not REMOVABLE" \
  bash -c "echo \"\$1\" | grep -q 'SKIP.*card iii000'" _ "$out_g"
bash "$CLEANUP" --apply --yes >/dev/null 2>&1
check "F3: worktree with the ignored file was NOT removed" test -d "$FIXTURE_ROOT/card/iii000"
check "F3: the ignored file itself still exists" test -f "$FIXTURE_ROOT/card/iii000/secret.local"

# --- Case G2 (F3 control): a SYMLINKED node_modules (the real fleet convention) must NOT block --
# removal -- the worktree itself is removed, but the symlink TARGET (shared store elsewhere)
# survives, since removal only unlinks the symlink.
mk_card_worktree jjj111
land_card jjj111
mkdir -p "$WORK/shared-node-modules-jjj111"
echo "x" > "$WORK/shared-node-modules-jjj111/pkg.js"
ln -s "$WORK/shared-node-modules-jjj111" "$FIXTURE_ROOT/card/jjj111/node_modules"
out_g2="$(bash "$CLEANUP" --dry-run 2>&1)"
check "F3 control: a SYMLINKED node_modules still classifies REMOVABLE" \
  bash -c "echo \"\$1\" | grep -q 'REMOVABLE.*card jjj111'" _ "$out_g2"
bash "$CLEANUP" --apply --yes >/dev/null 2>&1
check "F3 control: the symlinked-node_modules worktree WAS removed" test ! -d "$FIXTURE_ROOT/card/jjj111"
check "F3 control: the symlink TARGET survives the removal" test -f "$WORK/shared-node-modules-jjj111/pkg.js"

# --- Case G3 (F8): a REAL (non-symlink) ignored node_modules dir with unique content BLOCKS ------
# the sweep -- the pre-F8 allowlist matched on NAME alone, so a real node_modules/dist holding
# irreplaceable data (e.g. a local .env dropped there, or a never-rebuilt artifact) was swept
# silently. Confirmed live on the real fleet worktree root before this fix: node_modules is a
# symlink in all 101 real card worktrees that have one, dist is a real directory in 3 -- so this
# is the fleet's actual shape, not a hypothetical.
mk_card_worktree lll333
land_card lll333
mkdir -p "$FIXTURE_ROOT/card/lll333/node_modules"
echo "only copy" > "$FIXTURE_ROOT/card/lll333/node_modules/only-copy.bin"
out_g3="$(bash "$CLEANUP" --dry-run 2>&1)"
check "F8: a REAL (non-symlink) node_modules with content classifies SKIP, not REMOVABLE" \
  bash -c "echo \"\$1\" | grep -q 'SKIP.*card lll333'" _ "$out_g3"
bash "$CLEANUP" --apply --yes >/dev/null 2>&1
check "F8: the real-node_modules worktree was NOT removed" test -d "$FIXTURE_ROOT/card/lll333"
check "F8: the unique file inside it still exists" test -f "$FIXTURE_ROOT/card/lll333/node_modules/only-copy.bin"

# --- Case G4 (F8): a REAL (non-symlink) ignored dist dir with unique content BLOCKS the sweep ----
mk_card_worktree mmm444
land_card mmm444
mkdir -p "$FIXTURE_ROOT/card/mmm444/dist"
echo "only copy" > "$FIXTURE_ROOT/card/mmm444/dist/only-copy.bin"
out_g4="$(bash "$CLEANUP" --dry-run 2>&1)"
check "F8: a REAL (non-symlink) dist with content classifies SKIP, not REMOVABLE" \
  bash -c "echo \"\$1\" | grep -q 'SKIP.*card mmm444'" _ "$out_g4"
bash "$CLEANUP" --apply --yes >/dev/null 2>&1
check "F8: the real-dist worktree was NOT removed" test -d "$FIXTURE_ROOT/card/mmm444"
check "F8: the unique file inside it still exists" test -f "$FIXTURE_ROOT/card/mmm444/dist/only-copy.bin"

# --- Case H (F4): a card/<id> entry reached only through a SYMLINK hides a live process -----------
# (cybered F4 / cybersec INFO: IDLE compared the worktree path STRING against /proc's already-
# resolved cwd/fd targets -- a symlinked entry never matched, so a live process under it was
# invisible to the check.)
mk_card_worktree kkk222
land_card kkk222
mv "$FIXTURE_ROOT/card/kkk222" "$FIXTURE_ROOT/card/kkk222_real"
ln -s kkk222_real "$FIXTURE_ROOT/card/kkk222"
( cd "$FIXTURE_ROOT/card/kkk222" && exec sleep 30 ) &
sleep_pid_h=$!
sleep 0.3
out_h="$(bash "$CLEANUP" --dry-run 2>&1)"
check "F4: live process under a SYMLINKED card entry classifies SKIP, not REMOVABLE" \
  bash -c "echo \"\$1\" | grep -q 'SKIP.*(card kkk222)'" _ "$out_h"
bash "$CLEANUP" --apply --yes >/dev/null 2>&1
check "F4: the symlinked, in-use worktree was NOT removed" test -e "$FIXTURE_ROOT/card/kkk222"
kill "$sleep_pid_h" 2>/dev/null
wait "$sleep_pid_h" 2>/dev/null

# --- Case I (L1): a FRESH card branch with NO commit of its own is NOT vacuously REMOVABLE -------
# (cybersec L1, 37506: the branch tip at creation time equals develop's tip, which trivially IS an
# ancestor of origin/develop regardless of whether anything was ever landed -- is_landed must not
# treat "never diverged" as "landed".)
git -C "$MAIN" branch "card/nnn555" develop
mkdir -p "$FIXTURE_ROOT/card"
git -C "$MAIN" worktree add -q "$FIXTURE_ROOT/card/nnn555" "card/nnn555"
out_i="$(bash "$CLEANUP" --dry-run 2>&1)"
check "L1: a fresh, never-committed card worktree classifies SKIP, not REMOVABLE" \
  bash -c "echo \"\$1\" | grep -q 'SKIP.*card nnn555'" _ "$out_i"
check "L1: dry-run names the not-landed reason for nnn555" \
  bash -c "echo \"\$1\" | grep -q 'not landed'" _ "$out_i"
bash "$CLEANUP" --apply --yes >/dev/null 2>&1
check "L1: the fresh worktree was NOT removed" test -d "$FIXTURE_ROOT/card/nnn555"

# --- Mutant checks: a reader that silently finds zero candidates must not look like success ------
# (guards-that-pin-behaviour point 8: assert non-vacuity)
out_empty_root="$(MARVEEN_WORKTREES="$(mktemp -d)" bash "$CLEANUP" --dry-run 2>&1)"
check "an empty/no card-worktrees root says so explicitly, not a bare empty report" \
  bash -c "echo \"\$1\" | grep -q 'no card worktrees under'" _ "$out_empty_root"

echo
echo "selftest: $n case(s), $([ "$fail" = 0 ] && echo PASS || echo "FAIL ($fail failed)")"
exit "$([ "$fail" = 0 ] && echo 0 || echo 1)"
