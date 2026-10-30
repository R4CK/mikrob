#!/bin/bash
# Gemini daytime-mode tick (card 5cb861e6, phase c7abdf57, Peti Telegram 12371 mode 1).
#
# WHY THIS EXISTS: the "mode 1" daytime Gemini draft pipeline (5 random ticks/hour, admitted only
# under 60% GPU utilization) previously lived in a TRANSIENT systemd user timer created by hand
# (gemini-day-draft.timer, per the card's own "mai allapot" note) -- lost on every reboot, and
# never version-controlled, so nobody could review or test it. This script is the durable,
# tested replacement for that timer's ACTION (what each tick actually does); the timer/service
# unit pair that CALLS it on the 5-random-ticks/hour schedule is installed by
# scripts/install-guard-timers.sh (write_calendar_timer), not hand-created on the box.
#
# WHAT A TICK DOES, IN ORDER:
#   1. Ask store/vram-guard-check.sh whether the GPU is under the 60%-utilization hold (the SAME
#      gpu-util-hold tier the rest of the fleet's local-first routing already uses -- not a new
#      threshold). HOLD -> log "skipped: GPU hold" and stop, no Gemini call at all.
#   2. ADMIT -> run store/gemini-ghost-runner.sh --once, which drives the EXISTING Ghost pipeline
#      (run-gemini-fallback.sh + the three gemini-orchestrator*.js steps) exactly as quota-bridge's
#      Ghost mode already does. That script's own, hourly fleet-wide 5-call budget
#      (src/gemini-ghost-budget.ts) is untouched by this script -- this tick does not re-implement
#      or duplicate that cap, it only decides WHETHER to trigger one pipeline pass.
#
# MUTUAL EXCLUSION WITH THE QUOTA-BRIDGE GHOST RUNNER (card's own constraint, "ne fusson
# parhuzamosan... flock"): gemini-ghost-runner.sh's run_tick() now holds its OWN flock
# (store/gemini-ghost-runner.lock) for the duration of a tick -- this script does not need a
# second lock of its own, because both drivers (this script's --once call, and quota-bridge.py's
# continuous loop) go through that single shared choke point.
set -euo pipefail
ROOT="${MARVEEN_ROOT:-/home/neon/marveen}"
STORE="$ROOT/store"
LOG="$STORE/gemini-day-draft-tick.log"
VRAM_GUARD="${GEMINI_DAY_DRAFT_VRAM_GUARD:-$STORE/vram-guard-check.sh}"
GHOST_RUNNER="${GEMINI_DAY_DRAFT_GHOST_RUNNER:-$STORE/gemini-ghost-runner.sh}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$LOG"; }

run_tick() {
  local guard_out
  if guard_out="$(bash "$VRAM_GUARD" 2>&1)"; then
    log "ADMIT ($guard_out) -- dispatching gemini-ghost-runner.sh --once"
    bash "$GHOST_RUNNER" --once >>"$LOG" 2>&1 || log "gemini-ghost-runner.sh --once exited non-zero (see above)"
  else
    log "skipped: GPU hold ($guard_out)"
  fi
}

# Sourced (not executed) by the selftest, same pattern as gemini-ghost-runner.sh's own guard --
# the selftest defines run_tick above via `source` and calls it directly against a throwaway root.
if ! (return 0 2>/dev/null); then
  run_tick
fi
