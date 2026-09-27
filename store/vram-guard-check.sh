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
# Output (stdout, one line): "ADMIT <tier> <used>/<total> MiB (<pct>%) ... util=<pct>%"
#                            "HOLD <tier> <used>/<total> MiB (<pct>%) ... util=<pct>%"
#                            "ADMIT no-gpu (<reason>)"      -- see FAIL-SAFE below
#                            "HOLD unreadable (<reason>)"   -- see FAIL-SAFE below
# Exit: 0 = ADMIT, 1 = HOLD, 2 = bad usage.
#
# ---------------------------------------------------------------------------------------------
# THE UTILIZATION DIMENSION (card 79aeaeb1, Peti request 2026-09-27, "ha a GPU magasabb mint 60%
# loaddal megy, akkor online-llm-re menjen csak a feladat").
#
# VRAM occupancy answers "is there room to load a model"; it says nothing about whether the GPU's
# compute is already saturated by a model that IS loaded and generating. Measured 2026-09-27:
# utilization.gpu=100%, VRAM 5939/6144 MiB -- comfortably under the VRAM hard tier, yet the compute
# is fully spoken for, so a new local dispatch would sit in Ollama's own queue rather than run.
#
# This is a SEPARATE gate glued onto the same guard, not a new script: `tier` above still means
# "VRAM pressure"; a second, independent tier (`gpu-util-hold`) covers compute pressure, and the
# final verdict HOLDs if EITHER one does. Deliberately NOT sharing the VRAM tier's own/foreign
# attribution: our own warm model's weights are excluded from VRAM pressure (that subtraction is
# the whole point of card efd18ee4), but our own model's COMPUTE counts fully toward utilization,
# on purpose -- the card asks for exactly this ("a saját Ollama terhelése is beleszámít... ha egy
# helyi draft épp fut, a következő ne várakozzon, hanem menjen online"). So the GPU_LOCK "our own
# job is loading" shortcut below still short-circuits the VRAM tier, but never the utilization one.
#
# Sampled (VRAM_GUARD_UTIL_SAMPLES / VRAM_GUARD_UTIL_SAMPLE_MS, default 1 sample -- see
# read_util_samples()'s own header for why the card's literal "3-5 minta -lms-sel" suggestion does
# not fit this box's nvidia-smi build) and reduced by MEDIAN when more than one sample is taken, so
# one spike among several cannot decide the tier by itself. The confirmed tier then goes through
# the SAME candidate/pending/sustained_seconds hysteresis shape as VRAM, on its own state keys, so
# a single CALL's reading cannot flip either gate either way -- the two layers (median within a
# call, hysteresis across calls) cover the "single sample lies" risk from different angles.
# Threshold: GPU_UTIL_HOLD_PCT env, else config's gpu_util_hold_pct, else 60.
#
# FAIL-SAFE follows the VRAM split exactly: tool absent -> not a subject, no hold; tool present but
# the utilization query fails/unreadable -> doubt, hold. In TEST MODE (--metrics-json given, i.e.
# the caller is not asking for a real read) utilization defaults to "not measured" -- admit on this
# dimension, do not touch its hysteresis -- unless the caller ALSO passes --util-samples-json, so
# every existing VRAM-only selftest case stays hermetic and unchanged.
# ---------------------------------------------------------------------------------------------
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
# The utilization dimension (card 79aeaeb1). Empty = use config's gpu_util_hold_pct (default 60);
# set = override without editing the config file, same convention as the other env knobs here.
GPU_UTIL_HOLD_PCT="${GPU_UTIL_HOLD_PCT:-}"
UTIL_SAMPLES="${VRAM_GUARD_UTIL_SAMPLES:-1}"
UTIL_SAMPLE_MS="${VRAM_GUARD_UTIL_SAMPLE_MS:-1000}"
# Defaults to the SAME bound as the VRAM read ($SMI_TIMEOUT), not a separate longer one: a
# production call already pays this timeout twice in the worst case (VRAM read, then utilization
# read), and a caller that tightens VRAM_GUARD_SMI_TIMEOUT for a hang almost certainly wants the
# utilization read bounded the same way, not left at a stale default.
UTIL_SMI_TIMEOUT="${VRAM_GUARD_UTIL_SMI_TIMEOUT:-$SMI_TIMEOUT}"
# The utilization test seam, same shape convention as --metrics-json/--own-vram-mib: empty = probe
# for real (but only when METRICS_JSON was ALSO empty -- see the REAL_RUN gate below), a value =
# hermetic input. '{"samples":[45,60,55]}' on success, '{"error":"...","present":bool}' on failure.
UTIL_SAMPLES_JSON="${VRAM_GUARD_UTIL_SAMPLES_JSON:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    --state) STATE="$2"; shift 2 ;;
    --metrics-json) METRICS_JSON="$2"; shift 2 ;;
    --util-samples-json) UTIL_SAMPLES_JSON="$2"; shift 2 ;;
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

# Emits one JSON line: {"samples":[45.0,60.0,...]} on success, or {"error":"...","present":bool} on
# failure -- same shape convention as read_vram_metrics, deliberately, so the decision code below
# can treat both fail-safe branches identically.
#
# MEASURED DEVIATION FROM THE CARD'S "pl. 3-5 minta -lms-sel" SUGGESTION. `-lms`/`-c` (repeated
# sampling inside one nvidia-smi process) is REJECTED outright on this box's own WSL passthrough
# build (NVIDIA-SMI 615.78.02): `nvidia-smi --query-gpu=utilization.gpu ... -lms 1000 -c 5` fails
# with "Option --query-gpu=utilization.gpu is not recognized" -- the flag combination itself is
# unsupported here, not a transient error. A manual shell loop of single-query calls is used
# instead: each one is exactly the query that already works on this box (`nvidia-smi
# --query-gpu=utilization.gpu --format=csv,noheader,nounits`, measured returning a bare number).
#
# DEFAULT IS ONE SAMPLE, NOT THREE-TO-FIVE. NVIDIA's own utilization.gpu is already a metric
# averaged by the driver over its own sample period (documented as "percent of time over the past
# sample period a kernel was executing"), not an instantaneous point read the way VRAM is -- so a
# single call already carries some smoothing, and the external sustained_seconds hysteresis below
# (same shape as the VRAM tier) is the second, cheaper layer against a one-off spike, rather than
# blocking every dispatch decision for several extra seconds of in-process sampling. Set
# VRAM_GUARD_UTIL_SAMPLES > 1 to opt into the card's literal multi-sample suggestion at the cost of
# that latency -- the loop below supports it, it is just not spent by default.
read_util_samples() {
  local smi=""
  if [ -n "$NVIDIA_SMI" ]; then
    smi="$NVIDIA_SMI"
  elif command -v nvidia-smi >/dev/null 2>&1; then
    smi="$(command -v nvidia-smi)"
  elif [ -x /usr/lib/wsl/lib/nvidia-smi ]; then
    smi=/usr/lib/wsl/lib/nvidia-smi
  fi

  if [ -z "$smi" ] || [ ! -x "$smi" ]; then
    printf '{"error":"nvidia-smi not found on PATH, at /usr/lib/wsl/lib, or via VRAM_GUARD_NVIDIA_SMI","present":false}\n'
    return 0
  fi

  local raw="" out="" i=1
  while [ "$i" -le "$UTIL_SAMPLES" ]; do
    if ! out="$(timeout "$UTIL_SMI_TIMEOUT" "$smi" --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>&1)"; then
      printf '{"error":"nvidia-smi utilization read failed or timed out: %s","present":true}\n' \
        "$(printf '%s' "$out" | tr '\n' ' ' | tr -d '"' | cut -c1-160)"
      return 0
    fi
    raw="$raw$out
"
    if [ "$i" -lt "$UTIL_SAMPLES" ]; then
      sleep "$(awk -v ms="$UTIL_SAMPLE_MS" 'BEGIN{printf "%.3f", ms/1000}')"
    fi
    i=$((i + 1))
  done

  # Multi-GPU: one row per device per call. Pooled into one median across every device and every
  # call rather than grouped by device -- a deliberate simplification (unlike VRAM, there is no
  # single "the model is placed on this one" framing for compute), fine for the single-GPU box
  # this card measured on, and no worse than ignoring the other devices entirely on a multi-GPU one.
  printf '%s' "$raw" | python3 -c '
import json, sys
samples = []
for line in sys.stdin.read().splitlines():
    line = line.strip().rstrip("%").strip()
    if not line:
        continue
    try:
        samples.append(float(line))
    except ValueError:
        print(json.dumps({"error": "unparseable utilization row: %s" % line[:80], "present": True}))
        sys.exit(0)
if not samples:
    print(json.dumps({"error": "nvidia-smi returned no usable utilization rows", "present": True}))
    sys.exit(0)
print(json.dumps({"samples": samples}))
'
}

# REAL_RUN tracks whether METRICS_JSON came from an actual probe (production call, both flags
# empty) rather than a caller-supplied seam (test mode). Utilization is only probed for real in the
# former case -- otherwise every EXISTING VRAM-only selftest case would also pay for (and depend
# on) a ~1s+ real nvidia-smi utilization read the moment this file lands on a box that has a GPU.
REAL_RUN=false
if [ -z "$METRICS_JSON" ]; then
  REAL_RUN=true
  METRICS_JSON="$(read_vram_metrics)"
fi

if [ -z "$UTIL_SAMPLES_JSON" ]; then
  if [ "$REAL_RUN" = true ]; then
    UTIL_SAMPLES_JSON="$(read_util_samples)"
  else
    # Test mode, no explicit utilization seam: not measured, admit on this dimension, do not touch
    # its hysteresis. This is what keeps every pre-79aeaeb1 selftest case's expectations valid.
    UTIL_SAMPLES_JSON='{"samples":[]}'
  fi
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
python3 - "$CONFIG" "$STATE" "$METRICS_JSON" "$NOW" "$VRAM_GUARD_UNREADABLE" "$OWN_VRAM_MIB" "$LOCK_HELD" "$UTIL_SAMPLES_JSON" "$GPU_UTIL_HOLD_PCT" <<'PYEOF'
import json
import os
import sys
import tempfile

(config_path, state_path, metrics_json, now_s, unreadable_policy, own_vram_s, lock_held_s,
 util_samples_json, gpu_util_hold_pct_env) = sys.argv[1:10]
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
    "gpu_util_hold_pct": 60,
}
try:
    with open(config_path) as f:
        config = {**DEFAULTS, **json.load(f)}
except (FileNotFoundError, json.JSONDecodeError):
    # A missing or corrupt config must not decide the outcome by accident: fall back to the
    # documented defaults, exactly as load-guard-eval.sh falls back on its state file.
    config = dict(DEFAULTS)

metrics = json.loads(metrics_json)
util_metrics = json.loads(util_samples_json)


def _persist(state_obj):
    # ATOMIC REPLACE, NOT AN IN-PLACE TRUNCATE (card eaef963d, Cybersec's measurement on 108c7b10).
    # `open(state_path, "w")` truncates the existing file in place before writing a byte of the new
    # content, so a concurrent reader can observe an EMPTY or half-written file mid-write, fail to
    # parse it, and fall back to the "ok" default -- silently erasing a confirmed HOLD for every
    # reader, including this run's own state file for the next caller. Measured: 40 concurrent
    # calls against a confirmed tier="hard" state lost the HOLD in 10/12 rounds; a plain flock
    # around the SAME truncating write did not fix it (0/12 fixed -- the wrong half of the
    # 09a3d52a pattern, which was a genuine cross-process lock problem, not a torn-write one).
    # Writing to a fresh temp file in the SAME directory (so the replace stays on one filesystem)
    # and calling os.replace() is what fixed it (0/12 corrupted, atomic replace alone, no lock): a
    # reader either sees the old complete file or the new complete file, never a partial one,
    # because a rename cannot be observed half-done. Both the VRAM tier and the utilization tier
    # (card 79aeaeb1) go through this SAME single write, so there is still exactly one atomic
    # replace per invocation, not two racing ones.
    try:
        state_dir = os.path.dirname(os.path.abspath(state_path)) or "."
        fd, tmp_path = tempfile.mkstemp(prefix=".vram-guard-state-", dir=state_dir)
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(state_obj, f)
                f.write("\n")
            os.replace(tmp_path, state_path)
        except BaseException:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
        return None
    except OSError as e:
        return e


# ---- the two fail-safe branches for VRAM (see the header block) ----
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

# ---- utilization reading (card 79aeaeb1, see the header block for the full reasoning) ----
# util_state_input: "ok" | "hold" | None. None means NOT MEASURED this call -- no GPU tool, or
# test mode without an explicit --util-samples-json -- and must neither hold nor touch the
# hysteresis, or every pre-79aeaeb1 selftest case would need updating.
util_pct = None
util_state_input = None  # "ok" | "hold" | None -- feeds the HYSTERESIS below (a measured value vs threshold)
util_doubt = False       # tool present but this read failed -- IMMEDIATE hold, bypasses hysteresis entirely,
                         # same as the VRAM early-exit case (b) never waiting for a "sustained" failure
samples = util_metrics.get("samples")
if isinstance(samples, list) and samples:
    s = sorted(samples)
    n = len(s)
    util_pct = s[n // 2] if n % 2 == 1 else (s[n // 2 - 1] + s[n // 2]) / 2.0
    try:
        util_threshold = float(gpu_util_hold_pct_env) if gpu_util_hold_pct_env else float(config["gpu_util_hold_pct"])
    except ValueError:
        util_threshold = float(config["gpu_util_hold_pct"])
    util_state_input = "hold" if util_pct >= util_threshold else "ok"
elif util_metrics.get("present"):
    # Tool present but the utilization query itself failed/unparseable: doubt, not absence -- same
    # direction AND same immediacy as the VRAM read's own case (b), which holds on the very first
    # unreadable call rather than waiting for sustained_seconds of failures.
    util_doubt = True
util_suffix = "" if util_pct is None else " util=%.0f%%" % util_pct

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

try:
    with open(state_path) as f:
        state = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    state = {"tier": "ok", "since": now, "pending": None}

# ---- utilization hysteresis, ALWAYS updated (card 79aeaeb1) ----
# Deliberately independent of the VRAM lock_held shortcut below: our own model's COMPUTE counts
# fully toward this dimension (the card asks for exactly this), so the state must accumulate
# whether or not our own job holds the GPU lock -- that lock only ever exempted the VRAM tier's
# own/foreign attribution, never this one. Same candidate/pending/sustained_seconds shape as the
# VRAM hysteresis below, on its own keys so the two tiers cannot clobber each other.
util_current = state.get("util_tier", "ok")
util_pending = state.get("util_pending")
if util_state_input is not None:
    if util_state_input == util_current:
        util_pending = None
    else:
        required = config["sustained_seconds"]
        if not util_pending or util_pending.get("tier") != util_state_input:
            util_pending = {"tier": util_state_input, "first_seen": now}
        elif now - util_pending["first_seen"] >= required:
            util_current = util_state_input
            util_pending = None
state["util_tier"] = util_current
state["util_pending"] = util_pending

# STATE 1: our own job holds the GPU lock. The VRAM load is ours by construction, including the
# model LOAD window that /api/ps cannot see yet, so this reading carries no information about
# foreign VRAM pressure -- the VRAM tier/pending are left untouched (not fed the reading), exactly
# as before card 79aeaeb1. The utilization tier, already updated above, is NOT exempted: a busy
# lock is exactly when the NEXT dispatch should go online rather than queue behind it.
if lock_held:
    persist_error = _persist(state)
    if persist_error is not None:
        print("vram-guard-check.sh: could not persist state (%s); hysteresis degraded" % persist_error, file=sys.stderr)
        util_hold_now = util_doubt or (util_state_input == "hold")
    else:
        util_hold_now = util_doubt or (util_current == "hold")
    if util_hold_now:
        print("HOLD gpu-util-hold own-busy %d/%d MiB (%.1f%%) %s%s" % (used, total, pct, detail, util_suffix))
        sys.exit(1)
    print("ADMIT own-busy %d/%d MiB (%.1f%%) %s%s" % (used, total, pct, detail, util_suffix))
    sys.exit(0)

instantaneous = "ok"
if foreign_pct >= config["hard_pct"]:
    instantaneous = "hard"
elif foreign_pct >= config["soft_pct"]:
    instantaneous = "soft"

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

persist_error = _persist(state)

if persist_error is not None:
    # AN UNWRITABLE STATE FILE MUST NOT READ AS A TIER (card eaef963d, second half of the same
    # finding). The comment this replaces claimed the gate "degrades to instantaneous readings",
    # but the code fell through to `current` -- the value loaded from (or defaulted for) the state
    # file BEFORE this failure -- which never advances past hysteresis without a working state
    # file to accumulate `pending` across calls. Measured: five calls over 140 simulated seconds at
    # a sustained 96% never held once; the guard silently became a permanent ADMIT, exactly the
    # failure mode the comment claimed NOT to have. The verdict on this branch now comes from
    # `instantaneous` -- what the comment already promised -- so a persist failure degrades the
    # HYSTERESIS (no memory across calls) without degrading the DIRECTION (still HOLD when the
    # current reading is over threshold). The utilization dimension degrades the same way, reading
    # its own instantaneous input rather than the (unwritten) confirmed tier.
    print("vram-guard-check.sh: could not persist state (%s); hysteresis degraded" % persist_error, file=sys.stderr)
    vram_hold_now = instantaneous != "ok"
    util_hold_now = util_doubt or (util_state_input == "hold")
    tier_label = instantaneous
else:
    vram_hold_now = current != "ok"
    util_hold_now = util_doubt or (util_current == "hold")
    tier_label = current

if vram_hold_now and util_hold_now:
    reason = "%s+gpu-util-hold" % tier_label
elif util_hold_now:
    reason = "gpu-util-hold"
else:
    reason = tier_label

verdict = "HOLD" if (vram_hold_now or util_hold_now) else "ADMIT"
print("%s %s %d/%d MiB (%.1f%%) %s%s" % (verdict, reason, used, total, pct, detail, util_suffix))
sys.exit(0 if verdict == "ADMIT" else 1)
PYEOF
