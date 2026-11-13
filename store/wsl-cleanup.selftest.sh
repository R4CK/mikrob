#!/usr/bin/env bash
# Self-test for store/wsl-cleanup.sh's live-pid guard on throwaway land/test worktrees
# (card 7f3e8ac6).
#
# Run: bash store/wsl-cleanup.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
#
# THE DEFECT: sweep_throwaway_worktrees() decided whether to remove a throwaway worktree from
# mtime age (>= MIN_AGE_MIN) and `git status --porcelain` being clean, nothing else. A land/test
# run can legitimately run past MIN_AGE_MIN (measured live: card 22835648 ran 1h38m) without
# touching the worktree's own top-level mtime the whole time, so a clean, old worktree whose
# owning process is STILL running could be force-removed mid-run. The fix extracts the PID
# encoded in the worktree's own name (marveen-land.sh's "<prefix>-<name>-$$" convention) and
# skips removal when that PID is a live process.
#
# HERMETIC-ISH: uses a throwaway git repo as MARVEEN_MAIN, but the worktree PATHS themselves are
# real, disposable directories under /home/neon/marveen-land-<name>-<pid> (cleaned up in the
# trap) -- unavoidable because wsl-cleanup.sh's pattern for this sweep is an absolute literal
# prefix (/home/neon/marveen-land-...), not derived from $MARVEEN_MAIN. CLEANCORE_MAIN points at
# a plain (non-git) temp dir so the sibling cc-land sweep is a no-op and touches nothing.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/wsl-cleanup.sh"

pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

TMP="$(mktemp -d)"
MARVEEN_MAIN_TEST="$TMP/main"
CLEANCORE_MAIN_TEST="$TMP/no-git-here"
mkdir -p "$MARVEEN_MAIN_TEST" "$CLEANCORE_MAIN_TEST"

git init -q "$MARVEEN_MAIN_TEST"
git -C "$MARVEEN_MAIN_TEST" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

LIVE_DIR=""
DEAD_DIR=""
LIVE_PID=""
DEAD_PID=""
SLEEP_PID=""

cleanup() {
  [ -n "$SLEEP_PID" ] && kill "$SLEEP_PID" 2>/dev/null
  for d in "$LIVE_DIR" "$DEAD_DIR"; do
    [ -n "$d" ] && [ -d "$d" ] && git -C "$MARVEEN_MAIN_TEST" worktree remove --force "$d" 2>/dev/null
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

# A real, still-running process: a background sleep. Its PID is genuinely alive for the whole
# test (killed in the trap above).
sleep 60 &
SLEEP_PID=$!
LIVE_PID="$SLEEP_PID"

# A real, already-exited process: start it and wait for it, so its PID is confirmed dead (not
# just "probably" -- `wait` only returns after the process has actually exited).
( exit 0 ) &
DEAD_PID=$!
wait "$DEAD_PID" 2>/dev/null

LIVE_DIR="/home/neon/marveen-land-selftestlive-${LIVE_PID}"
DEAD_DIR="/home/neon/marveen-land-selftestdead-${DEAD_PID}"
rm -rf "$LIVE_DIR" "$DEAD_DIR"

git -C "$MARVEEN_MAIN_TEST" worktree add -q --detach "$LIVE_DIR" HEAD
git -C "$MARVEEN_MAIN_TEST" worktree add -q --detach "$DEAD_DIR" HEAD

# Backdate both well past MIN_AGE_MIN so age alone would qualify both for removal.
PAST=$(( $(date +%s) - 130 * 60 ))
touch -d "@$PAST" "$LIVE_DIR" "$DEAD_DIR"

OUT="$(MARVEEN_MAIN="$MARVEEN_MAIN_TEST" CLEANCORE_MAIN="$CLEANCORE_MAIN_TEST" \
       WSL_CLEANUP_MIN_AGE_MIN=120 bash "$RUN" --dry-run 2>&1)"

# --- Case 1: clean, >2h old worktree whose owning PID is ALIVE must NOT be removed ----------
if echo "$OUT" | grep -qF "SKIP (owning pid $LIVE_PID still alive): $LIVE_DIR"; then
  ok "live-pid worktree is skipped with the expected message"
else
  bad "live-pid worktree was not skipped as expected" "$OUT"
fi
if echo "$OUT" | grep -qF "worktree remove --force '$LIVE_DIR'"; then
  bad "live-pid worktree was (dry-run) removed -- must never happen" "$OUT"
else
  ok "live-pid worktree was not passed to 'git worktree remove'"
fi

# --- Case 2: same shape but the owning PID is DEAD -- must still be removed ------------------
if echo "$OUT" | grep -qF "worktree remove --force '$DEAD_DIR'"; then
  ok "dead-pid worktree is still removed (dry-run)"
else
  bad "dead-pid worktree was NOT removed, expected it to be" "$OUT"
fi
if echo "$OUT" | grep -qF "SKIP (owning pid $DEAD_PID still alive): $DEAD_DIR"; then
  bad "dead-pid worktree was incorrectly reported as having a live owning pid" "$OUT"
else
  ok "dead-pid worktree was not skipped for a live-pid reason"
fi

echo
echo "wsl-cleanup.selftest: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
