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
# F1 (QA FAIL, card bc1e7ef2): /proc/*/cwd alone is blind to a process that was started ELSEWHERE
# but has an open file descriptor INTO the candidate dir -- e.g. a `tail -f`/log-writer/build whose
# own cwd is some other agent's worktree, redirecting its output into a dir this script is about to
# classify. QA reproduced this directly: a background `tail -f` with cwd outside the target dir, fd
# 6 pointed into it, made the dir classify DISPOSABLE and `--apply --yes` removed it while the
# process was still alive and reading the file. /proc/*/fd/* is checked for the same reason and with
# the same readlink+prefix pattern as cwd -- a live reference to the directory is a live reference,
# whichever fd slot holds it.
#
# B1' (RedHat NO-GO 16676, Gate-SHA 55c566e0): a readlink sweep over every /proc/[0-9]*/cwd and
# /proc/[0-9]*/fd/* entry is itself slow (live box: 2688-3029 open fds). The B1 fix called it once
# PER CANDIDATE from classify(), turning one run into ~249 full sweeps -- measured 2321.9s (38.7
# minutes) end to end, long enough for a process to start cwd'd into an already-classified dir
# before removal reached it. scan_live_proc_targets() now does the sweep ONCE; classify() (via
# main()) reuses a single pre-built scan for every candidate (LIVE_PROC_TARGETS_PRIMED below), and
# remove_entry() always takes its own FRESH scan immediately before deleting -- the TOCTOU
# re-check that the window above made necessary.
scan_live_proc_targets() {
  # RedHat's literal suggestion (16676) was "egy readlink -f hívás az összes útra" -- one readlink
  # -f invocation fed every /proc/[0-9]*/cwd and /proc/[0-9]*/fd/* path, instead of one `readlink`
  # fork per path (8.2s for ~2660 fds on this box). That single-invocation form IS much faster
  # (0.14s measured), but turned out unreliable here with this many arguments: measured dropping
  # ~95% of them with no error output (2740 args in, ~140-150 lines out), apparently silently,
  # even for a target proven present and stable by an independent, narrower readlink call made a
  # moment earlier -- a real finding during this card's own round-3 verification, not something
  # RedHat's note anticipated. `find`'s `-printf '%l'` reads each symlink's target with its own
  # single lstat/readlink syscall (no further canonicalization needed -- the kernel already
  # stores /proc/<pid>/cwd and fd/* as fully-resolved absolute paths, nothing nested to follow),
  # inside ONE process instead of one fork per path: same ~0.1s speed, and it reliably returned
  # every entry across repeated runs where the batched `readlink -f` call did not.
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

# Set by main() for the duration of one run (and unset again on return, via the RETURN trap
# below) -- a direct standalone call to classify()/has_live_process_under() (every selftest does
# this) falls through to its own fresh scan instead, unchanged from before.
LIVE_PROC_TARGETS_PRIMED=0
LIVE_PROC_TARGETS=""

has_live_process_under() {
  if [ "$LIVE_PROC_TARGETS_PRIMED" = 1 ]; then
    path_under_targets "$1" "$LIVE_PROC_TARGETS"
    return $?
  fi
  path_under_targets "$1" "$(scan_live_proc_targets)"
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
  # B1 (WhiteHat NO-GO 16566 on Gate-SHA 789fd6ef, MikroB decision 16567): this check used to live
  # INSIDE the `if [ -n "$owner" ]` branch below, so it only ever ran for REGISTERED worktrees. An
  # unregistered plain dir with a live process writing into it -- QA's own repro: a bare `mkdir` +
  # a `tail -f` redirected in from elsewhere, cwd outside the dir -- skipped this check entirely
  # and fell straight through to the DISPOSABLE pattern/age match, getting removed out from under
  # the still-running process. It now runs for EVERY candidate, registered or not.
  if has_live_process_under "$path"; then
    echo "ACTIVE"
    return
  fi
  local owner="${WORKTREE_OWNER[$path]:-}"
  if [ -n "$owner" ]; then
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
    # B2 (WhiteHat NO-GO 16566, MikroB decision 16567): age used to be the TOP-LEVEL dir's own
    # mtime, which does not change when a file deep inside is edited -- a dir that looked old at
    # the top could still hold content someone touched minutes ago. Age is now whether ANY file
    # anywhere inside the dir (any depth) was modified within the last $MIN_AGE_HOURS hours.
    if [ -n "$(find "$path" -mmin "-$((MIN_AGE_HOURS * 60))" -print -quit 2>/dev/null)" ]; then
      echo "UNKNOWN"
      return
    fi
    echo "DISPOSABLE"
    return
  fi
  echo "UNKNOWN"
}

# N4 (RedHat NO-GO 16676, non-blocking): predicts, without removing anything, whether remove_entry
# would skip this registered worktree (dirty / unreachable HEAD) -- so the dry-run report can say
# how many of its DISPOSABLE entries --apply would actually remove, instead of promising all of
# them and then quietly skipping some.
would_skip_removal() {
  local path="$1" owner="${WORKTREE_OWNER[$1]:-}"
  if [ -n "$owner" ]; then
    if [ -n "$(git -C "$path" status --porcelain 2>&1)" ]; then
      echo "uncommitted changes in registered worktree"
      return 0
    fi
    if [ -n "$(git -C "$path" rev-list -n1 HEAD --not --branches --remotes --tags 2>&1)" ]; then
      echo "HEAD unreachable from any branch/remote/tag"
      return 0
    fi
    return 1
  fi
  if { [ -d "$path/.git" ] || [ -f "$path/.git" ]; } && [ -n "$(git -C "$path" status --porcelain 2>&1)" ]; then
    echo "uncommitted changes in unregistered git dir"
    return 0
  fi
  return 1
}

remove_entry() {
  local path="$1" owner="${WORKTREE_OWNER[$1]:-}"

  # B1' (RedHat NO-GO 16676, Gate-SHA 55c566e0): re-verify FRESH right before deleting, ignoring
  # any classify-time cache -- the live run measured 38.7 minutes between classifying the first
  # candidate and removing the first DISPOSABLE one (249 entries), long enough for a process to
  # start with its cwd/fd pointed into an already-classified dir, or for a file inside it to be
  # written. Re-run the same two checks that made it DISPOSABLE in the first place; if either no
  # longer holds, SKIP instead of trusting the stale classification (RedHat's harness: a dir
  # classified DISPOSABLE at second 9, a process started cwd'd into it, the dir was still removed
  # at second 140 without this check).
  if path_under_targets "$path" "$(scan_live_proc_targets)"; then
    say "SKIP (a live process now has cwd/fd under this dir -- re-checked at removal time): $path"
    return 1
  fi
  if [ -n "$(find "$path" -mmin "-$((MIN_AGE_HOURS * 60))" -print -quit 2>/dev/null)" ]; then
    say "SKIP (a file under this dir was modified since classification -- re-checked at removal time): $path"
    return 1
  fi

  if [ -n "$owner" ]; then
    if [ -n "$(git -C "$path" status --porcelain 2>&1)" ]; then
      say "SKIP (uncommitted changes in registered worktree): $path"
      return 1
    fi
    # B3 (WhiteHat NO-GO 16566, MikroB decision 16567): a clean, registered worktree can still be
    # on a detached HEAD that no branch, remote-tracking ref or tag points to -- `git status
    # --porcelain` only looks at the working tree, it says nothing about this. `git worktree
    # remove --force` would turn that commit into a dangling object, recoverable only until the
    # next `git gc`. Refuse removal unless HEAD is reachable from some branch/remote/tag.
    if [ -n "$(git -C "$path" rev-list -n1 HEAD --not --branches --remotes --tags 2>&1)" ]; then
      say "SKIP (HEAD commit not reachable from any branch/remote/tag in registered worktree): $path"
      return 1
    fi
    say "removing registered worktree: $path (owner $owner)"
    git -C "$owner" worktree remove --force "$path" 2>&1
    # N5 (RedHat NO-GO 16676, non-blocking): this used to `return $?` AFTER the prune call below,
    # so a worktree remove that failed (e.g. a locked worktree) but left nothing for prune to
    # clean up reported success (prune's own exit code) while the directory was still there. Keep
    # the remove step's own exit code.
    local rc=$?
    git -C "$owner" worktree prune 2>/dev/null
    return "$rc"
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

  # B1' (RedHat NO-GO 16676): one /proc sweep for the whole classify loop below, instead of one
  # per candidate (see scan_live_proc_targets()'s comment). Unprimed again on return so a direct
  # classify() call outside main() (every selftest does this) keeps taking its own fresh scan.
  LIVE_PROC_TARGETS="$(scan_live_proc_targets)"
  LIVE_PROC_TARGETS_PRIMED=1
  trap 'rm -f "$OPEN_CARD_IDS_FILE"; LIVE_PROC_TARGETS_PRIMED=0; LIVE_PROC_TARGETS=""' RETURN

  local keep_count=0 active_count=0 disposable_count=0 removable_count=0 unknown_count=0
  local disposable_paths=() path name cls reason

  for path in "$HOME_DIR"/*/ "$HOME_DIR"/.[!.]*/; do
    [ -d "$path" ] || continue
    path="${path%/}"
    name="$(basename "$path")"
    cls=$(classify "$name" "$path")
    reason=""
    case "$cls" in
      KEEP) keep_count=$((keep_count + 1)) ;;
      ACTIVE) active_count=$((active_count + 1)) ;;
      DISPOSABLE)
        disposable_count=$((disposable_count + 1))
        disposable_paths+=("$path")
        # N4 (RedHat NO-GO 16676, non-blocking): a registered worktree that is dirty or has an
        # unreachable HEAD will be SKIPPED by remove_entry -- count it out of what --apply
        # actually removes instead of promising all DISPOSABLE entries.
        if reason=$(would_skip_removal "$path"); then
          :
        else
          removable_count=$((removable_count + 1))
        fi
        ;;
      UNKNOWN) unknown_count=$((unknown_count + 1)) ;;
    esac
    if [ -n "$reason" ]; then
      printf '%-11s %s  (apply would SKIP: %s)\n' "$cls" "$path" "$reason"
    else
      printf '%-11s %s\n' "$cls" "$path"
    fi
  done

  say "summary: KEEP=$keep_count ACTIVE=$active_count DISPOSABLE=$disposable_count UNKNOWN=$unknown_count"
  [ "$DASHBOARD_UP" = 1 ] || say "note: dashboard unreachable during this run -- every registered worktree with no live process was failed OPEN to ACTIVE (not guessed into DISPOSABLE)"

  if [ "$MODE" = "dry-run" ]; then
    say "dry-run: nothing removed. Re-run with --apply --yes to remove $removable_count of the $disposable_count DISPOSABLE entries above ($((disposable_count - removable_count)) would be SKIPPED -- see reasons above)."
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
