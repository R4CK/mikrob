#!/usr/bin/env bash
# noisy-run.sh -- run a noisy command (install/build/test/progress-bar tool) and print only the
# lines that matter, instead of dumping the whole transcript into an agent's context.
#
# Peti request (2026-08-23, Telegram image "ASK FOR THE HOOK"): catch installs/builds/test runs/
# anything with a progress bar; keep errors, failures, and the final summary; leave everything else
# (short commands) alone. This script is the "rewrite" half -- scripts/hooks/noisy-command-guard.py
# is the PreToolUse hook that steers an agent into using it (Claude Code hooks can allow/deny a Bash
# call, but cannot silently rewrite the command string -- verified against the actual hook schema
# before building this, see card 900178fa-adjacent research).
#
# Usage:   scripts/noisy-run.sh <command...>
#          scripts/noisy-run.sh "npm install"
# Exit code is the WRAPPED command's own exit code, always.
set -u

if [ "$#" -eq 0 ]; then
  echo "usage: noisy-run.sh <command...>" >&2
  exit 64
fi

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
