#!/usr/bin/env bash
# ADMIT/HOLD gate for "should new work be dispatched right now" (card 2597e3b7). Thin wrapper
# around load-guard-eval.sh's confirmed state -- callers (the C-section orchestrator, or anything
# else about to start new work) only need this boolean, not the raw metrics/hysteresis machinery.
#
# Exit 0 = ADMIT (state's action is log_only). Exit 1 = HOLD (stop_new_dispatch / cgroup_throttle /
# sigstop_freeze -- all three mean "do not start anything new", the two heavier ones are Feladat
# 2/3's actions layered ON TOP of, not instead of, halting new admission). Prints one line to
# stdout: "ADMIT <state>" or "HOLD <state> (<action>)".
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULT=$("$SCRIPT_DIR/load-guard-eval.sh" "$@")

STATE=$(printf '%s' "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['state'])")
ACTION=$(printf '%s' "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['action'])")

if [ "$ACTION" != "log_only" ]; then
  echo "HOLD $STATE ($ACTION)"
  exit 1
fi

# Load itself is fine -- also check the proactive agent-panel-count cap (Peti request 2026-09-04,
# after the 2026-09-03 WSL-overload incident) before admitting new work. See agent-cap-check.sh's
# own header for why this is a separate, additive check rather than folded into the tiers above:
# it gates NEW dispatch on panel count, not on measured load.
set +e
CAP_RESULT=$("$SCRIPT_DIR/agent-cap-check.sh")
CAP_EXIT=$?
set -e
if [ "$CAP_EXIT" -ne 0 ]; then
  echo "$CAP_RESULT"
  exit 1
fi

echo "ADMIT $STATE"
exit 0
