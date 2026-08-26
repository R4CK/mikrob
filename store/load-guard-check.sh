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

if [ "$ACTION" = "log_only" ]; then
  echo "ADMIT $STATE"
  exit 0
else
  echo "HOLD $STATE ($ACTION)"
  exit 1
fi
