#!/bin/bash
# Gemini fallback runner wrapper (card 5f5409fd).
# Called by the gemini-fallback-runner scheduled task every 15 minutes.
# Runs the compiled runner against the real store/ state files.
set -u
ROOT="/home/neon/marveen"
LOG="$ROOT/store/gemini-fallback-runner.log"
RUNNER="$ROOT/dist/gemini-fallback-runner.js"

if [ ! -f "$RUNNER" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') SKIP: $RUNNER not found (build needed)" >> "$LOG"
  exit 0
fi

cd "$ROOT"
node "$RUNNER" >> "$LOG" 2>&1
STATUS=$?
if [ $STATUS -ne 0 ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') EXIT=$STATUS" >> "$LOG"
fi
exit $STATUS
