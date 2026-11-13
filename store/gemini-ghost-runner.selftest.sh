#!/usr/bin/env bash
# Self-test for store/gemini-ghost-runner.sh (card 612058c2). Throw-away MARVEEN_ROOT, stub
# pipeline steps (run-gemini-fallback.sh / dist/gemini-orchestrator*.js).
#
# Card 612058c2 delta-gate (WhiteHat2 NO-GO H1 @c5e5ec28): this runner used to enforce its own
# tick-level hourly cap here (counting its own log rows). That enforcement was WRONG (see this
# script's own header) and has moved to the real network-call sites inside the pipeline itself
# (src/gemini-ghost-budget.ts, covered by src/__tests__/gemini-ghost-budget.test.ts). This
# selftest now only pins what this script itself is responsible for: every tick runs all four
# pipeline steps unconditionally, and a failing step never stops the later steps from running.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$SELF_DIR/gemini-ghost-runner.sh"

TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT
mkdir -p "$TD/store" "$TD/dist"

n=0
failures=()
case_() {
  local label="$1" cond="$2"
  n=$((n + 1))
  if [ "$cond" != "0" ]; then
    failures+=("$label")
  fi
}

stub() {  # stub <path> <exit-code> -- always prints its own basename first, so the runner's log
          # (which captures each step's stdout) can confirm which steps actually ran.
  local path="$1" rc="$2"
  case "$path" in
    *.js) printf "console.log('STUB-RAN: %s'); process.exit(%s)\n" "$(basename "$path")" "$rc" > "$path" ;;
    *) printf '#!/bin/bash\necho "STUB-RAN: %s"\nexit %s\n' "$(basename "$path")" "$rc" > "$path"; chmod +x "$path" ;;
  esac
}

run_with_fresh_env() {  # run_with_fresh_env -- the SUT, sourced into a fresh subshell each time
  (
    export MARVEEN_ROOT="$TD"
    # shellcheck source=/dev/null
    source "$SUT"
    run_tick
  )
}

# --- case 1: a clean tick runs all four steps -------------------------------------------------
rm -f "$TD/store/gemini-ghost-runner.log"
stub "$TD/store/run-gemini-fallback.sh" 0
stub "$TD/dist/gemini-orchestrator.js" 0
stub "$TD/dist/gemini-orchestrator-draft.js" 0
stub "$TD/dist/gemini-orchestrator-draft-review.js" 0
run_with_fresh_env
case_ "clean tick runs every pipeline step" \
  "$(grep -q 'STUB-RAN: run-gemini-fallback.sh' "$TD/store/gemini-ghost-runner.log" \
     && grep -q 'STUB-RAN: gemini-orchestrator.js' "$TD/store/gemini-ghost-runner.log" \
     && grep -q 'STUB-RAN: gemini-orchestrator-draft.js' "$TD/store/gemini-ghost-runner.log" \
     && grep -q 'STUB-RAN: gemini-orchestrator-draft-review.js' "$TD/store/gemini-ghost-runner.log" \
     && echo 0 || echo 1)"
case_ "clean tick's log records the finished status as ok" \
  "$(grep -q 'tick finished: ok' "$TD/store/gemini-ghost-runner.log" && echo 0 || echo 1)"
case_ "clean tick's log mentions RUN" \
  "$(grep -q 'RUN tick' "$TD/store/gemini-ghost-runner.log" && echo 0 || echo 1)"

# --- case 2: a failing pipeline step is recorded as a non-"ok" status, not silently swallowed --
rm -f "$TD/store/gemini-ghost-runner.log"
stub "$TD/dist/gemini-orchestrator-draft.js" 1
run_with_fresh_env
case_ "a failing step's status is recorded (not ok)" \
  "$(grep -q 'tick finished: ok' "$TD/store/gemini-ghost-runner.log" && echo 1 || echo 0)"
case_ "a failing step still runs every later step (draft-review still invoked)" \
  "$(grep -q 'STUB-RAN: gemini-orchestrator-draft-review.js' "$TD/store/gemini-ghost-runner.log" && echo 0 || echo 1)"
stub "$TD/dist/gemini-orchestrator-draft.js" 0   # restore for any later case

# --- case 3: a tick runs every time it is called, unconditionally (no self-imposed cap) --------
# NOTE: these 7 calls are SEQUENTIAL (one finishes, fully releasing the lock added below, before
# the next starts) -- this case is about the absence of a tick-COUNT cap, not about concurrency.
# Case 4 below is the concurrency case.
rm -f "$TD/store/gemini-ghost-runner.log"
for _ in 1 2 3 4 5 6 7; do run_with_fresh_env; done
run_count="$(grep -c 'RUN tick' "$TD/store/gemini-ghost-runner.log")"
case_ "the runner never skips a tick on its own (budget enforcement moved to the pipeline)" \
  "$([ "$run_count" -eq 7 ] && echo 0 || echo 1)"

# --- case 4: two truly CONCURRENT ticks -- one runs, the other is skipped by the flock (card ----
# 5cb861e6, Kesz-ha: "ket egyideju tick kozul az egyik a flock miatt kimarad"). The
# run-gemini-fallback.sh stub sleeps briefly so the first tick is still holding the lock when the
# second one starts; both share the SAME MARVEEN_ROOT (hence the same lock file path).
rm -f "$TD/store/gemini-ghost-runner.log"
printf '#!/bin/bash\nsleep 0.3\necho "STUB-RAN: run-gemini-fallback.sh"\nexit 0\n' > "$TD/store/run-gemini-fallback.sh"
chmod +x "$TD/store/run-gemini-fallback.sh"
run_with_fresh_env &
pid1=$!
sleep 0.05  # give the first tick time to acquire the lock before the second one tries
run_with_fresh_env &
pid2=$!
wait "$pid1" "$pid2"
# grep -c exits 1 on zero matches (which is exactly what a failing mutant produces for one of
# these two counts) -- under this file's own `set -e`, an unguarded assignment would abort the
# whole selftest right here instead of letting case_ below record a clean FAIL.
run_lines="$(grep -c 'RUN tick' "$TD/store/gemini-ghost-runner.log" || true)"
skip_lines="$(grep -c 'SKIP tick (locked' "$TD/store/gemini-ghost-runner.log" || true)"
case_ "of two concurrent ticks, exactly one runs and the other is skipped by the flock" \
  "$([ "$run_lines" -eq 1 ] && [ "$skip_lines" -eq 1 ] && echo 0 || echo 1)"
# Restore the normal (non-sleeping) stub for any later case in this file.
stub "$TD/store/run-gemini-fallback.sh" 0

# --- case 5: the stop-file (H1, card 7f112c2f, Cybersec NO-GO @f859c361b) is honoured BETWEEN
# ticks, not mid-tick, and the loop then exits on its own without anyone SIGTERM-ing it ----------
rm -f "$TD/store/gemini-ghost-runner.log"
# Slow first-step stub so there is a real window between "a tick is running" and "the tick
# finished" to touch the stop file WHILE the tick is still in flight -- proving it is honoured
# only between ticks, not mid-tick (which would be the "kill an in-flight draft" regression).
printf '#!/bin/bash\nsleep 0.5\necho "STUB-RAN: run-gemini-fallback.sh"\nexit 0\n' > "$TD/store/run-gemini-fallback.sh"
chmod +x "$TD/store/run-gemini-fallback.sh"
GHOST_STOP="$TD/store/gemini-ghost-runner.stop"
rm -f "$GHOST_STOP"
(
  export MARVEEN_ROOT="$TD" GEMINI_GHOST_RUNNER_STOP_FILE="$GHOST_STOP" GEMINI_GHOST_TICK_INTERVAL_S=60
  exec "$SUT"
) &
loop_pid=$!
for _ in $(seq 1 50); do
  grep -q 'RUN tick' "$TD/store/gemini-ghost-runner.log" 2>/dev/null && break
  sleep 0.1
done
touch "$GHOST_STOP"   # written WHILE the tick (still sleeping 0.5s) is in flight
exited=1
for _ in $(seq 1 50); do
  if ! kill -0 "$loop_pid" 2>/dev/null; then exited=0; break; fi
  sleep 0.1
done
wait "$loop_pid" 2>/dev/null
stub "$TD/store/run-gemini-fallback.sh" 0   # restore for any later case
case_ "the loop exits on its own after the stop file appears (no SIGTERM needed)" "$exited"
case_ "the in-flight tick finished normally (was not killed mid-flight by the stop request)" \
  "$(grep -q 'STUB-RAN: run-gemini-fallback.sh' "$TD/store/gemini-ghost-runner.log" \
     && grep -q 'tick finished: ok' "$TD/store/gemini-ghost-runner.log" && echo 0 || echo 1)"
case_ "the loop logs the stop request" \
  "$(grep -q 'stop requested' "$TD/store/gemini-ghost-runner.log" && echo 0 || echo 1)"
case_ "the loop ran exactly one tick (did not start a second one after the stop file appeared)" \
  "$([ "$(grep -c 'RUN tick' "$TD/store/gemini-ghost-runner.log")" -eq 1 ] && echo 0 || echo 1)"
case_ "the stop file is removed once honoured (does not block the NEXT outage's runner)" \
  "$([ ! -f "$GHOST_STOP" ] && echo 0 || echo 1)"

echo
echo "selftest: $n case(s), $([ ${#failures[@]} -eq 0 ] && echo PASS || echo FAIL)"
for f in "${failures[@]:-}"; do
  [ -n "$f" ] && echo "  - $f"
done
[ ${#failures[@]} -eq 0 ]
