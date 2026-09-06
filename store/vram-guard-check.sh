#!/usr/bin/env bash
# ADMIT/HOLD gate for "may a local-LLM dispatch start right now, given GPU memory pressure?"
# (card 108c7b10, parent 40568837, Peti request 2026-09-06).
#
# The existing load-guard only measures CPU loadavg and PSI. Nothing looks at VRAM, so an offload
# sweep or a card-build route can hand work to the local 7B while the GPU is already full -- the
# case this guard exists for. Shape deliberately mirrors load-guard-eval.sh + load-guard-check.sh:
# read metrics, debounce them into a tier with hysteresis, print one line, exit 0/1. Callers only
# need the boolean; card f9bad591 wires it into the dispatch points, a1c4dc51 surfaces the state.
#
# Output (stdout, one line): "ADMIT <tier> <used>/<total> MiB (<pct>%)"
#                            "HOLD <tier> <used>/<total> MiB (<pct>%)"
#                            "ADMIT no-gpu (<reason>)"      -- see FAIL-SAFE below
#                            "HOLD unreadable (<reason>)"   -- see FAIL-SAFE below
# Exit: 0 = ADMIT, 1 = HOLD, 2 = bad usage.
#
# ---------------------------------------------------------------------------------------------
# FAIL-SAFE DIRECTION, and a DELIBERATE DEVIATION FROM THE CARD TEXT.
#
# Card 108c7b10 says: "ha nvidia-smi hianyzik/hibazik -> ADMIT (nem blokkol vakon)". That is ONE
# rule for two situations that are not alike, and for the second of them it points the wrong way:
#
#   (a) nvidia-smi is NOT PRESENT at all. There may simply be no NVIDIA GPU on this host. VRAM is
#       then not a constraint that exists, this guard has no subject, and holding would disable the
#       local LLM forever on every such host -- a permanent silent block, which is worse than the
#       thing being guarded against. => ADMIT. This is the card's reasoning, and it is right here.
#
#   (b) nvidia-smi IS PRESENT but fails, times out, or prints something we cannot parse. A GPU
#       exists and we cannot read its state. That is genuine doubt, not absence of a subject, and
#       both the parent card ("ugyanaz a fail-safe iranyelv mint a load-guard-nal: ketseg eseten
#       ONLINE") and CLAUDE.md rule 16 ("hibas/hianyzo/lefagyott modell eseten ONLINE-t kell
#       valasztani, sose forditva") say the same thing: on doubt, route ONLINE, i.e. do NOT start
#       the local dispatch. => HOLD.
#
# Admitting in case (b) would defeat the guard at exactly the moment its measurement is
# unavailable, which is the "a safe default is only fail-closed if it cannot MATCH" trap. And the
# downside is not theoretical on this box: the fleet already carries a GPU crash-loop watchdog for
# WSL restarts caused by GPU passthrough.
#
# The split is deliberate, it is tested both ways, and it is called out in the card's REVIEW rather
# than buried here -- if MikroB wants the card's literal single rule instead, VRAM_GUARD_UNREADABLE
# below is the one line to change.
# ---------------------------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/vram-guard-config.json"
STATE="$SCRIPT_DIR/vram-guard-state.json"
METRICS_JSON=""
NOW=""
# The one knob that flips case (b) above. "hold" = on doubt go online (default, see the block
# above); "admit" = the card's literal wording. Case (a) is NOT covered by this and always admits.
VRAM_GUARD_UNREADABLE="${VRAM_GUARD_UNREADABLE:-hold}"
# nvidia-smi on WSL is not on PATH; the card names the absolute location. PATH is still consulted
# first so a normal Linux host works unchanged.
NVIDIA_SMI="${VRAM_GUARD_NVIDIA_SMI:-}"
SMI_TIMEOUT="${VRAM_GUARD_SMI_TIMEOUT:-5}"

while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    --state) STATE="$2"; shift 2 ;;
    --metrics-json) METRICS_JSON="$2"; shift 2 ;;
    --now) NOW="$2"; shift 2 ;;
    *) echo "vram-guard-check.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$NOW" ] || NOW=$(date +%s)

# ---- metrics ----------------------------------------------------------------------------------
# Emits one JSON line: {"used_mib":N,"total_mib":N} on success, or {"error":"...","present":bool}.
# --metrics-json is the test seam (load-guard-eval.sh uses the same one), so the selftest never
# needs a GPU and never shells out.
read_vram_metrics() {
  local smi=""
  if [ -n "$NVIDIA_SMI" ]; then
    smi="$NVIDIA_SMI"
  elif command -v nvidia-smi >/dev/null 2>&1; then
    smi="$(command -v nvidia-smi)"
  elif [ -x /usr/lib/wsl/lib/nvidia-smi ]; then
    smi=/usr/lib/wsl/lib/nvidia-smi
  fi

  if [ -z "$smi" ] || [ ! -x "$smi" ]; then
    # Case (a): no tool, therefore probably no NVIDIA GPU. Absence of a subject, not doubt.
    printf '{"error":"nvidia-smi not found on PATH, at /usr/lib/wsl/lib, or via VRAM_GUARD_NVIDIA_SMI","present":false}\n'
    return 0
  fi

  local out=""
  if ! out="$(timeout "$SMI_TIMEOUT" "$smi" --query-gpu=memory.used,memory.total --format=csv,noheader,nounits 2>&1)"; then
    # Case (b): the tool is here and did not answer. A hang is included on purpose -- `timeout`
    # turns it into this branch instead of wedging whatever is about to dispatch.
    printf '{"error":"nvidia-smi failed or timed out: %s","present":true}\n' \
      "$(printf '%s' "$out" | tr '\n' ' ' | tr -d '"' | cut -c1-160)"
    return 0
  fi

  # Multi-GPU: nvidia-smi prints one row per device. Sum them -- the local model is placed on this
  # host's GPU memory as a whole, and admitting because ONE idle card has room while the model
  # actually loads onto a full one is the wrong answer.
  printf '%s' "$out" | python3 -c '
import json, sys
used = total = 0
rows = 0
for line in sys.stdin.read().splitlines():
    line = line.strip()
    if not line:
        continue
    parts = [p.strip() for p in line.split(",")]
    if len(parts) != 2:
        print(json.dumps({"error": "unparseable nvidia-smi row: %s" % line[:80], "present": True}))
        sys.exit(0)
    try:
        used += int(parts[0]); total += int(parts[1])
    except ValueError:
        print(json.dumps({"error": "non-numeric nvidia-smi row: %s" % line[:80], "present": True}))
        sys.exit(0)
    rows += 1
if rows == 0 or total <= 0:
    # A zero total would make every percentage a division by zero, and an empty answer from a
    # PRESENT tool is case (b), not case (a).
    print(json.dumps({"error": "nvidia-smi returned no usable GPU rows", "present": True}))
    sys.exit(0)
print(json.dumps({"used_mib": used, "total_mib": total}))
'
}

if [ -z "$METRICS_JSON" ]; then
  METRICS_JSON="$(read_vram_metrics)"
fi

# ---- decision ---------------------------------------------------------------------------------
python3 - "$CONFIG" "$STATE" "$METRICS_JSON" "$NOW" "$VRAM_GUARD_UNREADABLE" <<'PYEOF'
import json
import sys

config_path, state_path, metrics_json, now_s, unreadable_policy = sys.argv[1:6]
now = int(now_s)

DEFAULTS = {
    "soft_pct": 85,
    "hard_pct": 92,
    "sustained_seconds": 30,
}
try:
    with open(config_path) as f:
        config = {**DEFAULTS, **json.load(f)}
except (FileNotFoundError, json.JSONDecodeError):
    # A missing or corrupt config must not decide the outcome by accident: fall back to the
    # documented defaults, exactly as load-guard-eval.sh falls back on its state file.
    config = dict(DEFAULTS)

metrics = json.loads(metrics_json)

# ---- the two fail-safe branches (see the header block) ----
if "error" in metrics:
    if metrics.get("present"):
        if unreadable_policy == "admit":
            print("ADMIT unreadable (%s) [VRAM_GUARD_UNREADABLE=admit]" % metrics["error"])
            sys.exit(0)
        print("HOLD unreadable (%s)" % metrics["error"])
        sys.exit(1)
    print("ADMIT no-gpu (%s)" % metrics["error"])
    sys.exit(0)

used = metrics["used_mib"]
total = metrics["total_mib"]
pct = 100.0 * used / total

instantaneous = "ok"
if pct >= config["hard_pct"]:
    instantaneous = "hard"
elif pct >= config["soft_pct"]:
    instantaneous = "soft"

try:
    with open(state_path) as f:
        state = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    state = {"tier": "ok", "since": now, "pending": None}

current = state.get("tier", "ok")
pending = state.get("pending")

# Hysteresis, same shape as load-guard-eval.sh: a candidate tier must hold for sustained_seconds in
# EITHER direction before the confirmed tier moves, so one noisy reading never flips the gate. The
# GPU is exactly where a single sample lies: a model finishing a request frees gigabytes in one
# step, and a model loading claims them just as fast.
if instantaneous == current:
    pending = None
else:
    required = config["sustained_seconds"]
    if not pending or pending.get("tier") != instantaneous:
        pending = {"tier": instantaneous, "first_seen": now}
    elif now - pending["first_seen"] >= required:
        current = instantaneous
        state["since"] = now
        pending = None

state["tier"] = current
state["pending"] = pending
try:
    with open(state_path, "w") as f:
        json.dump(state, f)
        f.write("\n")
except OSError as e:
    # An unwritable state file costs the hysteresis, not the decision: without it every run starts
    # from "ok" and the gate degrades to instantaneous readings. Say so rather than crash a
    # dispatch path.
    print("vram-guard-check.sh: could not persist state (%s); hysteresis degraded" % e, file=sys.stderr)

verdict = "ADMIT" if current == "ok" else "HOLD"
print("%s %s %d/%d MiB (%.1f%%)" % (verdict, current, used, total, pct))
sys.exit(0 if verdict == "ADMIT" else 1)
PYEOF
