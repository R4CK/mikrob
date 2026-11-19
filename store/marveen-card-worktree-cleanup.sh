#!/usr/bin/env bash
# marveen-card-worktree-cleanup.sh -- remove a per-CARD marveen worktree (store/agent-worktree-
# marveen.sh --card <id>) ONLY when it is landed + idle + clean (card 0ae1166e, F4.4 of ed332869).
#
# Scope: $MARVEEN_WORKTREES/card/* only (agent worktrees, $MARVEEN_WORKTREES/<agent>, are untouched
# -- they are long-lived and have their own lifecycle). Follows the dry-run-default / --apply-needs
# --yes convention already established by store/wsl-home-cleanup.sh (rule 22): --apply additionally
# needs Peti's go-ahead each time it is actually invoked live, same operational discipline, not just
# the --yes flag.
#
# Classification per candidate:
#   LANDED  -- the branch's tip commit is an ancestor of origin/<default-branch> (same ancestry
#              check kanban-landed-guard.ts uses for the UNLANDED verdict -- git, not card_landings,
#              because a worktree can be gone before any landing row exists for a card that landed
#              via a different path, e.g. --allow-ungated).
#   IDLE    -- no live process has its cwd OR any open fd under the worktree path. Reuses the same
#              TOCTOU-safe double-check as wsl-home-cleanup.sh (classify-time scan + a FRESH re-scan
#              immediately before removal) -- that script's own B1/B1' findings (a process whose cwd
#              is elsewhere but holds an fd into the target, and the time gap between classifying and
#              removing many candidates) apply here unchanged.
#   CLEAN   -- `git status --porcelain` in the worktree is empty.
# REMOVABLE only when all three hold; otherwise SKIP with the specific reason (dirty tree, live
# process, or not landed -- in that check order, so the report names the actual blocker).
#
# Usage: marveen-card-worktree-cleanup.sh [--dry-run|--apply] [--yes]
#   --dry-run (default): classify every card worktree, print REMOVABLE/SKIP + reason, remove nothing.
#   --apply:             remove every REMOVABLE worktree + its card/<id> branch. Requires --yes.
#
# Env overrides (tests only -- production uses the real marveen checkout):
#   MARVEEN_MAIN        default /home/neon/marveen
#   MARVEEN_WORKTREES   default /home/neon/marveen-agent-worktrees
set -uo pipefail

MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"
ROOT="${MARVEEN_WORKTREES:-/home/neon/marveen-agent-worktrees}"
CARD_ROOT="$ROOT/card"

say() { echo "marveen-card-worktree-cleanup: $*"; }

# --- live-process-cwd/fd check (same approach as wsl-home-cleanup.sh scan_live_proc_targets) -----
# One /proc sweep for the whole run (cheap: ~0.1s measured there), not one per candidate; a FRESH
# sweep is taken again immediately before removing each one (TOCTOU re-check, see remove_entry).
scan_live_proc_targets() {
  find /proc -maxdepth 3 \( -path '/proc/[0-9]*/cwd' -o -path '/proc/[0-9]*/fd/*' \) \
    -printf '%l\n' 2>/dev/null
}

path_under_targets() {
  local dir="$1" targets="$2" target
  [ -n "$targets" ] || return 1
  while IFS= read -r target; do
    [ -n "$target" ] || continue
    case "$target" in
      "$dir"|"$dir"/*) return 0 ;;
    esac
  done <<< "$targets"
  return 1
}

DEFAULT_BRANCH=""

# LANDED requires BOTH: the branch tip is an ancestor of origin/<default-branch>, AND the
# worktree's own HEAD is actually that branch (not detached, not switched) -- otherwise a
# detached commit that is not on any ref would be orphaned by the removal (F2).
is_landed() {
  local path="$1" branch="$2"
  [ "$(git -C "$path" symbolic-ref -q HEAD 2>/dev/null)" = "refs/heads/$branch" ] || return 1
  git -C "$MAIN" show-ref --verify --quiet "refs/heads/$branch" || return 1
  git -C "$MAIN" merge-base --is-ancestor "$branch" "origin/$DEFAULT_BRANCH"
}

# CLEAN requires no uncommitted changes AND no ignored files outside the known symlink
# allowlist (node_modules/dist) -- `git status --porcelain` alone does not list ignored files,
# and `git worktree remove` does not refuse on them either, so without this check a landed,
# "clean" worktree can still lose real local files (.env, local DBs) on removal (F3).
is_clean() {
  local path="$1" ignored
  [ -z "$(git -C "$path" status --porcelain 2>&1)" ] || return 1
  ignored="$(git -C "$path" status --porcelain --ignored 2>&1 | grep -v -E '^!! (node_modules|dist)/?$')"
  [ -z "$ignored" ]
}

# classify PATH CARD_ID LIVE_TARGETS -> prints "REMOVABLE" or "SKIP <reason>"
classify() {
  local path="$1" card="$2" live_targets="$3"
  local branch
  branch="card/$card"
  local real_path
  real_path="$(readlink -f "$path")"
  if path_under_targets "$real_path" "$live_targets"; then
    echo "SKIP a live process has cwd/fd under this worktree"
    return
  fi
  if ! is_clean "$path"; then
    echo "SKIP uncommitted or ignored-but-untracked changes in the worktree"
    return
  fi
  if ! is_landed "$path" "$branch"; then
    echo "SKIP not landed (HEAD is not card/$card, or card/$card is not an ancestor of origin/$DEFAULT_BRANCH)"
    return
  fi
  echo "REMOVABLE"
}

remove_entry() {
  local path="$1" card="$2"
  local branch
  branch="card/$card"
  local real_path
  real_path="$(readlink -f "$path")"
  # Fresh re-check immediately before removing, same reason as wsl-home-cleanup.sh's B1': time
  # passes between classifying the first candidate and removing the Nth one.
  if path_under_targets "$real_path" "$(scan_live_proc_targets)"; then
    say "SKIP (a live process now has cwd/fd under this worktree -- re-checked at removal time): $path"
    return 1
  fi
  if ! is_clean "$path"; then
    say "SKIP (uncommitted or ignored-but-untracked changes -- re-checked at removal time): $path"
    return 1
  fi
  if ! is_landed "$path" "$branch"; then
    say "SKIP (no longer landed -- re-checked at removal time): $path"
    return 1
  fi
  say "removing: $path (branch $branch)"
  git -C "$MAIN" worktree remove --force "$path" 2>&1
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    git -C "$MAIN" branch -D "$branch" >/dev/null 2>&1
  fi
  git -C "$MAIN" worktree prune 2>/dev/null
  return "$rc"
}

main() {
  local MODE="dry-run" CONFIRMED=0 arg
  for arg in "$@"; do
    case "$arg" in
      --dry-run) MODE="dry-run" ;;
      --apply) MODE="apply" ;;
      --yes) CONFIRMED=1 ;;
      *) echo "marveen-card-worktree-cleanup: unknown argument: $arg" >&2; return 2 ;;
    esac
  done

  [ -d "$MAIN/.git" ] || { echo "marveen-card-worktree-cleanup: no marveen clone at $MAIN" >&2; return 3; }
  DEFAULT_BRANCH="$(git -C "$MAIN" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"
  [ -n "$DEFAULT_BRANCH" ] || DEFAULT_BRANCH="develop"
  git -C "$MAIN" fetch origin "$DEFAULT_BRANCH" --quiet || {
    echo "marveen-card-worktree-cleanup: could not fetch origin/$DEFAULT_BRANCH" >&2
    return 3
  }

  local live_targets removable=0 total=0
  live_targets="$(scan_live_proc_targets)"
  local removable_paths=() removable_cards=()

  [ -d "$CARD_ROOT" ] || { say "no card worktrees under $CARD_ROOT"; return 0; }

  local path card cls
  for path in "$CARD_ROOT"/*/; do
    [ -d "$path" ] || continue
    path="${path%/}"
    card="$(basename "$path")"
    total=$((total + 1))
    cls="$(classify "$path" "$card" "$live_targets")"
    printf '%-10s %s  (card %s)\n' "${cls%% *}" "$path" "$card"
    if [ "$cls" = "REMOVABLE" ]; then
      removable=$((removable + 1))
      removable_paths+=("$path")
      removable_cards+=("$card")
    else
      printf '           reason: %s\n' "${cls#* }"
    fi
  done

  say "summary: $removable of $total card worktree(s) are REMOVABLE"

  if [ "$MODE" = "dry-run" ]; then
    say "dry-run: nothing removed. Re-run with --apply --yes to remove the $removable REMOVABLE worktree(s) above."
    return 0
  fi

  if [ "$CONFIRMED" != 1 ]; then
    echo "marveen-card-worktree-cleanup: --apply requires --yes (read the --dry-run report first). Refusing." >&2
    return 2
  fi

  local removed=0 skipped=0 i
  for i in "${!removable_paths[@]}"; do
    if remove_entry "${removable_paths[$i]}" "${removable_cards[$i]}"; then
      removed=$((removed + 1))
    else
      skipped=$((skipped + 1))
    fi
  done
  say "apply done: removed=$removed skipped=$skipped"
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
  exit $?
fi
