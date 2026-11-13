#!/usr/bin/env bash
# wsl-cleanup.sh -- periodic hygiene sweep for temporary/cache clutter (Peti request, 2026-09-01).
#
# WHAT THIS TOUCHES, AND WHY EACH IS SAFE:
#   1. Throwaway land/test worktrees (marveen-land.sh / cleancore-land.sh's own naming
#      convention: "<prefix>-<name>-$$", a PID suffix meaning "lives for one process only").
#      Removed ONLY if: (a) name matches the exact throwaway pattern, (b) `git worktree list`
#      still finds it (so a stale-but-registered entry is handled correctly by
#      `git worktree remove`, not a raw rm), (c) the PID in its own name is NOT a live process
#      (card 7f3e8ac6: a run can legitimately outlast $MIN_AGE_MIN -- measured 1h38m -- without
#      touching the worktree's own mtime, so mtime+clean-status alone can force-remove a
#      worktree a land/test run is still using), (d) `git status --porcelain` inside it is EMPTY
#      (no uncommitted work), (e) its mtime is older than $MIN_AGE_MIN minutes (generous
#      margin past any single land/test run). Anything failing (c) or (d) is left alone and
#      logged -- an agent's in-flight throwaway work is not this script's to guess about.
#   2. Package-manager caches (pip, npm, pnpm store, node-gyp): all content-addressable or
#      re-downloadable, official prune/purge commands only, never a client's actual
#      node_modules/dist output.
#   3. /tmp: entries older than $TMP_MIN_AGE_MIN untouched, excluding system paths. Test-suite
#      mktemp fixtures (turn-index-*, freshness-*, etc.) that a crashed/killed test run left
#      behind live here; this is the only broad-brush deletion in the script, guarded by the
#      age threshold so nothing from an ACTIVE run (agents touch their own scratch dirs
#      continuously) is at risk.
#   4. journalctl / apt cache: root-owned, only attempted with a NON-interactive sudo check
#      (`sudo -n`) -- silently skipped (not failed) when no passwordless sudo exists, so an
#      unattended scheduled run never hangs on a password prompt.
#
# WHAT THIS NEVER TOUCHES: persistent agent worktrees (marveen-agent-worktrees/*,
# CleanCore-worktrees/*), any worktree whose branch is NOT yet merged into origin's default
# branch, any worktree with uncommitted changes, ms-playwright (browser binaries other agents
# depend on), .claude/projects|file-history|plugins|skills (session/product state, not temp).
#
# Usage: wsl-cleanup.sh [--dry-run]
set -uo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

MIN_AGE_MIN="${WSL_CLEANUP_MIN_AGE_MIN:-120}"       # throwaway worktrees: 2h
TMP_MIN_AGE_MIN="${WSL_CLEANUP_TMP_MIN_AGE_MIN:-2880}" # /tmp entries: 48h

MARVEEN_MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"
# shellcheck source=./env-compat-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env-compat-lib.sh"
CLEANCORE_MAIN="$(env_compat_get MOPSION_MAIN CLEANCORE_MAIN /mnt/h/LM_Studio_Workdir/mopsion)"

say() { echo "wsl-cleanup: $*"; }
run() { if [ "$DRY_RUN" = 1 ]; then echo "  [dry-run] $*"; else eval "$@"; fi; }

freed_worktrees=0
skipped_dirty=0
skipped_live_pid=0

# --- 1. throwaway land/test worktrees, per repo -----------------------------------------
sweep_throwaway_worktrees() {
  local repo="$1" pattern="$2"
  [ -d "$repo/.git" ] || [ -f "$repo/.git" ] || return 0
  local now; now=$(date +%s)
  # `< <(...)` (process substitution), not `| while read`, so the loop runs in THIS shell --
  # a piped while-loop runs in a subshell and any counter it increments is lost on exit.
  local wt mtime age_min pid
  while read -r wt; do
    [[ "$wt" =~ $pattern ]] || continue
    [ -d "$wt" ] || continue
    # Trailing digits of the throwaway name are always the owning PID (marveen-land.sh's own
    # naming convention) regardless of which/how many capture groups $pattern itself has --
    # pulled with a plain suffix match instead of BASH_REMATCH so the two call sites below
    # (one extra optional group each) don't need to agree on a group index.
    pid="${wt##*-}"
    mtime=$(stat -c %Y "$wt" 2>/dev/null || echo "$now")
    age_min=$(( (now - mtime) / 60 ))
    [ "$age_min" -ge "$MIN_AGE_MIN" ] || continue
    # Card 7f3e8ac6 (MikroB, wsl-cleanup run 2026-11-13 12:03): mtime-plus-clean-status is not
    # enough on its own -- a land/test run can legitimately run past MIN_AGE_MIN (measured:
    # 22835648 ran 1h38m) with the worktree's own mtime untouched the whole time (fleet-test.sh
    # writes inside the git dir / its own state, not the worktree's top-level mtime), while the
    # directory name's trailing PID (the land/test script's own $$, marveen-land.sh's naming
    # convention) is still a live process. Checking that PID directly is the smallest reliable
    # fix (vs. scanning every process's cwd): the land script blocks synchronously on the whole
    # run, so its own PID stays alive for exactly as long as the worktree is actually in use.
    if kill -0 "$pid" 2>/dev/null; then
      say "SKIP (owning pid $pid still alive): $wt"
      skipped_live_pid=$((skipped_live_pid + 1))
      continue
    fi
    if [ -n "$(git -C "$wt" status --porcelain 2>&1)" ]; then
      say "SKIP (uncommitted changes): $wt"
      skipped_dirty=$((skipped_dirty + 1))
      continue
    fi
    say "removing throwaway worktree: $wt (age ${age_min}m)"
    run "git -C '$repo' worktree remove --force '$wt'"
    freed_worktrees=$((freed_worktrees + 1))
  done < <(git -C "$repo" worktree list --porcelain 2>/dev/null | awk '/^worktree/{print $2}')
}

sweep_throwaway_worktrees "$MARVEEN_MAIN" '^/home/neon/marveen-land-[a-zA-Z0-9]+-[0-9]+$'
sweep_throwaway_worktrees "$CLEANCORE_MAIN" '^/home/neon/cc-land(-base)?-[a-zA-Z0-9]+-[0-9]+$'

run "git -C '$MARVEEN_MAIN' worktree prune 2>/dev/null"
run "git -C '$CLEANCORE_MAIN' worktree prune 2>/dev/null"

say "throwaway worktrees removed: $freed_worktrees, skipped (uncommitted): $skipped_dirty, skipped (live pid): $skipped_live_pid"

# --- 2. package-manager caches (content-addressable / re-downloadable) -------------------
if command -v pip >/dev/null 2>&1; then
  run "pip cache purge >/dev/null 2>&1"
elif command -v pip3 >/dev/null 2>&1; then
  run "pip3 cache purge >/dev/null 2>&1"
else
  run "rm -rf '$HOME/.cache/pip'/* 2>/dev/null"
fi

if command -v npm >/dev/null 2>&1; then
  run "npm cache clean --force >/dev/null 2>&1"
else
  run "rm -rf '$HOME/.npm/_cacache'/* 2>/dev/null"
fi

if command -v pnpm >/dev/null 2>&1; then
  run "pnpm store prune >/dev/null 2>&1"
fi

run "rm -rf '$HOME/.cache/node-gyp'/* 2>/dev/null"

# --- 3. /tmp: entries untouched for TMP_MIN_AGE_MIN, excluding system paths -------------
run "find /tmp -mindepth 1 -maxdepth 1 -mmin +$TMP_MIN_AGE_MIN \
  -not -name '.X11-unix' -not -name '.font-unix' -not -name '.ICE-unix' \
  -exec rm -rf {} + 2>/dev/null"

# --- 4. root-owned caches, best-effort only (never blocks on a password prompt) ---------
if sudo -n true 2>/dev/null; then
  run "sudo -n journalctl --vacuum-time=7d >/dev/null 2>&1"
  run "sudo -n apt-get clean >/dev/null 2>&1"
else
  say "no passwordless sudo -- skipping journalctl/apt cleanup (safe no-op)"
fi

say "done"
