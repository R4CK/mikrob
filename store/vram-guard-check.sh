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
# The two ATTRIBUTION inputs (card efd18ee4). Empty = probe for real; a value = the test seam, the
# same shape --metrics-json already uses so the selftest never needs a GPU or a running ollama.
# Env defaults exist for the same reason VRAM_GUARD_NVIDIA_SMI does: a selftest must be able to
# make the whole run hermetic ONCE, instead of remembering to pass a flag at every call site --
# a case added without the flag would silently start reading the developer's live ollama.
OWN_VRAM_MIB="${VRAM_GUARD_OWN_VRAM_MIB:-}"
LOCK_HELD="${VRAM_GUARD_LOCK_HELD:-}"
OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
OLLAMA_PS_TIMEOUT="${VRAM_GUARD_OLLAMA_TIMEOUT:-2}"
# Must stay the same path local-llm.sh serialises generation on, or the "our own job is running"
# state is measured against a lock nobody takes.
GPU_LOCK="${LOCAL_LLM_GPU_LOCK_PATH:-/tmp/local-llm-gpu.lock}"

while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    --state) STATE="$2"; shift 2 ;;
    --metrics-json) METRICS_JSON="$2"; shift 2 ;;
    --own-vram-mib) OWN_VRAM_MIB="$2"; shift 2 ;;
    --lock-held) LOCK_HELD="$2"; shift 2 ;;
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

# ---- attribution ------------------------------------------------------------------------------
# WHY A PERCENTAGE ALONE CANNOT DECIDE THIS (card efd18ee4, MikroB comment 21170 on 108c7b10).
#
# A VRAM reading says HOW FULL the card is, never WHO filled it -- and on this box the difference
# is the whole answer. Measured 2026-09-06: total 6144 MiB, 1649 MiB resident with ollama stopped
# (desktop/WSL baseline, 26.8%), and the default local model's own weights are 4466 MiB. Our own
# WARM model therefore reads ~99.5% -- past hard_pct -- so the threshold shipped in 108c7b10 would
# HOLD every local dispatch precisely in the steady state the warm model exists to create. That is
# not a tuning problem: no threshold separates "our 4.4 GB model is loaded" from "something else
# ate 4.4 GB", because the number is identical.
#
# So the pressure that decides is the FOREIGN share: used minus what ollama says it is holding.
#
# The lock is not redundant with that subtraction, and the reason is narrow: while a model is being
# LOADED, VRAM climbs before /api/ps reports it, so the subtraction reads 0 and the whole load
# looks foreign. local-llm.sh holds this flock across exactly that window.
read_own_vram_mib() {
  local out
  if ! out="$(curl -fsS -m "$OLLAMA_PS_TIMEOUT" "$OLLAMA_HOST/api/ps" 2>/dev/null)"; then
    # Unreachable or stopped (the gpu-crashloop-guard stops it on purpose). Nothing of ours is
    # resident that we can prove, so nothing is subtracted and the whole reading counts as foreign.
    # That errs toward HOLD, i.e. toward ONLINE, which is the direction both the parent card and
    # CLAUDE.md rule 16 require on doubt.
    printf '0
'; return 0
  fi
  printf '%s' "$out" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    total = sum(int(m.get("size_vram") or 0) for m in (d.get("models") or []))
except Exception:
    # A present-but-unparseable answer is doubt, not absence: attribute nothing to ourselves.
    total = 0
print(total // (1024 * 1024))
'
}

# `flock -n` acquires and releases immediately when the lock is free; it only fails when someone
# else holds it. Probing this way costs a microsecond of contention and needs no bookkeeping of
# our own -- a PID file would have to be kept truthful across crashes, which is how a flag that
# records a decision outlives the decision.
probe_gpu_lock() {
  if [ ! -e "$GPU_LOCK" ]; then printf 'no
'; return 0; fi
  if flock -n "$GPU_LOCK" true 2>/dev/null; then printf 'no
'; else printf 'yes
'; fi
}

[ -n "$OWN_VRAM_MIB" ] || OWN_VRAM_MIB="$(read_own_vram_mib)"
[ -n "$LOCK_HELD" ] || LOCK_HELD="$(probe_gpu_lock)"

# ---- decision ---------------------------------------------------------------------------------
python3 - "$CONFIG" "$STATE" "$METRICS_JSON" "$NOW" "$VRAM_GUARD_UNREADABLE" "$OWN_VRAM_MIB" "$LOCK_HELD" <<'PYEOF'
import json
import sys

config_path, state_path, metrics_json, now_s, unreadable_policy, own_vram_s, lock_held_s = sys.argv[1:8]
now = int(now_s)
try:
    own_vram_mib = max(0, int(own_vram_s))
except ValueError:
    own_vram_mib = 0
lock_held = lock_held_s == 'yes'

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

# ---- three-state attribution (card efd18ee4) ----
# The tier is computed from the FOREIGN share, not from the raw reading. See the shell header
# above for the measurement that makes this necessary rather than merely nicer.
#
# own_vram > used means the two measurements disagree with each other -- ollama claiming more VRAM
# than the device reports is an accounting fault, not evidence that the GPU is free. Attributing
# nothing to ourselves in that case leaves the whole reading foreign, which points at HOLD; the
# opposite (clamping foreign to zero) would ADMIT on exactly the input we understand least.
attributable = own_vram_mib if own_vram_mib <= used else 0
foreign = used - attributable
foreign_pct = 100.0 * foreign / total
detail = "own=%d foreign=%d (%.1f%%)" % (attributable, foreign, foreign_pct)

# STATE 1: our own job holds the GPU lock. The load is ours by construction, including the model
# LOAD window that /api/ps cannot see yet, so this reading carries no information about foreign
# pressure. It is also not written to the state file: feeding our own load into the hysteresis is
# how the tier would learn to distrust us. The next lock-free run resumes from the last confirmed
# tier.
if lock_held:
    print("ADMIT own-busy %d/%d MiB (%.1f%%) %s" % (used, total, pct, detail))
    sys.exit(0)

instantaneous = "ok"
if foreign_pct >= config["hard_pct"]:
    instantaneous = "hard"
elif foreign_pct >= config["soft_pct"]:
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
print("%s %s %d/%d MiB (%.1f%%) %s" % (verdict, current, used, total, pct, detail))
sys.exit(0 if verdict == "ADMIT" else 1)
PYEOF
