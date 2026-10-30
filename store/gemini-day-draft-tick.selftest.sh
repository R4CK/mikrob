#!/usr/bin/env bash
# Self-test for store/gemini-day-draft-tick.sh (card 5cb861e6). Throwaway MARVEEN_ROOT, stubbed
# vram-guard-check.sh and gemini-ghost-runner.sh -- never touches the real GPU or a real Gemini call.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$SELF_DIR/gemini-day-draft-tick.sh"

TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT
mkdir -p "$TD/store"

n=0
failures=()
case_() {
  local label="$1" cond="$2"
  n=$((n + 1))
  if [ "$cond" != "0" ]; then
    failures+=("$label")
  fi
}

# args: <path> <exit-code> <stdout-line>
stub() {
  local path="$1" rc="$2" line="$3"
  printf '#!/bin/bash\necho "%s"\nexit %s\n' "$line" "$rc" > "$path"
  chmod +x "$path"
}

run_with_fresh_env() {
  (
    export MARVEEN_ROOT="$TD"
    export GEMINI_DAY_DRAFT_VRAM_GUARD="$TD/store/vram-guard-check.sh"
    export GEMINI_DAY_DRAFT_GHOST_RUNNER="$TD/store/gemini-ghost-runner.sh"
    # shellcheck source=/dev/null
    source "$SUT"
    run_tick
  )
}

# --- case 1: GPU HOLD -> logs "skipped: GPU hold", the ghost runner is never invoked ------------
rm -f "$TD/store/gemini-day-draft-tick.log"
stub "$TD/store/vram-guard-check.sh" 1 "HOLD gpu-util-hold 0/6144 MiB (0.0%) util=72%"
stub "$TD/store/gemini-ghost-runner.sh" 0 "STUB-RAN: gemini-ghost-runner.sh"
run_with_fresh_env
case_ "GPU hold logs the exact 'skipped: GPU hold' line" \
  "$(grep -q 'skipped: GPU hold' "$TD/store/gemini-day-draft-tick.log" && echo 0 || echo 1)"
case_ "GPU hold never invokes the ghost runner" \
  "$(grep -q 'STUB-RAN: gemini-ghost-runner.sh' "$TD/store/gemini-day-draft-tick.log" && echo 1 || echo 0)"

# --- case 2: GPU ADMIT -> dispatches gemini-ghost-runner.sh --once ------------------------------
rm -f "$TD/store/gemini-day-draft-tick.log"
stub "$TD/store/vram-guard-check.sh" 0 "ADMIT ok 100/6144 MiB (1.6%) util=12%"
stub "$TD/store/gemini-ghost-runner.sh" 0 "STUB-RAN: gemini-ghost-runner.sh"
run_with_fresh_env
case_ "GPU admit does not log a skip" \
  "$(grep -q 'skipped: GPU hold' "$TD/store/gemini-day-draft-tick.log" && echo 1 || echo 0)"
case_ "GPU admit invokes the ghost runner" \
  "$(grep -q 'STUB-RAN: gemini-ghost-runner.sh' "$TD/store/gemini-day-draft-tick.log" && echo 0 || echo 1)"
case_ "GPU admit logs the ADMIT line with the guard's own reason text" \
  "$(grep -q 'ADMIT (ADMIT ok' "$TD/store/gemini-day-draft-tick.log" && echo 0 || echo 1)"

# --- case 3: the ghost runner itself failing (e.g. locked by a concurrent tick) is logged, not --
#             swallowed silently, and does not crash this script -----------------------------------
rm -f "$TD/store/gemini-day-draft-tick.log"
stub "$TD/store/vram-guard-check.sh" 0 "ADMIT ok 100/6144 MiB (1.6%) util=12%"
stub "$TD/store/gemini-ghost-runner.sh" 1 "STUB-RAN: gemini-ghost-runner.sh (failing)"
run_with_fresh_env
case_ "a failing ghost-runner invocation is still logged, script does not crash" \
  "$(grep -q 'exited non-zero' "$TD/store/gemini-day-draft-tick.log" && echo 0 || echo 1)"

echo
echo "selftest: $n case(s), $([ ${#failures[@]} -eq 0 ] && echo PASS || echo FAIL)"
for f in "${failures[@]:-}"; do
  [ -n "$f" ] && echo "  - $f"
done
[ ${#failures[@]} -eq 0 ]
