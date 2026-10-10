#!/usr/bin/env bash
# noisy-run.sh -- run a noisy command (install/build/test/progress-bar tool) and print only the
# lines that matter, instead of dumping the whole transcript into an agent's context.
#
# Peti request (2026-08-23, Telegram image "ASK FOR THE HOOK"): catch installs/builds/test runs/
# anything with a progress bar; keep errors, failures, and the final summary; leave everything else
# (short commands) alone. This script is the "rewrite" half -- scripts/hooks/noisy-command-guard.py
# is the PreToolUse hook that steers an agent into using it, either by blocking and suggesting this
# wrapper (default, NOISY_GUARD_MODE=block) or by transparently substituting it via
# hookSpecificOutput.updatedInput (opt-in, NOISY_GUARD_MODE=rewrite -- card fc3a6a39, 2026-10-10).
#
# Usage:   scripts/noisy-run.sh <command...>
#          scripts/noisy-run.sh "npm install"
# Exit code is the WRAPPED command's own exit code, always.
#
# SMALL-OUTPUT SKIP (card fc3a6a39 item 3). Measured 2026-09-25 (18db137d/8cb87717): `git status`
# through this wrapper was +84% BYTES vs raw, because the "=== noisy-run ===" / "exit=" / "-- final
# N lines --" header costs more than the thin output it wraps. Below NOISY_RUN_SMALL_LINES lines AND
# NOISY_RUN_SMALL_BYTES bytes, print the raw output byte-for-byte, no header -- the thing being
# "noisy" is the SIZE, not the command shape, so a small run of a normally-noisy command is left
# alone exactly like noisy-command-guard.py already leaves short UNRELATED commands alone.
#
# git log/diff --stat PARTIAL-KEEP (card fc3a6a39 item 4). Measured: the error/fail/warn grep below
# finds nothing in a plain file-stat listing (no error-shaped lines), and `tail -n 20` keeps only the
# LAST 20 lines -- for `git log --stat` that drops nearly every commit except the oldest shown
# (-93%, lossy: the newest, most relevant commits are the ones it throws away, since git log prints
# newest-first). Detected by command shape (git log|diff ... --stat), kept as the HEAD of the output
# (where git already put the newest/most relevant entries) plus the total line count, instead of the
# generic error-line/tail-20 shape.
set -u

if [ "$#" -eq 0 ]; then
  echo "usage: noisy-run.sh <command...>" >&2
  exit 64
fi

SMALL_LINES="${NOISY_RUN_SMALL_LINES:-25}"
SMALL_BYTES="${NOISY_RUN_SMALL_BYTES:-3000}"
STAT_HEAD_LINES="${NOISY_RUN_STAT_HEAD_LINES:-60}"

LOG_DIR="${NOISY_RUN_LOG_DIR:-/tmp/claude-noisy-logs}"
mkdir -p "$LOG_DIR" 2>/dev/null
STAMP="$(date +%Y%m%d-%H%M%S)-$$"
LOG_FILE="$LOG_DIR/$STAMP.log"

# Run the real command, full output captured to the log file. `script` would preserve a TTY (some
# tools only show a progress bar with one), but is not on every box -- plain redirection is the
# portable baseline and is what matters for the filtering below.
"$@" >"$LOG_FILE" 2>&1
STATUS=$?

TOTAL_LINES=$(wc -l < "$LOG_FILE" 2>/dev/null | tr -d ' ')
TOTAL_LINES="${TOTAL_LINES:-0}"
TOTAL_BYTES=$(wc -c < "$LOG_FILE" 2>/dev/null | tr -d ' ')
TOTAL_BYTES="${TOTAL_BYTES:-0}"

if [ "$TOTAL_LINES" -le "$SMALL_LINES" ] && [ "$TOTAL_BYTES" -le "$SMALL_BYTES" ]; then
  cat "$LOG_FILE" 2>/dev/null
  exit "$STATUS"
fi

# "$*" is a search target only, never executed -- the actual command already ran as "$@" above.
IS_STAT_LISTING=0
case " $* " in
  *" log "*--stat*|*" log --stat"*|*" diff "*--stat*|*" diff --stat"*) IS_STAT_LISTING=1 ;;
esac

if [ "$IS_STAT_LISTING" -eq 1 ]; then
  HEAD_LINES=$(head -n "$STAT_HEAD_LINES" "$LOG_FILE" 2>/dev/null)
  echo "=== noisy-run: $* ==="
  echo "exit=$STATUS  full-log=$TOTAL_LINES lines -> $LOG_FILE"
  echo
  echo "-- first $STAT_HEAD_LINES lines (git already orders these newest/most-relevant first) --"
  echo "$HEAD_LINES"
  echo
  echo "(full output kept at $LOG_FILE if you need more)"
  exit "$STATUS"
fi

# What matters: error/fail/warn-shaped lines (case-insensitive), deduped in order, capped so one
# repeating warning can't reproduce the same noise problem this script exists to prevent.
MATTER_LINES=$(grep -iE 'error|fail|fatal|exception|warn|deprecat|vulnerab|cannot|denied|refused|✗|✖' "$LOG_FILE" 2>/dev/null | head -100)
TAIL_LINES=$(tail -n 20 "$LOG_FILE" 2>/dev/null)

echo "=== noisy-run: $* ==="
echo "exit=$STATUS  full-log=$TOTAL_LINES lines -> $LOG_FILE"
echo

if [ -n "$MATTER_LINES" ]; then
  echo "-- error/fail/warn lines --"
  echo "$MATTER_LINES"
  echo
fi

echo "-- final $(echo "$TAIL_LINES" | wc -l | tr -d ' ') lines --"
echo "$TAIL_LINES"
echo
echo "(full output kept at $LOG_FILE if you need more)"

exit "$STATUS"
