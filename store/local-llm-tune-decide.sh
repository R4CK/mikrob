#!/usr/bin/env bash
# local-llm-tune-decide.sh -- choose and apply the best Ollama config from a sweep CSV
# (card 8192b9ee, FAZIS 1c542799 alfeladat 3).
#
# WHY THIS EXISTS: local-llm-tune.sh applies ONE hardcoded config (flash-attention + q8_0) chosen by
# a human after a manual benchmark run. local-llm-tune-sweep.sh generalizes the measurement to N named
# configs. This script closes the loop: it reads the sweep CSV and AUTOMATICALLY picks the best config
# using noise-resistant decision logic, then applies it using the same unit-file mechanism.
#
# DECISION LOGIC (plan-grilling comment 14327, points 3 + 4):
#   (3) Regression guard -- the winner must beat baseline by MORE than noise:
#         median(winner) > median(baseline) + MARGIN_TPS    [default: 2.0 tok/s]
#         min(winner)    > median(baseline)                  [SOHA ne legyen rosszabb -- no single rep
#                                                             can fall below baseline median]
#   (4) Soak/stability guard -- must have >= MIN_REPS successful reps in the CSV (default: 2) so a
#       single lucky run cannot win.
#   If no config clears both guards: keeps the current unit unchanged (baseline is optimal), exits 0.
#   If a winner is found: applies its env vars and restarts under the GPU lock.
#
# SAFETY NET (plan-grilling point 5 -- same as local-llm-tune.sh):
#   --check    show currently applied config; change nothing (exit 0=applied, 1=none/baseline)
#   --revert   remove the applied config and restart ollama
#
# USAGE:
#   local-llm-tune-sweep.sh [--configs-file F] | local-llm-tune-decide.sh [--configs-file F]
#   local-llm-tune-decide.sh --csv results.csv [--configs-file F] [--ctx CTX]
#                             [--margin-tps N] [--min-reps N] [--dry-run]
#   local-llm-tune-decide.sh --check
#   local-llm-tune-decide.sh --revert [--dry-run]
#
# SERVICE-RESTART CONTENTION: applying a winner restarts ollama, which drops any in-flight request.
# The restart is serialised through the SAME GPU lock used by local-llm.sh and local-llm-bench.sh --
# a real caller queued on the lock waits for the restart, not killed mid-flight (same pattern as
# local-llm-tune-sweep.sh, see its header for the full rationale).

set -uo pipefail

UNIT="${OLLAMA_UNIT:-$HOME/.config/systemd/user/ollama.service}"
MARKER='# --- local-llm-tune-decide (card 8192b9ee) ---'
TUNE_MARKER='# --- local-llm-tune (card 7041c165) ---'
SWEEP_MARKER='# --- local-llm-tune-sweep (card d747d772) ---'

command -v flock >/dev/null 2>&1 || { echo "local-llm-tune-decide: flock is required (util-linux) -- refusing to restart the GPU service unlocked" >&2; exit 3; }
GPU_LOCK="${LOCAL_LLM_GPU_LOCK_PATH:-/tmp/local-llm-gpu.lock}"
GPU_LOCK_WAIT="${LOCAL_LLM_LOCK_WAIT:-600}"
exec 9>"$GPU_LOCK" || { echo "local-llm-tune-decide: cannot open GPU lock file $GPU_LOCK" >&2; exit 3; }

CSV_FILE=""
CONFIGS_FILE=""
CTX_FILTER=""
MARGIN_TPS="${LOCAL_LLM_DECIDE_MARGIN:-2.0}"
MIN_REPS="${LOCAL_LLM_DECIDE_MIN_REPS:-2}"
DRY_RUN=0
MODE="decide"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --csv)          CSV_FILE="$2"; shift 2 ;;
    --configs-file) CONFIGS_FILE="$2"; shift 2 ;;
    --ctx)          CTX_FILTER="$2"; shift 2 ;;
    --margin-tps)   MARGIN_TPS="$2"; shift 2 ;;
    --min-reps)     MIN_REPS="$2"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --check)        MODE="check"; shift ;;
    --revert)       MODE="revert"; shift ;;
    *) echo "local-llm-tune-decide: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

[[ -f "$UNIT" ]] || { echo "local-llm-tune-decide: no unit at $UNIT" >&2; exit 2; }

# --check: read-only, no lock needed
if [[ "$MODE" == "check" ]]; then
  if grep -qF "$MARKER" "$UNIT" 2>/dev/null; then
    echo "local-llm-tune-decide: sweep-decision config IS applied:"
    python3 - "$UNIT" "$MARKER" <<'PY'
import re, sys
path, marker = sys.argv[1], sys.argv[2]
src = open(path, encoding='utf-8').read()
m = re.search(re.escape(marker) + r'(.*?)' + re.escape(marker), src, re.S)
if m:
    for line in m.group(1).splitlines():
        if line.startswith('Environment='):
            print('  ' + line)
PY
    exit 0
  else
    echo "local-llm-tune-decide: no sweep-decision config applied (baseline or unmanaged unit)"
    exit 1
  fi
fi

# Strip ALL managed blocks + bare OLLAMA_* lines.  Used before both apply and revert.
strip_markers() {
  python3 - "$UNIT" "$MARKER" "$TUNE_MARKER" "$SWEEP_MARKER" <<'PY'
import re, sys
path = sys.argv[1]
src = open(path, encoding='utf-8').read()
for marker in sys.argv[2:]:
    src = re.sub(re.escape(marker) + r'.*?' + re.escape(marker) + r'\n', '', src, flags=re.S)
src = re.sub(r'^Environment=OLLAMA_[A-Z_]+=.*\n', '', src, flags=re.M)
open(path, 'w', encoding='utf-8').write(src)
PY
}

# --revert
if [[ "$MODE" == "revert" ]]; then
  strip_markers
  if [[ "$DRY_RUN" != 1 ]]; then
    flock -w "$GPU_LOCK_WAIT" 9 || { echo "local-llm-tune-decide: GPU lock busy during revert -- aborting" >&2; exit 2; }
    systemctl --user daemon-reload 2>/dev/null || exit 2
    systemctl --user restart ollama 2>/dev/null || exit 2
    sleep 4
    systemctl --user is-active ollama >/dev/null 2>&1 || { echo "local-llm-tune-decide: ollama failed to restart after revert" >&2; flock -u 9; exit 2; }
    flock -u 9
  fi
  echo "local-llm-tune-decide: reverted; unit at $UNIT has no sweep-decision config" >&2
  exit 0
fi

# --- decide mode ---

# Load configs JSON (env vars for each named config, for unit injection when winner is found)
if [[ -n "$CONFIGS_FILE" ]]; then
  [[ -r "$CONFIGS_FILE" ]] || { echo "local-llm-tune-decide: cannot read --configs-file $CONFIGS_FILE" >&2; exit 2; }
  CONFIGS_JSON="$(cat "$CONFIGS_FILE")"
else
  # Mirror of local-llm-tune-sweep.sh DEFAULT_CONFIGS (card bf8ae414 -- keep in sync):
  # all 6 OLLAMA_* knobs + LLAMA_ARG_FIT_TARGET covered.
  CONFIGS_JSON='[
  {"name": "baseline",                  "env": {}},
  {"name": "flash-q8",                  "env": {"OLLAMA_FLASH_ATTENTION": "1", "OLLAMA_KV_CACHE_TYPE": "q8_0"}},
  {"name": "flash-q4",                  "env": {"OLLAMA_FLASH_ATTENTION": "1", "OLLAMA_KV_CACHE_TYPE": "q4_0"}},
  {"name": "flash-q8-parallel1",        "env": {"OLLAMA_FLASH_ATTENTION": "1", "OLLAMA_KV_CACHE_TYPE": "q8_0", "OLLAMA_NUM_PARALLEL": "1"}},
  {"name": "flash-q8-gpu0",             "env": {"OLLAMA_FLASH_ATTENTION": "1", "OLLAMA_KV_CACHE_TYPE": "q8_0", "OLLAMA_GPU_OVERHEAD": "0"}},
  {"name": "flash-q8-fit0",             "env": {"OLLAMA_FLASH_ATTENTION": "1", "OLLAMA_KV_CACHE_TYPE": "q8_0", "LLAMA_ARG_FIT_TARGET": "0"}},
  {"name": "flash-q8-ctx8k",            "env": {"OLLAMA_FLASH_ATTENTION": "1", "OLLAMA_KV_CACHE_TYPE": "q8_0", "OLLAMA_CONTEXT_LENGTH": "8192"}},
  {"name": "flash-q8-queue1",           "env": {"OLLAMA_FLASH_ATTENTION": "1", "OLLAMA_KV_CACHE_TYPE": "q8_0", "OLLAMA_MAX_QUEUE": "1"}},
  {"name": "flash-q8-gpu0-fit0-par1",   "env": {"OLLAMA_FLASH_ATTENTION": "1", "OLLAMA_KV_CACHE_TYPE": "q8_0", "OLLAMA_GPU_OVERHEAD": "0", "LLAMA_ARG_FIT_TARGET": "0", "OLLAMA_NUM_PARALLEL": "1"}}
]'
fi

# Read CSV (stdin or --csv file)
if [[ -n "$CSV_FILE" ]]; then
  [[ -r "$CSV_FILE" ]] || { echo "local-llm-tune-decide: cannot read --csv $CSV_FILE" >&2; exit 2; }
  CSV_DATA="$(cat "$CSV_FILE")"
else
  CSV_DATA="$(cat)"
fi
[[ -n "$CSV_DATA" ]] || { echo "local-llm-tune-decide: empty CSV input (no data on stdin and no --csv file given)" >&2; exit 2; }

# Decision logic: pure Python, no GPU needed, deterministic given the CSV.
# CSV is passed via env var to avoid the pipe-vs-heredoc stdin conflict: `echo "$X" | python3 - <<'PY'`
# would have the pipe AND the heredoc both claim stdin -- the heredoc wins, the pipe is lost.
DECISION="$(CSV_DATA="$CSV_DATA" CTX_FILTER="$CTX_FILTER" MARGIN="$MARGIN_TPS" MIN_REPS="$MIN_REPS" \
  python3 - "$CONFIGS_JSON" <<'PY'
import sys, json, os, io, statistics
from collections import Counter

configs_json_str = sys.argv[1]
ctx_filter       = os.environ.get("CTX_FILTER", "")
margin           = float(os.environ.get("MARGIN", "2.0"))
min_reps         = int(os.environ.get("MIN_REPS", "2"))
csv_text         = os.environ.get("CSV_DATA", "")

try:
    configs = {c["name"]: c.get("env", {}) for c in json.loads(configs_json_str)}
except Exception as exc:
    print("ERROR:invalid_configs:" + str(exc))
    sys.exit(0)

# Parse CSV: label,model,ctx,gpu_split,ctx_loaded,kv_mib,kv_type,load_ms,prompt_tps,eval_tps,ok
rows = []
for line in io.StringIO(csv_text):
    line = line.strip()
    if not line or line.startswith("label,"):
        continue
    parts = line.split(",")
    if len(parts) < 11:
        continue
    label    = parts[0]
    ctx_str  = parts[2]
    etps_str = parts[9]
    ok       = parts[10].strip()
    if ok != "ok":
        continue
    try:
        ctx  = int(ctx_str)
        etps = float(etps_str)
    except (ValueError, TypeError):
        continue
    if ctx_filter and str(ctx) != ctx_filter:
        continue
    rows.append({"label": label, "ctx": ctx, "etps": etps})

if not rows:
    print("ERROR:no_ok_rows:no successful rows in CSV (all FAIL/LOCKBUSY/skipped?)")
    sys.exit(0)

# Primary ctx: most common; ties broken by smallest value (conservative -- smaller ctx is more stable)
ctx_counts  = Counter(r["ctx"] for r in rows)
primary_ctx = min(ctx_counts, key=lambda c: (-ctx_counts[c], c))

# Group by label at primary_ctx only
by_label = {}
for r in rows:
    if r["ctx"] == primary_ctx:
        by_label.setdefault(r["label"], []).append(r["etps"])

if "baseline" not in by_label or not by_label["baseline"]:
    print("ERROR:no_baseline:ctx=%d -- CSV must include a 'baseline' config row" % primary_ctx)
    sys.exit(0)

baseline_median = statistics.median(by_label["baseline"])

# Evaluate each non-baseline config
best_label  = None
best_median = -1.0
reasons     = []

for label in sorted(by_label):
    if label == "baseline":
        continue
    if label not in configs:
        reasons.append("%s:not_in_configs_file" % label)
        continue
    tps_list = by_label[label]
    if len(tps_list) < min_reps:
        reasons.append("%s:too_few_reps(%d<%d)" % (label, len(tps_list), min_reps))
        continue
    med     = statistics.median(tps_list)
    min_tps = min(tps_list)
    # Guard 1: median improvement must exceed noise floor (margin)
    if med <= baseline_median + margin:
        reasons.append("%s:below_margin(median=%.1f<=%.1f+%.1f)" % (
            label, med, baseline_median, margin))
        continue
    # Guard 2: SOHA ne legyen rosszabb -- no single rep below baseline median
    if min_tps <= baseline_median:
        reasons.append("%s:worst_rep_not_above_baseline(min=%.1f<=baseline_median=%.1f)" % (
            label, min_tps, baseline_median))
        continue
    if med > best_median:
        best_median  = med
        best_label   = label

if best_label is None:
    print("NOOP:baseline_is_optimal:ctx=%d,baseline_median=%.1f,margin=%.1f,reasons=%s" % (
        primary_ctx, baseline_median, margin,
        (";".join(reasons) if reasons else "no_other_configs_in_csv")))
    sys.exit(0)

winner_env  = configs[best_label]
improvement = best_median - baseline_median
print("WIN:%s:ctx=%d,baseline_median=%.1f,winner_median=%.1f,improvement=+%.1f:env=%s" % (
    best_label, primary_ctx, baseline_median, best_median, improvement,
    json.dumps(winner_env, separators=(",", ":"))))
PY
)"

case "${DECISION%%:*}" in
  ERROR)
    echo "local-llm-tune-decide: decision error -- $DECISION" >&2
    exit 2
    ;;
  NOOP)
    echo "local-llm-tune-decide: baseline is already optimal (no config beats margin $MARGIN_TPS tok/s)" >&2
    echo "  $DECISION" >&2
    exit 0
    ;;
  WIN)
    # Format: WIN:<label>:<details>:env=<json>
    # details contains no colons; env JSON does, so we cannot use cut -f past field 3.
    winner_label="$(printf '%s' "$DECISION" | cut -d: -f2)"
    winner_env_json="$(printf '%s' "$DECISION" | sed 's/^[^:]*:[^:]*:[^:]*:env=//')"
    winner_details="$(printf '%s' "$DECISION" | sed 's/^[^:]*:[^:]*://;s/:env=.*//')"
    echo "local-llm-tune-decide: winner=$winner_label ($winner_details)" >&2
    ;;
  *)
    echo "local-llm-tune-decide: unexpected decision output: $DECISION" >&2
    exit 2
    ;;
esac

# Apply winner: strip all managed blocks first (idempotent), then inject winner's env vars
strip_markers
[[ $? -eq 0 ]] || { echo "local-llm-tune-decide: failed to strip unit file" >&2; exit 2; }

python3 - "$UNIT" "$MARKER" "$winner_env_json" <<'PY'
import re, sys, json
path, marker, env_json = sys.argv[1], sys.argv[2], sys.argv[3]
env = json.loads(env_json)
src = open(path, encoding='utf-8').read()
if env:
    lines = ''.join('Environment=%s=%s\n' % (k, v) for k, v in sorted(env.items()))
    block = marker + '\n' + lines + marker + '\n'
    anchor = '[Service]\n'
    if anchor not in src:
        sys.exit('local-llm-tune-decide: no [Service] section in unit file')
    src = src.replace(anchor, anchor + block, 1)
open(path, 'w', encoding='utf-8').write(src)
PY
[[ $? -eq 0 ]] || { echo "local-llm-tune-decide: failed to write winner config to unit file" >&2; exit 2; }

if [[ "$DRY_RUN" == 1 ]]; then
  echo "local-llm-tune-decide: [dry-run] unit written for winner=$winner_label; would daemon-reload + restart" >&2
  exit 0
fi

# Restart under GPU lock (same rationale as local-llm-tune-sweep.sh -- a queued real caller must not
# be killed mid-flight by a config switch it knows nothing about)
if ! flock -w "$GPU_LOCK_WAIT" 9; then
  echo "local-llm-tune-decide: GPU lock busy after $GPU_LOCK_WAIT s -- unit written but could not restart; run systemctl --user daemon-reload + restart ollama manually" >&2
  exit 2
fi
systemctl --user daemon-reload 2>/dev/null || { flock -u 9; exit 2; }
systemctl --user restart ollama 2>/dev/null || { flock -u 9; exit 2; }
sleep 4
if ! systemctl --user is-active ollama >/dev/null 2>&1; then
  echo "local-llm-tune-decide: ollama failed to restart after applying winner=$winner_label" >&2
  flock -u 9
  exit 2
fi
flock -u 9
echo "local-llm-tune-decide: applied winner=$winner_label; ollama active" >&2
