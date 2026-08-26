#!/usr/bin/env bash
# Pure decision + SIGSTOP/SIGCONT signal layer for the load-guard "critical" tier freeze (card
# 2bfbf805, Feladat 3 of the load-brake phase 19f3bbb5). Consumes an ALREADY-RESOLVED target (from
# load-guard-sigstop-target.sh, or a test override) and an already-computed action -- never
# re-evaluates load or re-discovers targets itself. Mirrors load-guard-cgroup-apply.sh's role
# exactly (pure/tested vs. thin/untested-discovery), same contract shape.
#
# Contract:
#   --action <log_only|stop_new_dispatch|cgroup_throttle|sigstop_freeze>   (required)
#   --target-json '<json>'   {"target": "<agent-name>|null", "pid": <int>|null}
#   --state <path>            tracking file, default store/load-guard-sigstop-state.json
#   --config <path>           for enabled/max_freeze_seconds, default store/load-guard-config.json
#   --now <epoch>             test-only override, default real wall-clock time
#
# MAX-90s FORCED RELEASE (card's own words: "Max 90 masodperc fagyasztas, utana KENYSZER-FELOLDAS
# fuggetlenul a terhelestol", the network-timeout tradeoff Peti already approved): checked FIRST,
# before anything else this tick. A frozen pid whose elapsed freeze time has crossed
# max_freeze_seconds is SIGCONT'd and the state cleared UNCONDITIONALLY -- even if the action this
# tick is still sigstop_freeze and the same agent would otherwise be re-picked. This tick does not
# also re-freeze; the NEXT tick evaluates fresh (giving the just-unfrozen process at least one
# tick's real breathing room, and letting the target script's round-robin possibly rotate away from
# it if another tied candidate exists).
#
# Desired frozen pid = target.pid IFF action == "sigstop_freeze" AND sigstop_freeze.enabled is true
# in config, ELSE null (release). Idempotent: re-asserts SIGSTOP on every call while the desired pid
# is unchanged (a stray SIGCONT from outside is corrected on the next tick, same defensive
# re-assertion load-guard-cgroup-apply.sh already does for cpu.max); only SIGCONTs the OLD pid when
# actually releasing or handing off to a different pid.
#
# SELF-PROTECTION (defense in depth -- the real exclusion lives in target discovery, but this is
# the layer that actually sends signals, and its own test suite calls it directly with injected
# target-json the same way load-guard-cgroup-apply.sh's does): refuses to signal pid 0, pid 1, or
# this process's own pid, regardless of what a target-json claims.
#
# Prints one-line JSON: {"frozen": "<agent-name>|null", "changed": bool, "pid": <int>|null,
#                         "forced_release": bool}
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION=""
TARGET_JSON=""
STATE="$SCRIPT_DIR/load-guard-sigstop-state.json"
CONFIG="$SCRIPT_DIR/load-guard-config.json"
NOW=""

while [ $# -gt 0 ]; do
  case "$1" in
    --action) ACTION="$2"; shift 2 ;;
    --target-json) TARGET_JSON="$2"; shift 2 ;;
    --state) STATE="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    --now) NOW="$2"; shift 2 ;;
    *) echo "load-guard-sigstop-apply.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$ACTION" ] || { echo "load-guard-sigstop-apply.sh: --action required" >&2; exit 2; }
[ -n "$TARGET_JSON" ] || TARGET_JSON='{"target": null, "pid": null}'
[ -n "$NOW" ] || NOW=$(date +%s)

python3 - "$ACTION" "$TARGET_JSON" "$STATE" "$CONFIG" "$NOW" "$$" <<'PYEOF'
import json
import os
import signal
import sys

action, target_json, state_path, config_path, now_s, own_pid_s = sys.argv[1:7]
target = json.loads(target_json)
now = int(now_s)
own_pid = int(own_pid_s)

try:
    with open(config_path) as f:
        config = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    config = {}
sf_cfg = config.get("sigstop_freeze", {})
enabled = sf_cfg.get("enabled", True)
max_freeze_seconds = sf_cfg.get("max_freeze_seconds", 90)

try:
    with open(state_path) as f:
        state = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    state = {"frozen": None, "pid": None, "since": None}

prev_agent = state.get("frozen")
prev_pid = state.get("pid")
prev_since = state.get("since")


def safe_signal(pid, sig):
    """Never signals pid 0, 1, or ourselves, regardless of what called us. Best-effort otherwise --
    a process that already exited (ProcessLookupError) or that we cannot signal (PermissionError)
    is not this script's problem to escalate; the state still moves on."""
    if pid is None or pid in (0, 1, own_pid):
        return
    try:
        os.kill(pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


forced_release = False

# MAX-90s FORCED RELEASE, checked first and unconditionally (see header comment).
if prev_pid is not None and prev_since is not None and (now - prev_since) >= max_freeze_seconds:
    safe_signal(prev_pid, signal.SIGCONT)
    prev_agent = None
    prev_pid = None
    prev_since = None
    forced_release = True

if forced_release:
    desired_agent = None
    desired_pid = None
else:
    desired_agent = target.get("target") if (action == "sigstop_freeze" and enabled) else None
    desired_pid = target.get("pid") if desired_agent else None

changed = (desired_agent, desired_pid) != (prev_agent, prev_pid)

# Release the OLD pid whenever it's no longer the desired one (covers a straight release and a
# hand-off between two different pids -- never leave two processes frozen at once).
if prev_pid is not None and prev_pid != desired_pid:
    safe_signal(prev_pid, signal.SIGCONT)

# Assert the desired pid's freeze on every call while it stays the target, not just on the
# transition edge -- defends against something else (or the process's own shell job control)
# CONT'ing it back out from under the guard.
if desired_pid is not None:
    safe_signal(desired_pid, signal.SIGSTOP)

# forced_release is itself always a real transition (it only fires when a pid WAS frozen), but by
# this point prev_agent/prev_pid were already reset to None above for the state write below -- so
# the plain tuple comparison can no longer see it. OR it in explicitly rather than reordering the
# reset (the reset must stay before "desired_agent = None" so a caller re-reading state mid-tick
# never observes a stale frozen pid past its cap).
changed = forced_release or changed

new_state = {
    "frozen": desired_agent,
    "pid": desired_pid,
    "since": prev_since if (not changed and not forced_release) else (now if desired_pid is not None else None),
}

with open(state_path, "w") as f:
    json.dump(new_state, f)
    f.write("\n")

print(json.dumps({
    "frozen": desired_agent,
    "changed": changed,
    "pid": desired_pid,
    "forced_release": forced_release,
}))
PYEOF
