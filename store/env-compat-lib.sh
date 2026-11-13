#!/usr/bin/env bash
# env_compat_get -- single source for "read the new env-var name first, fall back to the retired
# CleanCore name with a one-time warning, else a default" (card 22835648, Rename 1/3 of the
# CleanCore-name retirement, Peti 2026-10-11 Telegram 11045/11048, approved 11048).
#
# WHY A SHARED HELPER. The card's own measurement: 22 CLEANCORE_* env names, 324 occurrences, 71
# files. Hand-duplicating "new wins, old falls back with a warning, else default" in each read
# site would be 71 near-identical copies that drift the moment one of them is edited without the
# others -- the exact shape this fork's own CLAUDE.md names as the thing to avoid (shared logic
# lives in one place, like landing-gate-verdict-check.sh or kanban-comment-lib.sh).
#
# Usage:
#   . "$(dirname "$0")/env-compat-lib.sh"   # or the absolute store/ path
#   VALUE="$(env_compat_get MIKROB_SUITE_SLOTS CLEANCORE_SUITE_SLOTS 2)"
#
# Precedence: NEW var wins if set to a non-empty value; else the OLD (retired) var, with a warning
# to stderr; else the given default (or empty string if omitted).
#
# WARNING FREQUENCY: one line per CALL that actually falls back, not de-duplicated across calls.
# A per-process "warn once" cache was tried and dropped: this function's natural call shape is
# `VAR="$(env_compat_get ...)"`, a command SUBSTITUTION, which forks a subshell -- any state the
# function set would die with that subshell on the very next call, so a real de-dup needs a
# tempfile-plus-cleanup mechanism to survive across calls, which is real complexity for a
# requirement ("egyszeri figyelmeztetés", card 22835648) that a NORMAL caller already satisfies
# without it: a script calls this once per variable per run, so one call -> one warning IS one
# warning. A caller that genuinely loops over the same var many times gets one warning per loop
# iteration, which is still a correctness non-issue (same stderr line, not a spec violation) and
# not a shape any current call site has.
#
# This round (step 1 of the card's own 3) only adds the new-name-first reads with a fallback --
# it does NOT remove any CLEANCORE_* variable's meaning, and does NOT touch file names, skills or
# CLAUDE.md text (steps 2 and 3, explicitly out of scope here per the parent FÁZIS d3191c84).
set -u

env_compat_get() {
  local new_name="$1" old_name="$2" default_val="${3:-}"
  local new_val old_val
  new_val="$(eval "printf '%s' \"\${${new_name}:-}\"")"
  if [ -n "$new_val" ]; then
    printf '%s' "$new_val"
    return 0
  fi
  old_val="$(eval "printf '%s' \"\${${old_name}:-}\"")"
  if [ -n "$old_val" ]; then
    echo "env-compat: \$$old_name is deprecated, use \$$new_name instead (still honoured as a fallback)" >&2
    printf '%s' "$old_val"
    return 0
  fi
  printf '%s' "$default_val"
}
