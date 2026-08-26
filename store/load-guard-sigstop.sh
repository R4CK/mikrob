#!/usr/bin/env bash
# Thin orchestrator for the load-guard SIGSTOP/SIGCONT freeze (card 2bfbf805, Feladat 3 of
# 19f3bbb5): chains target discovery -> apply. Mirrors load-guard-cgroup.sh's role -- the two
# scripts it chains carry the real logic and (for load-guard-sigstop-apply.sh) the test coverage.
# No self-healing delegation step here (unlike load-guard-cgroup.sh): SIGSTOP/SIGCONT need no
# cgroup-controller delegation, they are plain signals to a pid this user already owns.
#
# Usage: load-guard-sigstop.sh --action <action> [--target-json '<json>']
# --target-json is a test-only override (skips real tmux/kanban discovery); production passes none.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION=""
TARGET_JSON=""
STATE="$SCRIPT_DIR/load-guard-sigstop-state.json"
CONFIG="$SCRIPT_DIR/load-guard-config.json"

while [ $# -gt 0 ]; do
  case "$1" in
    --action) ACTION="$2"; shift 2 ;;
    --target-json) TARGET_JSON="$2"; shift 2 ;;
    --state) STATE="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    *) echo "load-guard-sigstop.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$ACTION" ] || { echo "load-guard-sigstop.sh: --action required" >&2; exit 2; }

if [ -z "$TARGET_JSON" ]; then
  TARGET_JSON="$("$SCRIPT_DIR/load-guard-sigstop-target.sh")"
fi

"$SCRIPT_DIR/load-guard-sigstop-apply.sh" --action "$ACTION" --target-json "$TARGET_JSON" --state "$STATE" --config "$CONFIG"
