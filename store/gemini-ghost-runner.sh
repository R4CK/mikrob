#!/bin/bash
# Gemini Ghost runner (card 612058c2).
#
# WHY THIS EXISTS: the cf757409 Gemini-fallback pipeline (route decision -> card ordering ->
# local-LLM draft -> Gemini first-pass review, store/run-gemini-fallback.sh + dist/gemini-
# orchestrator*.js) is only ever DRIVEN by MikroB's own heartbeat/scheduled-task prompts -- and a
# scheduled-task prompt lands in MikroB's tmux pane, which does nothing while MikroB itself is
# frozen on the Claude usage limit (quota-bridge.py's Ghost mode). During a session-level quota
# outage nothing else alive drives that pipeline at all. This script is that driver: started by
# quota-bridge.py's outage_loop() the moment an outage is confirmed, killed the moment recovery is
# detected. It builds NOTHING new -- every step below is an EXISTING entry point, called exactly
# as MikroB's own heartbeat would call it.
#
# HOURLY CAP, CALL-LEVEL NOT TICK-LEVEL (card 612058c2 delta-gate, WhiteHat2 NO-GO H1 @c5e5ec28):
# this script used to count its own TICKS against scripts/seged-hivo.py's shared log and skip a
# tick once 5/hour had run. That was wrong on measurement: a single tick's dist/gemini-
# orchestrator-draft-review.js step reviews EVERY eligible card carrying a draft in one pass (live
# DB measured ~160 MikroB-project cards), each review a REAL Gemini network call -- "5 ticks/hour"
# did not bound "5 real calls/hour" at all. The cap now lives INSIDE the pipeline itself
# (src/gemini-ghost-budget.ts's reserveGhostCallSlot(), called by gemini-orchestrator.ts's ranking
# call and gemini-orchestrator-draft-review.ts's per-card review call, right before each real
# network call) against the SAME shared counter store/gemini-agy-call.sh uses -- not a second one.
# This script therefore runs every tick unconditionally; the pipeline itself decides, call by
# call, whether the shared budget still has room.
set -euo pipefail
ROOT="${MARVEEN_ROOT:-/home/neon/marveen}"
STORE="$ROOT/store"
TICK_INTERVAL_S="${GEMINI_GHOST_TICK_INTERVAL_S:-300}"
LOG="$STORE/gemini-ghost-runner.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$LOG"; }

run_tick() {
  log "RUN tick"
  local status="ok"
  bash "$STORE/run-gemini-fallback.sh" >>"$LOG" 2>&1 || status="hiba(fallback-runner)"
  node "$ROOT/dist/gemini-orchestrator.js" >>"$LOG" 2>&1 || status="hiba(orchestrator)"
  node "$ROOT/dist/gemini-orchestrator-draft.js" >>"$LOG" 2>&1 || status="hiba(draft)"
  node "$ROOT/dist/gemini-orchestrator-draft-review.js" >>"$LOG" 2>&1 || status="hiba(review)"
  log "tick finished: $status"
}

# Sourced (not executed) by the selftest, which defines run_tick above and calls it directly
# against a throw-away root -- the loop below must not start then.
if ! (return 0 2>/dev/null); then
  if [ "${1:-}" = "--once" ]; then
    run_tick
    exit 0
  fi
  log "gemini-ghost-runner started (tick=${TICK_INTERVAL_S}s, per-call budget enforced in-pipeline)"
  while true; do
    run_tick
    sleep "$TICK_INTERVAL_S"
  done
fi
