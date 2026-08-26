#!/usr/bin/env bash
# Evaluates current system load against store/load-guard-config.json's WATCH/SOFT/HARD/CRITICAL
# thresholds and persists a hysteresis-debounced state to store/load-guard-state.json (card
# 2597e3b7, Feladat 1 of the load-brake phase 19f3bbb5).
#
# Hysteresis: a candidate tier must stay stable for its own `sustained_seconds` (config, default
# 30s) before the confirmed state actually moves -- in EITHER direction, up or down -- so a single
# noisy reading never flips the state (card's own wording: "kuszob alatt/felett tartosan (min.
# 30mp) marad, ne villogjon").
#
# Usage: load-guard-eval.sh [--config <path>] [--state <path>] [--metrics-json '<json>'] [--now <epoch>]
# --metrics-json and --now are test-only overrides; production runs call load-guard-read.sh and
# date +%s for real. Prints one-line JSON: {state, since, action, changed, instantaneous, metrics}.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/load-guard-config.json"
STATE="$SCRIPT_DIR/load-guard-state.json"
METRICS_JSON=""
NOW=""

while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    --state) STATE="$2"; shift 2 ;;
    --metrics-json) METRICS_JSON="$2"; shift 2 ;;
    --now) NOW="$2"; shift 2 ;;
    *) echo "load-guard-eval.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$NOW" ] || NOW=$(date +%s)
if [ -z "$METRICS_JSON" ]; then
  METRICS_JSON=$("$SCRIPT_DIR/load-guard-read.sh")
fi

python3 - "$CONFIG" "$STATE" "$METRICS_JSON" "$NOW" <<'PYEOF'
import json
import sys

config_path, state_path, metrics_json, now_s = sys.argv[1:5]
now = int(now_s)
with open(config_path) as f:
    config = json.load(f)
metrics = json.loads(metrics_json)

try:
    with open(state_path) as f:
        state = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    state = {"state": "watch", "since": now, "pending": None}

TIERS = ["watch", "soft", "hard", "critical"]
DEFAULT_DEBOUNCE_SECONDS = 30


def loadavg_ratio(m):
    nproc = m.get("nproc") or 1
    return (m.get("loadavg1") or 0) / nproc


def psi_some(m):
    v = m.get("psi_some_avg10")
    return v if v is not None else 0


r = loadavg_ratio(metrics)
p = psi_some(metrics)

# Highest tier whose OR-condition (loadavg ratio OR PSI) is currently breached. A reading under
# every threshold has no tier to claim, so it stays at the resting "watch" tier -- watch's own
# action is log_only, identical in effect to "nothing is elevated".
instantaneous = "watch"
for tier in TIERS:
    t = config.get(tier, {})
    lr = t.get("loadavg_ratio")
    lp = t.get("psi_some_avg10")
    if (lr is not None and r > lr) or (lp is not None and p > lp):
        instantaneous = tier

current = state.get("state", "watch")
pending = state.get("pending")
changed = False

if instantaneous == current:
    pending = None
else:
    required = config.get(instantaneous, {}).get("sustained_seconds", DEFAULT_DEBOUNCE_SECONDS)
    if not pending or pending.get("tier") != instantaneous:
        pending = {"tier": instantaneous, "first_seen": now}
    elif now - pending["first_seen"] >= required:
        current = instantaneous
        state["since"] = now
        pending = None
        changed = True

state["state"] = current
state["pending"] = pending

with open(state_path, "w") as f:
    json.dump(state, f)
    f.write("\n")

action = config.get(current, {}).get("action", "log_only")
print(json.dumps({
    "state": current,
    "since": state["since"],
    "action": action,
    "changed": changed,
    "instantaneous": instantaneous,
    "metrics": metrics,
}))
PYEOF
