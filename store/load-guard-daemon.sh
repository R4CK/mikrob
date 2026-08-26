#!/usr/bin/env bash
# Periodic tick for the load-guard state machine (card edd8b398, Feladat 1's systemd wiring).
# Invoked by the mikrob-load-guard.timer every 5-10s (a heartbeat's ~10min cron-cadence would be
# far too slow for a load spike). Runs load-guard-eval.sh once and appends to store/load-guard.log
# ONLY on a state CHANGE -- logging every tick at a 5-10s cadence would flood the file for no
# reason (matches the dashboard-watchdog/channel-watchdog convention of quiet-unless-notable).
#
# --config/--state/--metrics-json/--now/--log are test-only overrides (passed straight through to
# load-guard-eval.sh except --log); production invocations pass none of them.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$INSTALL_DIR/store/load-guard.log"
EVAL_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --log) LOG="$2"; shift 2 ;;
    --config|--state|--metrics-json|--now) EVAL_ARGS+=("$1" "$2"); shift 2 ;;
    *) echo "load-guard-daemon.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

ts() { date '+%Y-%m-%d %H:%M:%S'; }

RESULT=$("$INSTALL_DIR/store/load-guard-eval.sh" "${EVAL_ARGS[@]}")
CHANGED=$(printf '%s' "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['changed'])")

if [ "$CHANGED" = "True" ]; then
  echo "$(ts) $RESULT" >> "$LOG"
fi
