#!/usr/bin/env bash
# Thin orchestrator for the load-guard cgroup throttle (card d7a28a0a, Feladat 2 of 19f3bbb5):
# self-heals cpu-controller delegation, then chains target discovery -> apply. Mirrors
# load-guard-check.sh's role (thin wrapper the daemon actually calls) -- the two scripts it chains
# carry the real logic and, for load-guard-cgroup-apply.sh, the test coverage.
#
# Usage: load-guard-cgroup.sh --action <action> [--target-json '<json>']
# --target-json is a test-only override (skips real tmux/kanban discovery); production passes none.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION=""
TARGET_JSON=""
STATE="$SCRIPT_DIR/load-guard-cgroup-state.json"
CONFIG="$SCRIPT_DIR/load-guard-config.json"

while [ $# -gt 0 ]; do
  case "$1" in
    --action) ACTION="$2"; shift 2 ;;
    --target-json) TARGET_JSON="$2"; shift 2 ;;
    --state) STATE="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    *) echo "load-guard-cgroup.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$ACTION" ] || { echo "load-guard-cgroup.sh: --action required" >&2; exit 2; }

# Self-healing delegation (card's KOCKAZAT #4 finding: this WSL2 host's app.slice does NOT
# delegate the cpu controller by default -- confirmed by direct write test, see REVIEW). Cheap and
# idempotent: a no-op once already enabled. Never fatal -- if it fails (e.g. app.slice missing
# because no agent session has ever run), target discovery below will simply find no scope and the
# apply step degrades to "nothing to throttle" rather than crashing the daemon tick.
if [ -z "$TARGET_JSON" ]; then
  UID_N="$(id -u)"
  APP_SLICE="${LOAD_GUARD_CGROUP_ROOT:-/sys/fs/cgroup/user.slice/user-$UID_N.slice/user@$UID_N.service/app.slice}"
  if [ -w "$APP_SLICE/cgroup.subtree_control" ] && ! grep -qw cpu "$APP_SLICE/cgroup.subtree_control" 2>/dev/null; then
    echo "+cpu" > "$APP_SLICE/cgroup.subtree_control" 2>/dev/null || true
  fi
  TARGET_JSON="$("$SCRIPT_DIR/load-guard-cgroup-target.sh")"
fi

"$SCRIPT_DIR/load-guard-cgroup-apply.sh" --action "$ACTION" --target-json "$TARGET_JSON" --state "$STATE" --config "$CONFIG"
