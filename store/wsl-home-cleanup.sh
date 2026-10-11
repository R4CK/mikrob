#!/usr/bin/env bash
# wsl-home-cleanup.sh -- classify every /home/neon top-level dir as KEEP / ACTIVE / DISPOSABLE,
# and (only with --apply) remove the DISPOSABLE ones (card bc1e7ef2, Peti request 2026-09-25).
#
# This is a REPORTING + explicit-removal tool for one-off/throwaway dirs (cc-*, marveen-land-*,
# qa-gate-*, marveen-test*, pg-e2e*, guard-probe*, marveen-v131, marveen-node_modules-pnpm-backup,
# etc.) that accumulate from land/gate/test runs and manual debugging sessions. It is DELIBERATELY
# separate from store/wsl-cleanup.sh (Peti 2026-09-01), which already auto-sweeps the narrow
# "<prefix>-<name>-$$" throwaway-land-worktree pattern plus package caches and /tmp on a schedule --
# this script does not repeat that work, it covers everything else: one-off dirs whose names don't
# follow that single pattern, surfaced for human review before anything is removed.
#
# Usage: wsl-home-cleanup.sh [--dry-run|--apply] [--yes]
#   --dry-run (default): classify and print the report, remove nothing.
#   --apply:             also remove every DISPOSABLE entry. Requires --yes (confirmation that a
#                         --dry-run report was already read) or refuses with no side effect.
#
# Classification (in this order):
#   KEEP        -- on the fixed allowlist below. Never touched, never even considered.
#   ACTIVE      -- a git worktree registered in $MARVEEN_MAIN or $CLEANCORE_MAIN's `git worktree
#                   list`, AND either a live process has its cwd under it, or it is referenced by
#                   an in_progress/waiting kanban card (branch name "agent/<x>/work", "card/<id>",
#                   or a sort_order/dir-name match against the dashboard API -- best effort; if the
#                   dashboard is unreachable, fail OPEN to ACTIVE, never to DISPOSABLE).
#   DISPOSABLE  -- name matches a known one-off pattern (see DISPOSABLE_PATTERNS) AND mtime is
#                   older than $MIN_AGE_HOURS hours AND it did not already classify as ACTIVE.
#   UNKNOWN     -- none of the above. Reported, never removed automatically -- a human decides.
set -uo pipefail

HOME_DIR="${WSL_HOME_CLEANUP_HOME:-/home/neon}"
MARVEEN_MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"
CLEANCORE_MAIN="${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/mopsion}"
MIN_AGE_HOURS="${WSL_HOME_CLEANUP_MIN_AGE_HOURS:-24}"
DASHBOARD_URL="${WSL_HOME_CLEANUP_DASHBOARD_URL:-http://localhost:3420}"
DASHBOARD_TOKEN_FILE="${WSL_HOME_CLEANUP_TOKEN_FILE:-$MARVEEN_MAIN/store/.dashboard-token}"

# Never even considered: exact top-level names, checked case-sensitively.
KEEP_NAMES=(
  marveen marveen-agent-worktrees marveen-backups marveen-gate-worktrees
  marveen-scratch-worktrees gate-worktrees
  .ollama .claude .cache .config .ssh .gnupg .npm .pnpm-store .local .nvm
  .bash_history .bash_logout .bashrc .profile .bash_profile .gitconfig
  .update-history
)

DISPOSABLE_PATTERNS=(
  '^cc-' '^marveen-land-' '^qa-gate-' '^qa-' '^pg-e2e' '^guard-probe'
  '^scratch' '^marveen-test' '^marveen-qa-test' '^marveen-v131'
  '^marveen-node_modules-pnpm-backup$' '^mv-pool-probe' '^marveen-flaky$'
  '^marveen-port-check-' '^marveen-reconcile$' '^marveen-canary$'
  '^marveen-fazis2-' '^marveen-upstream-' '^be2-mutate$' '^marveen-landing$'
  '^marveen-5f00664c$'
)

say() { echo "wsl-home-cleanup: $*"; }

matches_any() {
  local name="$1"; shift
  local pat
  for pat in "$@"; do
    [[ "$name" =~ $pat ]] && return 0
  done
  return 1
}

is_keep() {
  local name="$1" k
  for k in "${KEEP_NAMES[@]}"; do
    [ "$name" = "$k" ] && return 0
  done
  return 1
}

# --- registered-worktree lookup ------------------------------------------------------------
declare -A WORKTREE_OWNER      # exact worktree path -> owning repo
declare -A HAS_ACTIVE_CHILD    # top-level dir path -> 1, if ANY registered worktree lives under it
load_worktrees() {
  local repo="$1" wt top
  [ -d "$repo/.git" ] || [ -f "$repo/.git" ] || return 0
  while read -r wt; do
    [ -n "$wt" ] || continue
    WORKTREE_OWNER["$wt"]="$repo"
    # mark the top-level /home/neon/<dir> this worktree lives UNDER, only when the worktree is
    # NESTED (gate-worktrees/gate-qa-..., marveen-scratch-worktrees/f5-cutover, ...) -- that
    # top-level dir is a CONTAINER for other registered worktrees and must never be bulk-removed.
    # A worktree that IS ITSELF the top-level dir (the common case, e.g. cc-inspect-mikrob) must
    # NOT set this: it needs the ordinary owner/live-process/card-reference checks below, not an
    # unconditional ACTIVE that would also protect it when stale and unreferenced.
    case "$wt" in
      "$HOME_DIR"/*/*)
        top="${wt#"$HOME_DIR"/}"
        top="${top%%/*}"
        HAS_ACTIVE_CHILD["$HOME_DIR/$top"]=1
        ;;
    esac
  done < <(git -C "$repo" worktree list --porcelain 2>/dev/null | awk '/^worktree/{print $2}')
}

# --- live-process-cwd check -----------------------------------------------------------------
has_live_process_under() {
  local dir="$1" link target
  for link in /proc/[0-9]*/cwd; do
    target=$(readlink -f "$link" 2>/dev/null) || continue
    case "$target" in
      "$dir"|"$dir"/*) return 0 ;;
    esac
  done
  return 1
}

# --- kanban in_progress/waiting reference check (best-effort, fail OPEN to ACTIVE) ---------
dashboard_reachable() {
  [ -f "$DASHBOARD_TOKEN_FILE" ] || return 1
  printf 'Authorization: Bearer %s\n' "$(cat "$DASHBOARD_TOKEN_FILE")" \
    | curl -s -H @- -o /dev/null -w '%{http_code}' --max-time 3 "$DASHBOARD_URL/api/kanban" 2>/dev/null \
    | grep -q '^200$'
}

OPEN_CARD_IDS_FILE=""
load_open_card_ids() {
  OPEN_CARD_IDS_FILE=$(mktemp)
  printf 'Authorization: Bearer %s\n' "$(cat "$DASHBOARD_TOKEN_FILE")" \
    | curl -s -H @- --max-time 5 "$DASHBOARD_URL/api/kanban" 2>/dev/null \
    | python3 -c "
import json, sys
try:
    cards = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for c in cards:
    if c.get('status') in ('in_progress', 'waiting') and c.get('id'):
        print(c['id'])
" > "$OPEN_CARD_IDS_FILE" 2>/dev/null
}

referenced_by_open_card() {
  local name="$1"
  [ -s "$OPEN_CARD_IDS_FILE" ] || return 1
  local cid
  while read -r cid; do
    [ -n "$cid" ] || continue
    case "$name" in
      *"$cid"*) return 0 ;;
    esac
  done < "$OPEN_CARD_IDS_FILE"
  return 1
}

DASHBOARD_UP=0

classify() {
  local name="$1" path="$2"
  if is_keep "$name"; then
    echo "KEEP"
    return
  fi
  if [ "${HAS_ACTIVE_CHILD[$path]:-0}" = 1 ]; then
    # a registered worktree lives somewhere under this dir (e.g. gate-worktrees/gate-qa-...,
    # marveen-scratch-worktrees/f5-cutover) -- a bulk rm here would destroy it outside git's
    # own bookkeeping. Never DISPOSABLE/UNKNOWN; always ACTIVE, regardless of the name pattern.
    echo "ACTIVE"
    return
  fi
  local owner="${WORKTREE_OWNER[$path]:-}"
  if [ -n "$owner" ]; then
    if has_live_process_under "$path"; then
      echo "ACTIVE"
      return
    fi
    if [ "$DASHBOARD_UP" = 1 ]; then
      if referenced_by_open_card "$name"; then
        echo "ACTIVE"
        return
      fi
    else
      # dashboard unreachable: fail open, never guess a registered worktree into DISPOSABLE
      echo "ACTIVE"
      return
    fi
  fi
  if matches_any "$name" "${DISPOSABLE_PATTERNS[@]}"; then
    local now mtime age_h
    now=$(date +%s)
    mtime=$(stat -c %Y "$path" 2>/dev/null || echo "$now")
    age_h=$(( (now - mtime) / 3600 ))
    if [ "$age_h" -ge "$MIN_AGE_HOURS" ]; then
      echo "DISPOSABLE"
      return
    fi
    echo "UNKNOWN"
    return
  fi
  echo "UNKNOWN"
}

remove_entry() {
  local path="$1" owner="${WORKTREE_OWNER[$1]:-}"
  if [ -n "$owner" ]; then
    if [ -n "$(git -C "$path" status --porcelain 2>&1)" ]; then
      say "SKIP (uncommitted changes in registered worktree): $path"
      return 1
    fi
    say "removing registered worktree: $path (owner $owner)"
    git -C "$owner" worktree remove --force "$path" 2>&1
    git -C "$owner" worktree prune 2>/dev/null
    return $?
  fi
  if [ -d "$path/.git" ] || [ -f "$path/.git" ]; then
    if [ -n "$(git -C "$path" status --porcelain 2>&1)" ]; then
      say "SKIP (uncommitted changes, unregistered git dir): $path"
      return 1
    fi
  fi
  say "removing: $path"
  rm -rf "$path"
}

main() {
  local MODE="dry-run" CONFIRMED=0 arg
  for arg in "$@"; do
    case "$arg" in
      --dry-run) MODE="dry-run" ;;
      --apply) MODE="apply" ;;
      --yes) CONFIRMED=1 ;;
      *) echo "wsl-home-cleanup: unknown argument: $arg" >&2; return 2 ;;
    esac
  done

  load_worktrees "$MARVEEN_MAIN"
  load_worktrees "$CLEANCORE_MAIN"
  dashboard_reachable && { DASHBOARD_UP=1; load_open_card_ids; }
  [ -n "$OPEN_CARD_IDS_FILE" ] && trap 'rm -f "$OPEN_CARD_IDS_FILE"' RETURN

  local keep_count=0 active_count=0 disposable_count=0 unknown_count=0
  local disposable_paths=() path name cls

  for path in "$HOME_DIR"/*/ "$HOME_DIR"/.[!.]*/; do
    [ -d "$path" ] || continue
    path="${path%/}"
    name="$(basename "$path")"
    cls=$(classify "$name" "$path")
    case "$cls" in
      KEEP) keep_count=$((keep_count + 1)) ;;
      ACTIVE) active_count=$((active_count + 1)) ;;
      DISPOSABLE) disposable_count=$((disposable_count + 1)); disposable_paths+=("$path") ;;
      UNKNOWN) unknown_count=$((unknown_count + 1)) ;;
    esac
    printf '%-11s %s\n' "$cls" "$path"
  done

  say "summary: KEEP=$keep_count ACTIVE=$active_count DISPOSABLE=$disposable_count UNKNOWN=$unknown_count"
  [ "$DASHBOARD_UP" = 1 ] || say "note: dashboard unreachable during this run -- every registered worktree with no live process was failed OPEN to ACTIVE (not guessed into DISPOSABLE)"

  if [ "$MODE" = "dry-run" ]; then
    say "dry-run: nothing removed. Re-run with --apply --yes to remove the $disposable_count DISPOSABLE entries above."
    return 0
  fi

  if [ "$CONFIRMED" != 1 ]; then
    echo "wsl-home-cleanup: --apply requires --yes (read the --dry-run report first). Refusing." >&2
    return 2
  fi

  local removed=0 skipped=0
  for path in "${disposable_paths[@]}"; do
    if remove_entry "$path"; then
      removed=$((removed + 1))
    else
      skipped=$((skipped + 1))
    fi
  done
  say "apply done: removed=$removed skipped=$skipped"
}

# Only auto-run when executed, never when sourced (the selftest sources this file to call classify()
# and friends directly, the way mopsion-bundle-check.sh's selftest already does for that script).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
  exit $?
fi
