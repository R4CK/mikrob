#!/usr/bin/env bash
# local-llm-tune-sweep.sh -- run the local-LLM benchmark across MULTIPLE named Ollama server configs
# (card d747d772, alfeladat 711b696f / lepes 73b72fa5).
#
# WHY: local-llm-tune.sh applies ONE hand-measured, hardcoded config (FLASH_ATTENTION=1,
# KV_CACHE_TYPE=q8_0) to ONE machine -- exactly the "jelenlegi rogzitett ket ertek kozott valaszt"
# the card title calls out. This script generalizes that to N NAMED configs across the knobs
# alfeladat 1 (da98873f, `ollama serve --help` on the real host) confirmed exist: OLLAMA_FLASH_ATTENTION,
# OLLAMA_KV_CACHE_TYPE, OLLAMA_NUM_PARALLEL, OLLAMA_CONTEXT_LENGTH, OLLAMA_MAX_LOADED_MODELS,
# OLLAMA_GPU_OVERHEAD, OLLAMA_MAX_QUEUE -- driving the now contention-aware local-llm-bench.sh
# (d747d772/7529cabb, GPU flock) for each config and collecting one combined CSV.
#
# SCOPE: this MEASURES candidates only. It does NOT decide or auto-apply a winner -- that is
# alfeladat 3 (8192b9ee), per plan-grilling's explicit sequencing (comment 14327). local-llm-tune.sh
# is left untouched: it still exists as the simple "apply the one already-proven-good config" tool.
#
# SAFETY NET (plan-grilling 14327 point 5 -- preserve the existing --check/--revert-style guarantee
# in the generalized tool, do not lose it): the unit file is snapshotted VERBATIM before the sweep
# starts and restored VERBATIM by a trap that fires on normal exit, error, AND signal (INT/TERM) --
# the host must never be left running on a scratch mid-sweep config, no matter how the sweep ends.
#
# SERVICE-RESTART CONTENTION: switching configs restarts the whole ollama.service, which drops ANY
# in-flight request regardless of the GPU flock (the flock only serialises COOPERATING callers against
# each other; it cannot stop a restart from killing a request that is already running). So each
# restart is itself taken under the SAME GPU_LOCK as local-llm-bench.sh -- a real caller queued on the
# lock waits for the restart to finish and the server to come back up, instead of having its call
# killed mid-flight by a config switch it knows nothing about.
#
# USAGE:
#   local-llm-tune-sweep.sh [--configs-file F] [--ctx LIST] [--repeat N] [--dry-run]
#   --configs-file F   JSON array of {"name":..., "env": {...}}. Default: DEFAULT_CONFIGS below.
#   --dry-run          skip real daemon-reload/restart/bench; instead write each candidate's unit
#                       content to $OLLAMA_UNIT so the snapshot/restore path is genuinely exercised
#                       (file writes, not just printed intent), without touching the real service.
#                       Used by the selftest and for a sanity check before burning real GPU time.
#   --ctx / --repeat    passed straight through to local-llm-bench.sh.
set -uo pipefail

UNIT="${OLLAMA_UNIT:-$HOME/.config/systemd/user/ollama.service}"
BENCH="$(dirname "${BASH_SOURCE[0]}")/local-llm-bench.sh"
MARKER='# --- local-llm-tune-sweep (card d747d772) ---'
TUNE_MARKER='# --- local-llm-tune (card 7041c165) ---'   # local-llm-tune.sh's own block, stripped before each candidate

# Same lock as local-llm.sh / local-llm-bench.sh -- restarts must not blindside a queued real caller.
command -v flock >/dev/null 2>&1 || { echo "local-llm-tune-sweep: flock is required (util-linux) -- refusing to restart the GPU service unlocked" >&2; exit 3; }
GPU_LOCK="${LOCAL_LLM_GPU_LOCK_PATH:-/tmp/local-llm-gpu.lock}"
GPU_LOCK_WAIT="${LOCAL_LLM_LOCK_WAIT:-600}"
exec 9>"$GPU_LOCK" || { echo "local-llm-tune-sweep: cannot open GPU lock file $GPU_LOCK" >&2; exit 3; }

CONFIGS_FILE=""
CTX_LIST="4096"
REPEAT="3"
DRY_RUN=0
DRY_RUN_PAUSE="${LOCAL_LLM_SWEEP_DRY_PAUSE:-0.2}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --configs-file) CONFIGS_FILE="$2"; shift 2 ;;
    --ctx)          CTX_LIST="$2"; shift 2 ;;
    --repeat)       REPEAT="$2"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    *) echo "local-llm-tune-sweep: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

# Default: spans MORE than the old fixed pair -- a genuinely new knob (NUM_PARALLEL) and a second
# KV-quantisation level (q4_0), not just flash-attention on/off.
DEFAULT_CONFIGS='[
  {"name": "baseline",            "env": {}},
  {"name": "flash-q8",            "env": {"OLLAMA_FLASH_ATTENTION": "1", "OLLAMA_KV_CACHE_TYPE": "q8_0"}},
  {"name": "flash-q4",            "env": {"OLLAMA_FLASH_ATTENTION": "1", "OLLAMA_KV_CACHE_TYPE": "q4_0"}},
  {"name": "flash-q8-parallel1",  "env": {"OLLAMA_FLASH_ATTENTION": "1", "OLLAMA_KV_CACHE_TYPE": "q8_0", "OLLAMA_NUM_PARALLEL": "1"}}
]'
if [[ -n "$CONFIGS_FILE" ]]; then
  [[ -r "$CONFIGS_FILE" ]] || { echo "local-llm-tune-sweep: cannot read --configs-file $CONFIGS_FILE" >&2; exit 2; }
  CONFIGS_JSON="$(cat "$CONFIGS_FILE")"
else
  CONFIGS_JSON="$DEFAULT_CONFIGS"
fi
echo "$CONFIGS_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert isinstance(d, list) and d, "must be a non-empty JSON array"; [ (c["name"], c.get("env", {})) for c in d ]' \
  || { echo "local-llm-tune-sweep: --configs-file is not a valid [{name, env}] array" >&2; exit 2; }

[[ -f "$UNIT" ]] || { echo "local-llm-tune-sweep: no unit at $UNIT" >&2; exit 2; }

# --- snapshot, and the restore trap (the actual safety net) ---------------------------------------
BASELINE="$(mktemp)"
cp "$UNIT" "$BASELINE"
RESTORED=0
restore_baseline() {
  [[ "$RESTORED" == 1 ]] && return 0
  RESTORED=1
  cp "$BASELINE" "$UNIT"
  rm -f "$BASELINE"
  if [[ "$DRY_RUN" != 1 ]]; then
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user restart ollama 2>/dev/null || true
  fi
  echo "local-llm-tune-sweep: unit restored to its pre-sweep content" >&2
}
trap restore_baseline EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

build_unit_with_config() { # $1=env_json (compact JSON object) -> candidate unit content on stdout
  python3 - "$BASELINE" "$1" "$MARKER" "$TUNE_MARKER" <<'PY'
import re, sys, json
baseline_path, env_json, marker, tune_marker = sys.argv[1:5]
env = json.loads(env_json)
src = open(baseline_path, encoding='utf-8').read()
# Start from a clean baseline every time (no accumulation across configs): strip both this script's
# own marker block (harmless if absent -- BASELINE never contains it, kept for safety) and
# local-llm-tune.sh's block, plus any bare hand-added OLLAMA_* Environment lines.
for m in (marker, tune_marker):
    src = re.sub(re.escape(m) + r'.*?' + re.escape(m) + r'\n', '', src, flags=re.S)
src = re.sub(r'^Environment=OLLAMA_[A-Z_]+=.*\n', '', src, flags=re.M)
if env:
    lines = ''.join('Environment=%s=%s\n' % (k, v) for k, v in sorted(env.items()))
    block = marker + '\n' + lines + marker + '\n'
    anchor = '[Service]\n'
    if anchor not in src:
        sys.exit('no [Service] section in unit')
    src = src.replace(anchor, anchor + block, 1)
sys.stdout.write(src)
PY
}

echo "local-llm-tune-sweep: $(echo "$CONFIGS_JSON" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))') config(s), unit=$UNIT, dry_run=$DRY_RUN" >&2

echo "$CONFIGS_JSON" | python3 -c '
import json, sys
for c in json.load(sys.stdin):
    print(c["name"] + "\t" + json.dumps(c.get("env", {})))
' | while IFS=$'\t' read -r name env_json; do
  echo "--- config: $name ---" >&2
  candidate="$(build_unit_with_config "$env_json")" || { echo "local-llm-tune-sweep: config '$name' build failed" >&2; exit 2; }

  if ! flock -w "$GPU_LOCK_WAIT" 9; then
    echo "local-llm-tune-sweep: GPU lock busy -- skipping config '$name' (not attempted)" >&2
    continue
  fi
  printf '%s' "$candidate" > "$UNIT"

  if [[ "$DRY_RUN" == 1 ]]; then
    echo "local-llm-tune-sweep: [dry-run] would daemon-reload + restart + bench --label=$name" >&2
    sleep "$DRY_RUN_PAUSE"   # overridable so the selftest can land a SIGTERM reliably mid-sweep
    flock -u 9
    continue
  fi

  if ! systemctl --user daemon-reload || ! systemctl --user restart ollama; then
    echo "local-llm-tune-sweep: config '$name' failed to restart ollama -- aborting sweep" >&2
    flock -u 9
    exit 2
  fi
  sleep 4
  if ! systemctl --user is-active ollama >/dev/null; then
    echo "local-llm-tune-sweep: config '$name' -- ollama not active after restart -- aborting sweep" >&2
    flock -u 9
    exit 2
  fi
  flock -u 9   # release before bench: bench takes its OWN short-lived locks per generate call

  bash "$BENCH" --ctx "$CTX_LIST" --repeat "$REPEAT" --label "$name" | { [[ "$name" != "baseline" ]] && tail -n +2 || cat; }
done
# `exit 2` inside the while above only ends that subshell (it's the tail of a pipeline) -- without
# checking its status here a real restart failure would be swallowed and the script would exit 0.
# A trailing `[[ ... ]] && exit N` would itself leave $? = 1 (the failed test) as the script's own
# exit status on the success path, with nothing after it to override -- explicit branches instead.
sweep_rc=$?
if [[ "$sweep_rc" -ne 0 ]]; then
  exit "$sweep_rc"
fi
exit 0
