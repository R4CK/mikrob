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
  bash -c "echo \"\$1\" | grep -q 'uncommitted changes in the worktree'" _ "$out_b"
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

# --- Mutant checks: a reader that silently finds zero candidates must not look like success ------
# (guards-that-pin-behaviour point 8: assert non-vacuity)
out_empty_root="$(MARVEEN_WORKTREES="$(mktemp -d)" bash "$CLEANUP" --dry-run 2>&1)"
check "an empty/no card-worktrees root says so explicitly, not a bare empty report" \
  bash -c "echo \"\$1\" | grep -q 'no card worktrees under'" _ "$out_empty_root"

echo
echo "selftest: $n case(s), $([ "$fail" = 0 ] && echo PASS || echo "FAIL ($fail failed)")"
exit "$([ "$fail" = 0 ] && echo 0 || echo 1)"
