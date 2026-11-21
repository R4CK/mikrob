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
# INFO (card e2425f05, scope extension comment 33299, Cybered GO 33297 on 8cb1e168): neither knob
# had an integer guard -- both feed a `[ "$age_min" -ge "$MIN_AGE_MIN" ]`/find -mmin comparison, so
# a non-numeric value throws a shell "integer expression expected" error (MIN_AGE_MIN) or makes
# find silently treat the whole expression as invalid (TMP_MIN_AGE_MIN), either way an unclear
# failure far from the actual bad input. Same guard shape MikroB specified (^[1-9][0-9]{0,8}$, no
# bare 0): 0 is itself dangerous here, not just a weird edge case -- it means "every entry is old
# enough", the exact same all-fresh-considered-old bug class WSL_HOME_CLEANUP_MIN_AGE_HOURS=0 was
# fixed for on card 8cb1e168, so 0 is refused like any other invalid value, not accepted.
if ! [[ "$MIN_AGE_MIN" =~ ^[1-9][0-9]{0,8}$ ]]; then
  echo "wsl-cleanup: WSL_CLEANUP_MIN_AGE_MIN='$MIN_AGE_MIN' is not a positive integer -- falling back to the documented default (120)" >&2
  MIN_AGE_MIN=120
fi
if ! [[ "$TMP_MIN_AGE_MIN" =~ ^[1-9][0-9]{0,8}$ ]]; then
  echo "wsl-cleanup: WSL_CLEANUP_TMP_MIN_AGE_MIN='$TMP_MIN_AGE_MIN' is not a positive integer -- falling back to the documented default (2880)" >&2
  TMP_MIN_AGE_MIN=2880
fi

MARVEEN_MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"
# env-overridable (default unchanged) so a selftest can point the /tmp sweep at a throwaway
# sandbox dir instead of the real /tmp -- same pattern as MARVEEN_MAIN/CLEANCORE_MAIN above.
WSL_CLEANUP_TMP_DIR="${WSL_CLEANUP_TMP_DIR:-/tmp}"
# shellcheck source=./env-compat-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env-compat-lib.sh"
CLEANCORE_MAIN="$(env_compat_get MOPSION_MAIN CLEANCORE_MAIN /mnt/h/LM_Studio_Workdir/mopsion)"

say() { echo "wsl-cleanup: $*"; }
run() { if [ "$DRY_RUN" = 1 ]; then echo "  [dry-run] $*"; else eval "$@"; fi; }
# run_argv: like run(), but NEVER goes through a shell (no eval, no re-tokenizing, no globbing) --
# use for any command built from a DYNAMIC, filesystem-derived name (a git worktree path, a /tmp
# entry). Cybered NO-GO (card c9c1f159, comment 32973): run()'s eval treated a name like
# `x';touch PWNED;echo '` as a second injected command, and a newline inside a name split one
# entry into an unrelated argument once eval re-tokenized the string. Passing argv straight to
# "$@" never re-parses it, so neither shell metacharacters nor an embedded newline in a single
# argument can inject or split anything.
run_argv() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# Same flaw and fix as store/wsl-home-cleanup.sh's git_dirty_or_failed() (card 89e8cb90): the
# guard below used to test only git's OUTPUT, never its exit code -- a git that dies silently
# (rc 137/127/1, no stderr) produced empty output, which read as "clean", removing a dirty
# worktree. Capturing rc alongside output and treating ANY non-zero rc as "found a problem too"
# closes that hole. This script runs unattended daily, so the exposure is live (card 6c41214a).
GIT_DIRTY_OR_FAILED_RC=0
git_dirty_or_failed() {
  local out
  out="$("$@" 2>&1)"; GIT_DIRTY_OR_FAILED_RC=$?
  [ -n "$out" ] || [ "$GIT_DIRTY_OR_FAILED_RC" -ne 0 ]
}

freed_worktrees=0
skipped_dirty=0
skipped_git_rc=0
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
    # ISDIR guard (DOCUMENTED, not pinned -- equivalent mutant, Cybered LOW, card c9c1f159,
    # comment 32973 condition 3): a registered-but-missing worktree (deleted by hand, left
    # prunable) is already caught downstream, with or without this line -- git_dirty_or_failed
    # below runs `git -C "$wt" status --porcelain` against the nonexistent path, which fails with
    # a non-zero rc, landing on the "SKIP (git rc=...)" branch either way. Measured by hand:
    # removing this line left the full selftest suite green. Kept anyway as a cheap, explicit
    # short-circuit -- it means a missing-directory entry never reaches `git -C`, `stat`, or the
    # kill/age checks below at all -- but a fixture that only has git's own rc path to distinguish
    # presence from absence would just assert a tautology, so it is not force-pinned.
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
    if git_dirty_or_failed git -C "$wt" status --porcelain; then
      if [ "$GIT_DIRTY_OR_FAILED_RC" -ne 0 ]; then
        say "SKIP (git rc=$GIT_DIRTY_OR_FAILED_RC): $wt"
        # Cybered LOW (card c9c1f159, on top of 6c41214a's fix): a silently-failing git and a
        # genuinely dirty worktree are different signals for whoever reads the summary line (one
        # is "git itself is broken", the other is "there's real uncommitted work") -- counted
        # separately instead of folding the rc case into skipped_dirty.
        skipped_git_rc=$((skipped_git_rc + 1))
      else
        say "SKIP (uncommitted changes): $wt"
        skipped_dirty=$((skipped_dirty + 1))
      fi
      continue
    fi
    say "removing throwaway worktree: $wt (age ${age_min}m)"
    run_argv git -C "$repo" worktree remove --force "$wt"
    freed_worktrees=$((freed_worktrees + 1))
  done < <(git -C "$repo" worktree list --porcelain 2>/dev/null | awk '/^worktree/{print $2}')
}

# Sections 1/2/3/4 below are the actual sweep, run ONLY when this file is executed directly
# (`bash wsl-cleanup.sh`), never when it is `source`d. A selftest sources it to reach a function
# (e.g. sweep_tmp) in total isolation -- with DRY_RUN=0, for a real, non-dry-run assertion that a
# quote-injection or newline name cannot inject a command or escape to a relative path (Cybered
# NO-GO, card c9c1f159, comment 32973) -- without also running the package-cache purges or the
# root-owned-cache section, which have no WSL_CLEANUP_TMP_DIR-style sandbox knob and would touch
# the real machine's caches.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then

sweep_throwaway_worktrees "$MARVEEN_MAIN" '^/home/neon/marveen-land-[a-zA-Z0-9]+-[0-9]+$'
sweep_throwaway_worktrees "$CLEANCORE_MAIN" '^/home/neon/cc-land(-base)?-[a-zA-Z0-9]+-[0-9]+$'

run "git -C '$MARVEEN_MAIN' worktree prune 2>/dev/null"
run "git -C '$CLEANCORE_MAIN' worktree prune 2>/dev/null"

say "throwaway worktrees removed: $freed_worktrees, skipped (uncommitted): $skipped_dirty, skipped (git rc): $skipped_git_rc, skipped (live pid): $skipped_live_pid"

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

fi # end of direct-execution guard (reopened below, after the section-3 function definitions)

# --- 3. /tmp: entries untouched for TMP_MIN_AGE_MIN, excluding system paths -------------
# MEDIUM (Cybered GO 32928 on 6c41214a, card c9c1f159): the old single `find ... -mmin +N -exec
# rm -rf` judged age from the TOP-LEVEL entry's own mtime only. A directory whose top mtime is
# old but holds a file written seconds ago (e.g. a long-running test's scratch dir, touched only
# once at creation) got removed mid-use. Fix: for a directory candidate, also check whether
# anything INSIDE it is fresher than the threshold, and skip removal if so, or if that inner
# check itself fails (fail closed -- an unreadable subtree is not evidence of staleness).
tmp_inner_fresh_or_failed() {
  local out rc
  out="$(find "$1" -mmin "-$TMP_MIN_AGE_MIN" -print -quit 2>&1)"; rc=$?
  [ -n "$out" ] || [ "$rc" -ne 0 ]
}

sweep_tmp() {
  # SANITY guard (Cybered LOW, card c9c1f159, comment 32973 condition 4): WSL_CLEANUP_TMP_DIR is
  # an env-only knob, read from the same scheduler env this job itself runs under -- nothing
  # stopped it from pointing the "mindepth 1 -maxdepth 1 ... rm -rf" sweep at /, /home or $HOME.
  # Only the real /tmp, or a path actually UNDER /tmp (a test's own disposable sandbox dir), may
  # be swept.
  # Cybered GO 33173 (card 657f12a3): the check above was LEXICAL -- a value shaped like
  # "<under /tmp>/x/../outer" matched the /tmp/* string pattern even though it resolves OUTSIDE
  # /tmp, so the sweep would run against a directory this guard was supposed to block. Resolve
  # with realpath FIRST, require the RESOLVED path to be exactly /tmp or start with /tmp/ (slash
  # included, so "/tmpfoo" is rejected too), and sweep the resolved path itself so what gets
  # checked is exactly what gets enumerated/removed.
  # LOW fail-open (Cybered GO 33287 on 657f12a3): a realpath FAILURE (rc 1/127/137/139 -- missing
  # binary, killed, OOM) fell back to the RAW, unresolved value, which is exactly the lexical
  # string this guard exists to stop trusting -- the traversal-escape case this guard is meant to
  # block (measured dry-run: 4/4) passes straight through on a realpath failure. Fail CLOSED
  # instead: a realpath failure refuses the sweep, the same as a resolved path outside /tmp.
  local resolved
  if ! resolved="$(realpath -m -- "$WSL_CLEANUP_TMP_DIR" 2>/dev/null)"; then
    say "REFUSING /tmp sweep: realpath failed to resolve WSL_CLEANUP_TMP_DIR='$WSL_CLEANUP_TMP_DIR' -- not trusting the raw value"
    return 1
  fi
  case "$resolved" in
    /tmp|/tmp/*) ;;
    *)
      say "REFUSING /tmp sweep: WSL_CLEANUP_TMP_DIR='$WSL_CLEANUP_TMP_DIR' resolves to '$resolved', not /tmp or under /tmp/"
      return 1
      ;;
  esac
  WSL_CLEANUP_TMP_DIR="$resolved"
  local entry name mtime now age_min entry_q
  now=$(date +%s)
  local removed=0 skipped_fresh_inner=0 skipped_stat=0 skipped_rm_failed=0
  # NUL-delimited (-print0 / read -r -d ''), not newline-delimited: a /tmp entry's name is
  # attacker-reachable (any local process can create one), and a newline inside a name would
  # otherwise split one entry into two read() iterations -- the second one a bogus, usually
  # relative fragment that still reached `rm -rf` (Cybered NO-GO, card c9c1f159, comment 32973).
  while IFS= read -r -d '' entry; do
    name="$(basename "$entry")"
    # NAME-PATTERN guard: X11/font/ICE unix-socket dirs other live sessions depend on.
    case "$name" in
      .X11-unix|.font-unix|.ICE-unix) continue ;;
    esac
    # STAT guard: an entry that vanished mid-sweep (TOCTOU) or that stat can't read is not
    # evidence of staleness -- skip it rather than treat the failed read as "ancient".
    mtime="$(stat -c %Y "$entry" 2>/dev/null)" || { skipped_stat=$((skipped_stat + 1)); continue; }
    age_min=$(( (now - mtime) / 60 ))
    # AGE guard: only entries old enough at the top level are even candidates.
    [ "$age_min" -ge "$TMP_MIN_AGE_MIN" ] || continue
    # ISDIR guard: the inner-freshness check only means something for a directory -- a plain
    # file's own mtime (already checked above) IS its content.
    if [ -d "$entry" ] && tmp_inner_fresh_or_failed "$entry"; then
      skipped_fresh_inner=$((skipped_fresh_inner + 1))
      continue
    fi
    # 657f12a3 (Cybered GO 33173): removed was incremented unconditionally -- a failed rm (e.g.
    # permission denied, or the entry vanishing again between the checks above and this call) was
    # still counted as "removed", making the summary line claim a cleanup that did not happen.
    if run_argv rm -rf -- "$entry"; then
      removed=$((removed + 1))
    else
      skipped_rm_failed=$((skipped_rm_failed + 1))
      # LOW log-line forgery (Cybered GO 33287 on 657f12a3): $entry is an attacker-reachable
      # name (anyone can create a /tmp entry) and `say` uses plain `echo` -- a newline or control
      # char inside the name would print as literal bytes, letting a crafted name forge what
      # looks like a second, unrelated log line. %q quotes it into a single shell-safe token.
      printf -v entry_q '%q' "$entry"
      say "rm failed for $entry_q"
    fi
  done < <(find "$WSL_CLEANUP_TMP_DIR" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)
  say "/tmp sweep: removed $removed, skipped (fresh inner file): $skipped_fresh_inner, skipped (stat failed): $skipped_stat, skipped (rm failed): $skipped_rm_failed"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then

sweep_tmp

# --- 4. root-owned caches, best-effort only (never blocks on a password prompt) ---------
if sudo -n true 2>/dev/null; then
  run "sudo -n journalctl --vacuum-time=7d >/dev/null 2>&1"
  run "sudo -n apt-get clean >/dev/null 2>&1"
else
  say "no passwordless sudo -- skipping journalctl/apt cleanup (safe no-op)"
fi

say "done"

fi # end of direct-execution guard
