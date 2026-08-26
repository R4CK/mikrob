#!/usr/bin/env bash
# Pure decision + cpu.max write layer for the load-guard "hard" tier cgroup throttle (card
# d7a28a0a, Feladat 2 of the load-brake phase 19f3bbb5). Consumes an ALREADY-RESOLVED target (from
# load-guard-cgroup-target.sh, or a test override) and an already-computed action (from the
# daemon's single load-guard-eval.sh call) -- never re-evaluates load or re-discovers targets
# itself, so this stays the testable pure-logic half (mirrors load-guard-eval.sh vs.
# load-guard-read.sh: real-source reading is thin and untested, decision logic is fully tested).
#
# Contract:
#   --action <log_only|stop_new_dispatch|cgroup_throttle|sigstop_freeze>   (required)
#   --target-json '<json>'   {"target": "<agent-name>|null", "scope": "<abs cpu.max dir>|null"}
#   --state <path>            tracking file, default store/load-guard-cgroup-state.json
#   --config <path>           for enabled/quota_pct, default store/load-guard-config.json
#
# Desired throttled agent = target.target IFF action == "cgroup_throttle" AND cgroup_throttle.enabled
# is true in config, ELSE null (release). Idempotent: re-asserts cpu.max on every call while the
# desired agent is unchanged (cheap single write, defends against something else resetting the
# scope's cpu.max out of band); only touches the OLD scope's cpu.max when actually releasing it.
#
# Prints one-line JSON: {"throttled": "<agent-name>|null", "changed": bool, "scope": "..."|null}
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
    *) echo "load-guard-cgroup-apply.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$ACTION" ] || { echo "load-guard-cgroup-apply.sh: --action required" >&2; exit 2; }
[ -n "$TARGET_JSON" ] || TARGET_JSON='{"target": null, "scope": null}'

python3 - "$ACTION" "$TARGET_JSON" "$STATE" "$CONFIG" <<'PYEOF'
import json
import sys
import time

action, target_json, state_path, config_path = sys.argv[1:5]
target = json.loads(target_json)

try:
    with open(config_path) as f:
        config = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    config = {}
ct_cfg = config.get("cgroup_throttle", {})
enabled = ct_cfg.get("enabled", True)
quota_pct = ct_cfg.get("quota_pct", 25)

try:
    with open(state_path) as f:
        state = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    state = {"throttled": None, "scope": None, "since": None}

prev_agent = state.get("throttled")
prev_scope = state.get("scope")

desired_agent = target.get("target") if (action == "cgroup_throttle" and enabled) else None
desired_scope = target.get("scope") if desired_agent else None

changed = desired_agent != prev_agent

# Release the OLD scope whenever it's no longer the desired one (covers both a straight release
# and a hand-off from one throttled agent to another -- never leave two agents throttled at once).
if prev_scope and prev_scope != desired_scope:
    try:
        with open(prev_scope + "/cpu.max", "w") as f:
            f.write("max\n")
    except OSError as e:
        print(f"load-guard-cgroup-apply.sh: release of {prev_scope} failed: {e}", file=sys.stderr)

# Assert the desired scope's cpu.max on every call while it stays the target, not just on the
# transition edge -- a cheap re-write that defends against anything else resetting the value.
if desired_agent and desired_scope:
    quota_us = max(1, int(100000 * quota_pct / 100))
    try:
        with open(desired_scope + "/cpu.max", "w") as f:
            f.write(f"{quota_us} 100000\n")
    except OSError as e:
        print(f"load-guard-cgroup-apply.sh: apply to {desired_scope} failed: {e}", file=sys.stderr)
        desired_agent = None
        desired_scope = None
        changed = desired_agent != prev_agent

new_state = {
    "throttled": desired_agent,
    "scope": desired_scope,
    "since": state.get("since") if not changed else None,
}
if changed:
    # Real wall-clock time -- tests only assert on throttled/scope/changed, never on since.
    new_state["since"] = int(time.time())

with open(state_path, "w") as f:
    json.dump(new_state, f)
    f.write("\n")

print(json.dumps({"throttled": desired_agent, "changed": changed, "scope": desired_scope}))
PYEOF
