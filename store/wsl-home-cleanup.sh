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
#   ORPHAN      -- a DISPOSABLE candidate (name match + age gate, see below) whose .git FILE (not
#                   dir) points to a gitdir that no longer exist, AND that gitdir's own parent
#                   directory IS reachable (so this is a pruned/deleted worktree, not an unmounted
#                   filesystem making a live gitdir look missing). CYBERSEC NO-GO 39669 / QA FAIL
#                   39674 (card 9918f78d): ORPHAN used to bypass the name+age gate entirely and its
#                   removal used a bare rm -rf, skipping every TOCTOU guard DISPOSABLE removal has
#                   (live-process re-check, age re-check) -- fixed to be a refinement of DISPOSABLE,
#                   never a bypass. Removed by --apply through remove_orphan_entry() (same fresh
#                   re-check tail as remove_entry(), minus the git checks -- there is no live git
#                   state to check).
#   DISPOSABLE  -- name matches a known one-off pattern (see DISPOSABLE_PATTERNS) AND mtime is
#                   older than $MIN_AGE_HOURS hours AND it did not already classify as ACTIVE.
#   UNKNOWN     -- none of the above. Reported, never removed automatically -- a human decides.
set -uo pipefail

HOME_DIR="${WSL_HOME_CLEANUP_HOME:-/home/neon}"
MARVEEN_MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"
# shellcheck source=./env-compat-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env-compat-lib.sh"
CLEANCORE_MAIN="$(env_compat_get MOPSION_MAIN CLEANCORE_MAIN /mnt/h/LM_Studio_Workdir/mopsion)"
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

# C1 (RedHat MEDIUM, Cybered gate on 0116755a @ e3ac5b1a6, card 89e8cb90): every guard below used
# to test only git's OUTPUT (`[ -n "$(git ... 2>&1)" ]`), never its exit code. A git that dies
# silently under memory pressure or a missing binary (rc 137/127/1, no stderr) produced empty
# output, which read as "clean" -- fail OPEN exactly where the guard claims to fail closed.
# Measured: a stub git exiting 137 with no output let remove_entry delete a dirty registered
# worktree, a dirty unregistered clone, AND an unregistered clone with an unreachable HEAD.
# Capturing rc alongside output and treating ANY non-zero rc as "found a problem too" closes all
# of them with one helper, same fail-closed polarity as N2's empty-scan fix above.
git_dirty_or_failed() {
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  [ -n "$out" ] || [ "$rc" -ne 0 ]
}

# QA2 FAIL 39673 (card 9918f78d): "uncommitted changes" used to mean "git status printed ANY
# line", which counts leaked, regenerable build output (node_modules/, dist/, build/, .next/ that
# predates a .gitignore rule, or a build artifact .gitignore doesn't cover) as real, protected
# work. Every reported path is checked against these patterns; a porcelain line whose path does
# NOT match any of them means real dirt is present.
GENERATED_CONTENT_PATTERNS=(
  '(^|/)node_modules/' '(^|/)dist/' '(^|/)build/' '(^|/)\.next/'
)

# Reads `git status --porcelain` lines on stdin. Returns 0 (true) only if EVERY reported line is
# BOTH untracked ("??" -- never a tracked add/modify/delete/rename/copy/conflict) AND matches a
# generated-content pattern above -- an empty input is NOT "generated-only", it is simply not
# dirty at all, and callers only reach this after already confirming some output exists, so this
# never silently turns "nothing reported" into "safe".
#
# MikroB round-2 request (card 9918f78d): the path-only check used to wave through a TRACKED,
# modified file living under node_modules/dist/build/.next (e.g. a deliberately committed,
# patched vendor file) -- its path matches the pattern, but a tracked change is real, protected
# work regardless of where it lives. The "??" status check closes this: only genuinely untracked
# (never-committed) content gets the exception, exactly the leaked-build-output case this was
# built for.
_dirty_is_generated_only() {
  local line status path matched pat saw_any=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    saw_any=1
    status="${line:0:2}"
    [ "$status" = '??' ] || return 1
    # porcelain v1: "XY PATH" (renames: "XY OLD -> NEW" -- the NEW side is what matters)
    path="${line:3}"
    case "$path" in
      *' -> '*) path="${path#*' -> '}" ;;
    esac
    matched=0
    for pat in "${GENERATED_CONTENT_PATTERNS[@]}"; do
      [[ "$path" =~ $pat ]] && { matched=1; break; }
    done
    [ "$matched" = 1 ] || return 1
  done
  [ "$saw_any" = 1 ]
}

# Replaces the bare `git_dirty_or_failed git --no-optional-locks -C "$path" status --porcelain`
# call at all 4 sites below (would_skip_removal x2, remove_entry x2): a git FAILURE (non-zero rc)
# still fails closed unconditionally, exactly as before -- only a SUCCESSFUL call whose entire
# porcelain output matches known generated-content patterns is treated as not dirty.
worktree_dirty_for_removal() {
  local path="$1" out rc
  out="$(git --no-optional-locks -C "$path" status --porcelain 2>&1)"; rc=$?
  [ "$rc" -eq 0 ] || return 0
  [ -n "$out" ] || return 1
  printf '%s\n' "$out" | _dirty_is_generated_only && return 1
  return 0
}

# CONDITION 1 (Cybered GO 32903 on 3bcdc0a6c, card 09ed7ef6): the three `find -mmin` age re-checks
# below were still output-only (`[ -n "$(find ... -print -quit 2>/dev/null)" ]`), the same fail-OPEN
# shape C1 above just fixed for git: a find that dies silently (no stderr, non-zero rc) on a dir
# modified seconds ago produced empty output, which read as "not recently modified" -- removable.
# Same helper shape as git_dirty_or_failed: capture rc alongside output, treat ANY non-zero rc the
# same as "found a recent file" (fail closed -- SKIP/UNKNOWN, never silently "clean").
find_recent_or_failed() {
  local path="$1" out rc
  out="$(find "$path" -mmin "-$((MIN_AGE_HOURS * 60))" -print -quit 2>/dev/null)"; rc=$?
  [ -n "$out" ] || [ "$rc" -ne 0 ]
}

path_under_targets() {
  local dir="$1" targets="$2" target
  # N2 (RedHat LOW 16849): a healthy scan_live_proc_targets() is never empty (there is always at
  # least one process with a cwd), so an empty result means the scan itself failed (find missing,
  # /proc unreadable, etc.), not that nothing is live. Fail CLOSED -- treat an empty scan as "found"
  # (blocks classification/removal) instead of the previous fail-OPEN "nothing is live" default.
  [ -n "$targets" ] || return 0
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
    if find_recent_or_failed "$path"; then
      echo "UNKNOWN"
      return
    fi
    # CYBERSEC NO-GO 39669 HIGH-1 / QA FAIL 39674 / MikroB GATE-BOUNCE 39675 decision (card
    # 9918f78d): this ORPHAN check used to run BEFORE the name+age gate above, unconditionally --
    # a freshly-edited or unknown-name dir with a dangling gitdir classified ORPHAN and got removed
    # with no age/name protection at all (CYBERSEC's probe: 4 of 4 old-kept dirs became new-removed
    # regressions). Now it only RUNS inside the already-DISPOSABLE branch, as an upgrade that adds
    # information (a content listing), never as a path that skips the gate the branch is already
    # inside of.
    if [ -f "$path/.git" ]; then
      local _gitdir; _gitdir="$(grep '^gitdir:' "$path/.git" 2>/dev/null | sed 's/^gitdir: //')"
      if [ -n "$_gitdir" ]; then
        # resolve relative gitdir (git stores them relative to the worktree root)
        if [[ "$_gitdir" != /* ]]; then _gitdir="$path/$_gitdir"; fi
        # Fix-direction (c): a gitdir whose own PARENT directory is unreachable is indistinguishable
        # from an unmounted filesystem (CYBERSEC's unmounted-mopsion probe row) -- that ambiguity
        # must not resolve to "safe to delete". Only treat this as a genuine orphan when the parent
        # IS reachable (proves the filesystem is mounted) and the specific gitdir target is still
        # simply absent from it.
        local _gitdir_parent; _gitdir_parent="$(dirname "$_gitdir")"
        if [ -d "$_gitdir_parent" ] && [ ! -d "$_gitdir" ]; then
          echo "ORPHAN"
          return
        fi
      fi
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
    if worktree_dirty_for_removal "$path"; then
      echo "uncommitted changes in registered worktree"
      return 0
    fi
    if git_dirty_or_failed git -C "$path" rev-list -n1 HEAD --not --branches --remotes --tags; then
      echo "HEAD unreachable from any branch/remote/tag"
      return 0
    fi
    return 1
  fi
  if [ -d "$path/.git" ] || [ -f "$path/.git" ]; then
    if worktree_dirty_for_removal "$path"; then
      echo "uncommitted changes in unregistered git dir"
      return 0
    fi
    # N3 (RedHat LOW 16849): the registered-worktree branch above has carried the B3 unreachable-
    # HEAD guard since the previous round; the unregistered-clone branch never got it, so a clean,
    # unregistered, detached-HEAD clone was reported removable here while remove_entry's own
    # mirrored guard (below) would in fact refuse it -- same gap as 16676 N1, just the "N of M"
    # report side instead of the enforcement side.
    if git_dirty_or_failed git -C "$path" rev-list -n1 HEAD --not --branches --remotes --tags; then
      echo "HEAD unreachable from any branch/remote/tag in unregistered git dir"
      return 0
    fi
  fi
  return 1
}

# Shared TOCTOU re-check tail used by remove_entry() and remove_orphan_entry() immediately before
# the destructive call (N1, RedHat LOW 16849): a fresh live-process-under-path check and a fresh
# age/freshness re-check, run LAST so the gap between "confirmed nothing live" and the actual
# deletion stays at this check's own runtime, not the runtime of whatever git checks ran before it.
# Extracted (card 9918f78d, MikroB round-2 request) so remove_entry()'s and remove_orphan_entry()'s
# copies of this logic cannot drift apart from each other. $2 is the noun used in both SKIP
# messages ("this dir" for a registered/unregistered worktree, "this orphaned worktree" for an
# ORPHAN). Returns 0 (already said a SKIP message) when removal must be blocked, 1 when it is
# safe to proceed.
toctou_recheck_blocks_removal() {
  local path="$1" noun="${2:-this dir}"
  if path_under_targets "$path" "$(scan_live_proc_targets)"; then
    say "SKIP (a live process now has cwd/fd under $noun -- re-checked at removal time): $path"
    return 0
  fi
  if find_recent_or_failed "$path"; then
    say "SKIP (a file under $noun was modified since classification -- re-checked at removal time): $path"
    return 0
  fi
  return 1
}

remove_entry() {
  local path="$1" owner="${WORKTREE_OWNER[$1]:-}"

  if [ -n "$owner" ]; then
    # N3 (RedHat LOW 16849): git status's own side effect (refreshing the on-disk index, even in
    # --porcelain form) used to run BEFORE the N1 fresh-age re-check further down, so inspecting a
    # registered worktree's cleanliness here could itself make its .git/index look "just modified"
    # and accidentally trip that later age guard -- a false SKIP that looked like protection but was
    # really an ordering accident, not a real guard (the actual missing guard was the unregistered-
    # clone rev-list check added to would_skip_removal/below). --no-optional-locks keeps this a pure
    # read: no index write, so it can no longer feed the age re-check a false "just modified" signal.
    if worktree_dirty_for_removal "$path"; then
      say "SKIP (uncommitted changes in registered worktree): $path"
      return 1
    fi
    # B3 (WhiteHat NO-GO 16566, MikroB decision 16567): a clean, registered worktree can still be
    # on a detached HEAD that no branch, remote-tracking ref or tag points to -- `git status
    # --porcelain` only looks at the working tree, it says nothing about this. `git worktree
    # remove --force` would turn that commit into a dangling object, recoverable only until the
    # next `git gc`. Refuse removal unless HEAD is reachable from some branch/remote/tag.
    if git_dirty_or_failed git -C "$path" rev-list -n1 HEAD --not --branches --remotes --tags; then
      say "SKIP (HEAD commit not reachable from any branch/remote/tag in registered worktree): $path"
      return 1
    fi
    # N1 (RedHat LOW 16849): this fresh re-check used to run FIRST, before the two git checks
    # above -- on the live box those checks (git status/rev-list on a real worktree) measured up
    # to 12.1s, which reopened a narrow TOCTOU window between "confirmed nothing live" and the
    # actual deletion below. Moved to run LAST, immediately before the destructive call, so the
    # gap the B1' re-check is meant to close stays at the git-command's own runtime, not the
    # runtime of two git commands PLUS this check.
    if toctou_recheck_blocks_removal "$path" "this dir"; then
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
    if worktree_dirty_for_removal "$path"; then
      say "SKIP (uncommitted changes, unregistered git dir): $path"
      return 1
    fi
    # N3 (RedHat LOW 16849): mirrors the B3 guard above for an UNREGISTERED git clone -- the
    # original 16676 N1 gap (no B3-equivalent guard on this branch) stayed open through this
    # round until now.
    if git_dirty_or_failed git -C "$path" rev-list -n1 HEAD --not --branches --remotes --tags; then
      say "SKIP (HEAD commit not reachable from any branch/remote/tag, unregistered git dir): $path"
      return 1
    fi
  fi
  # N1 (RedHat LOW 16849): same reorder as the registered-worktree branch above -- fresh re-check
  # immediately before rm -rf, after any git check this branch performed, not before it.
  if toctou_recheck_blocks_removal "$path" "this dir"; then
    return 1
  fi
  say "removing: $path"
  rm -rf "$path"
}

# CYBERSEC NO-GO 39669 HIGH-1 / QA FAIL 39674 fix-direction (b) (card 9918f78d): ORPHAN removal
# used to be a bare `rm -rf` in main()'s apply loop, bypassing every TOCTOU guard remove_entry()
# has. An ORPHAN's gitdir is dead by construction, so the git status/rev-list checks remove_entry()
# runs cannot run here (there is no live git state to ask) -- but the live-process and age
# re-checks are not git-specific, and skipping them was the actual bug (not the missing git check).
# This replicates remove_entry()'s fresh-re-check TAIL only, immediately before the destructive
# call, same ordering rationale as N1 (shrink the TOCTOU window to this check's own runtime).
remove_orphan_entry() {
  local path="$1"
  if toctou_recheck_blocks_removal "$path" "this orphaned worktree"; then
    return 1
  fi
  say "removing orphaned worktree: $path"
  rm -rf "$path"
}

main() {
  # 8cb1e168 (Cybered GO 33187 on 09ed7ef6): WSL_HOME_CLEANUP_MIN_AGE_HOURS=0 or a negative value
  # makes every entry read as old regardless of its real mtime -- find_recent_or_failed() turns it
  # into `find ... -mmin -0` (or a double-negative minute count), which never matches any file, so
  # find_recent_or_failed always returns false ("not recently modified") and every DISPOSABLE-named
  # entry proceeds straight to removal, however new it actually is. A non-integer already fails
  # closed via the arithmetic in find_recent_or_failed erroring out. Refuse to run at all for any
  # value that is not a positive integer, so the failure is loud and up front, not a silent
  # miscount buried in the age check.
  # Cybered NO-GO 33289: the first cut (`''|*[!0-9]*|0`) still let two spellings of the same hole
  # through. "00"/"000" is numerically zero but matches none of those three alternatives (not
  # empty, no non-digit char, not literally "0"), so it reached the arithmetic unrefused and
  # produced the same -mmin -0 everything-is-old bug. And bash's 64-bit integer arithmetic wraps
  # silently (no overflow error) for a minute count at or above 2^63, so an all-digit value that
  # large also slipped past the old check and came out the other side of `MIN_AGE_HOURS * 60` as a
  # small/negative number. A leading-non-zero-digit, length-bounded regex closes both: at most 9
  # digits is 114,000+ years of hours, far below where the multiply-by-60 could wrap.
  if ! [[ "$MIN_AGE_HOURS" =~ ^[1-9][0-9]{0,8}$ ]]; then
    echo "wsl-home-cleanup: WSL_HOME_CLEANUP_MIN_AGE_HOURS must be a positive integer (got '$MIN_AGE_HOURS') -- refusing to run" >&2
    return 2
  fi

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

  local keep_count=0 active_count=0 disposable_count=0 removable_count=0 unknown_count=0 orphan_count=0
  local disposable_paths=() orphan_paths=() path name cls reason

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
      # card 9918f78d: orphaned worktree -- .git file present but gitdir target gone.
      # Treated as removable (no live git state), listed with contents for human review.
      ORPHAN)
        orphan_count=$((orphan_count + 1))
        orphan_paths+=("$path")
        # show up to 5 entries so the report is useful without being overwhelming
        local _n_entries; _n_entries="$(ls -A "$path" 2>/dev/null | wc -l)"
        local _first5; _first5="$(ls -A "$path" 2>/dev/null | head -5 | tr '\n' ' ')"
        reason="orphaned gitdir, ${_n_entries} entries: ${_first5}"
        ;;
      UNKNOWN) unknown_count=$((unknown_count + 1)) ;;
    esac
    if [ -n "$reason" ]; then
      printf '%-11s %s  (%s)\n' "$cls" "$path" "$reason"
    else
      printf '%-11s %s\n' "$cls" "$path"
    fi
  done

  say "summary: KEEP=$keep_count ACTIVE=$active_count DISPOSABLE=$disposable_count ORPHAN=$orphan_count UNKNOWN=$unknown_count"
  [ "$DASHBOARD_UP" = 1 ] || say "note: dashboard unreachable during this run -- every registered worktree with no live process was failed OPEN to ACTIVE (not guessed into DISPOSABLE)"

  if [ "$MODE" = "dry-run" ]; then
    say "dry-run: nothing removed. Re-run with --apply --yes to remove $removable_count of the $disposable_count DISPOSABLE + $orphan_count ORPHAN entries above ($((disposable_count - removable_count)) DISPOSABLE would be SKIPPED -- see reasons above)."
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
  # CYBERSEC NO-GO 39669 HIGH-1 (card 9918f78d): routed through remove_orphan_entry() now, not a
  # bare rm -rf -- it re-checks live-process and age immediately before deleting, same as a
  # DISPOSABLE entry gets from remove_entry().
  for path in "${orphan_paths[@]}"; do
    if remove_orphan_entry "$path"; then
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
