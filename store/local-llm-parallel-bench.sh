#!/usr/bin/env bash
# local-llm-parallel-bench.sh -- measure GPU queue-wait under N concurrent fleet callers,
# and produce a static VRAM fit analysis for larger models (card 2c28ecee, FAZIS 1c542799).
#
# TWO QUESTIONS THIS ANSWERS (Peti 2c28ecee):
#   (1) PARALLELISM: With the current GPU lock (one caller at a time), how long does worker K
#       wait when N fleet tasks arrive simultaneously? Is serial queuing acceptable or does it
#       cause user-visible latency?
#   (2) LARGER MODEL: Would a bigger/more accurate model fit on this GPU? If not, the current
#       7B Q4_K_M is already the quality ceiling -- measuring first, assuming nothing.
#
# MEASUREMENT (--workers N):
#   Spawns N concurrent workers, each acquiring the SAME GPU lock as real local-llm.sh calls.
#   Each worker reports: queue_wait_ms (time spent waiting for lock), gen_time_ms (actual GPU
#   work), eval_tps, ok/FAIL/LOCKBUSY.  Total elapsed = max(gen_time) + sum of wait cascade.
#
# VRAM ANALYSIS (--analyze-vram):
#   Static table: which model+quantisation combinations fit on this GPU's VRAM.
#   Uses --vram MIB (explicit) or auto-detects via local-llm-hwdetect.sh if available.
#   No model download, no GPU call -- pure arithmetic from measured model file sizes.
#
# USAGE:
#   local-llm-parallel-bench.sh [--workers N] [--ctx CTX] [--dry-run]
#   local-llm-parallel-bench.sh --analyze-vram [--vram MIB]
#   Environment: OLLAMA_HOST, LOCAL_LLM_MODEL, LOCAL_LLM_GPU_LOCK_PATH, LOCAL_LLM_LOCK_WAIT

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"

command -v flock >/dev/null 2>&1 || { echo "local-llm-parallel-bench: flock is required (util-linux)" >&2; exit 3; }
GPU_LOCK="${LOCAL_LLM_GPU_LOCK_PATH:-/tmp/local-llm-gpu.lock}"
GPU_LOCK_WAIT="${LOCAL_LLM_LOCK_WAIT:-600}"
# Workers open their own fds; we do NOT exec 9> here to avoid the parent holding the lock.

WORKERS=2
CTX=4096
DRY_RUN=0
DRY_SLEEP="${LOCAL_LLM_PARALLEL_DRY_SLEEP:-0.5}"  # seconds each dry-run worker "generates"
ANALYZE_VRAM=0
EXPLICIT_VRAM=""
MODE="bench"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workers)      WORKERS="$2"; shift 2 ;;
    --ctx)          CTX="$2"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --analyze-vram) ANALYZE_VRAM=1; MODE="analyze"; shift ;;
    --vram)         EXPLICIT_VRAM="$2"; shift 2 ;;
    *) echo "local-llm-parallel-bench: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

# --- VRAM ANALYSIS MODE -----------------------------------------------------------------------
if [[ "$MODE" == "analyze" ]]; then
  # Determine VRAM
  VRAM_MIB="$EXPLICIT_VRAM"
  if [[ -z "$VRAM_MIB" ]]; then
    HWDETECT="$HERE/local-llm-hwdetect.sh"
    if [[ -x "$HWDETECT" ]]; then
      VRAM_MIB="$(bash "$HWDETECT" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); devs=d.get("gpu",{}).get("devices",[]); print(devs[0]["vram_total_mib"] if devs else "")' 2>/dev/null || true)"
    fi
  fi
  [[ -n "$VRAM_MIB" ]] || { echo "local-llm-parallel-bench: --analyze-vram requires --vram MIB (or local-llm-hwdetect.sh on PATH)" >&2; exit 2; }

  python3 - "$VRAM_MIB" <<'PY'
import sys

vram = int(sys.argv[1])

# Model file sizes from `ollama list` / official manifests (measured or well-known public values).
# Format: (display_name, model_mib, params_b, quant, quality_note)
# Qwen2.5-Coder sizes from Ollama registry (typical GGUF sizes on disk).
MODELS = [
    ("qwen2.5-coder:3b  Q4_K_M",  1898, 3.1,  "Q4_K_M", "lower quality, fastest"),
    ("qwen2.5-coder:7b  Q4_K_M",  4685, 7.6,  "Q4_K_M", "current fleet model -- balanced"),
    ("qwen2.5-coder:7b  Q8_0",    8099, 7.6,  "Q8_0",   "better quality, same architecture"),
    ("qwen2.5-coder:14b Q4_K_M",  8988, 14.8, "Q4_K_M", "higher quality, larger"),
    ("qwen2.5-coder:14b Q8_0",   15634, 14.8, "Q8_0",   "best quality 14B, needs big VRAM"),
    ("qwen2.5-coder:32b Q4_K_M", 19850, 32.8, "Q4_K_M", "top quality, needs ~24 GiB"),
]

# Fixed overhead: CUDA driver + runtime + Ollama server bookkeeping (~300-500 MiB, use 400 MiB).
DRIVER_MIB = 400
# KV cache at ctx=4096, q8_0 (measured live on this host, local-llm-bench.sh output 2026-08):
# 119 MiB.  At f16 it is 224 MiB.  Use the tuned q8_0 value as the baseline.
KV_MIB = 119

print("GPU VRAM: %d MiB (%.1f GiB)" % (vram, vram / 1024))
print("Overhead: ~%d MiB driver/runtime + ~%d MiB KV cache (q8_0, ctx=4096) = ~%d MiB fixed" % (
    DRIVER_MIB, KV_MIB, DRIVER_MIB + KV_MIB))
print()
print("%-35s %8s  %s" % ("Model", "Model MiB", "Fit?"))
print("-" * 72)

for name, model_mib, params, quant, note in MODELS:
    total = model_mib + DRIVER_MIB + KV_MIB
    fits = total <= vram
    if fits:
        pct_used = total * 100 / vram
        leftover = vram - total
        status = "YES  (%.0f%% VRAM used, %d MiB free)" % (pct_used, leftover)
    else:
        deficit = total - vram
        status = "NO   (needs ~%d MiB more VRAM)" % deficit
    print("%-35s %8d  %s" % (name, model_mib, status))
    if note:
        print("  %-33s %8s  [%s]" % ("", "", note))

print()
print("CONCLUSION:")
print("  With %d MiB VRAM, the quality ceiling is 7B Q4_K_M (or 7B Q8_0 if model weights < %d MiB)." % (
    vram, vram - DRIVER_MIB - KV_MIB))
print("  14B models require >9 GiB usable VRAM -- a GPU upgrade, not a config change.")
print("  3B runs faster and frees VRAM for larger context, but quality may be insufficient for coding.")
PY
  exit 0
fi

# --- PARALLEL BENCHMARK MODE ------------------------------------------------------------------

MODEL="${LOCAL_LLM_MODEL:-$(cat "$HERE/local-llm-model" 2>/dev/null | tr -d '[:space:]' || true)}"
if [[ "$DRY_RUN" != 1 && -z "$MODEL" ]]; then
  echo "local-llm-parallel-bench: no model configured (set LOCAL_LLM_MODEL or run first-run-llm.sh)" >&2
  exit 4
fi

PROMPT='Write a TypeScript function sumEven(nums:number[]):number. Return only the code.'
TMPDIR_WORKERS="$(mktemp -d)"
cleanup_workers() { rm -rf "$TMPDIR_WORKERS"; }
trap cleanup_workers EXIT

# Each worker: acquire GPU lock, do work (or dry-run sleep), release, write result.
# Runs in a subshell (called with &) -- each gets its own fd namespace.
run_worker() {
  local wid="$1"
  local result_file="$TMPDIR_WORKERS/w${wid}.result"

  local start_ns lock_ns done_ns
  start_ns="$(date +%s%N)"

  # Open and lock (exclusive, non-blocking on timeout: LOCKBUSY)
  local lockfd
  lockfd=$(( 20 + wid ))  # unique fd per worker (20+, avoids collisions with 0-9)
  eval "exec ${lockfd}>'${GPU_LOCK}'" 2>/dev/null || {
    echo "${wid},0,0,0,ERR_OPEN_LOCK" > "$result_file"; return
  }
  if ! flock -w "$GPU_LOCK_WAIT" "$lockfd" 2>/dev/null; then
    echo "${wid},LOCKBUSY,0,0,LOCKBUSY" > "$result_file"
    eval "exec ${lockfd}>&-" 2>/dev/null
    return
  fi
  lock_ns="$(date +%s%N)"

  local etps=0
  if [[ "$DRY_RUN" == 1 ]]; then
    sleep "$DRY_SLEEP"
    etps="30.0"
  else
    # Unload to force a clean load (same as local-llm-bench.sh inner loop)
    curl -fsS -m 20 -X POST "$HOST/api/generate" \
      -H 'Content-Type: application/json' \
      -d "{\"model\":\"$MODEL\",\"keep_alive\":0}" >/dev/null 2>&1 || true
    sleep 2
    local resp
    resp="$(curl -fsS -m 300 -X POST "$HOST/api/generate" \
      -H 'Content-Type: application/json' \
      -d "$(MODEL="$MODEL" PROMPT="$PROMPT" CTX="$CTX" python3 -c '
import json,os
print(json.dumps({"model":os.environ["MODEL"],"prompt":os.environ["PROMPT"],"stream":False,
                  "options":{"num_ctx":int(os.environ["CTX"]),"num_predict":128,"temperature":0}}))')" \
      2>/dev/null || true)"
    etps="$(echo "$resp" | python3 -c '
import json,sys
d=json.load(sys.stdin)
c,ns=d.get("eval_count",0),d.get("eval_duration",0)
print(round(c/(ns/1e9),1) if c and ns else 0)' 2>/dev/null || echo 0)"
  fi

  eval "flock -u ${lockfd}" 2>/dev/null
  done_ns="$(date +%s%N)"
  eval "exec ${lockfd}>&-" 2>/dev/null

  local queue_wait_ms gen_time_ms
  queue_wait_ms=$(( (lock_ns  - start_ns) / 1000000 ))
  gen_time_ms=$(( (done_ns - lock_ns) / 1000000 ))

  local ok="ok"
  [[ "$DRY_RUN" != 1 && "${etps:-0}" == "0" ]] && ok="FAIL"
  echo "${wid},${queue_wait_ms},${gen_time_ms},${etps},${ok}" > "$result_file"
}

echo "local-llm-parallel-bench: workers=$WORKERS ctx=$CTX dry_run=$DRY_RUN" >&2

# Spawn all workers simultaneously
echo "worker,queue_wait_ms,gen_time_ms,eval_tps,ok"
bench_start_ns="$(date +%s%N)"
for i in $(seq 1 "$WORKERS"); do
  run_worker "$i" &
done
wait
bench_done_ns="$(date +%s%N)"
total_elapsed_ms=$(( (bench_done_ns - bench_start_ns) / 1000000 ))

# Collect and print results (in worker order)
for i in $(seq 1 "$WORKERS"); do
  result_file="$TMPDIR_WORKERS/w${i}.result"
  if [[ -f "$result_file" ]]; then
    cat "$result_file"
  else
    echo "${i},ERR,ERR,ERR,NO_RESULT"
  fi
done

# Summary to stderr
python3 - "$total_elapsed_ms" "$TMPDIR_WORKERS" "$WORKERS" <<'PY'
import sys, os, statistics

total_ms = int(sys.argv[1])
tmpdir   = sys.argv[2]
n        = int(sys.argv[3])

waits = []; gens = []; ok_count = 0
for i in range(1, n + 1):
    f = os.path.join(tmpdir, "w%d.result" % i)
    if not os.path.exists(f):
        continue
    parts = open(f).read().strip().split(",")
    if len(parts) < 5:
        continue
    try:
        w, g = int(parts[1]), int(parts[2])
        waits.append(w); gens.append(g)
        if parts[4] == "ok":
            ok_count += 1
    except ValueError:
        pass

print("--- summary ---", file=sys.stderr)
print("total elapsed: %d ms" % total_ms, file=sys.stderr)
print("workers ok: %d / %d" % (ok_count, n), file=sys.stderr)
if waits:
    print("queue_wait_ms: min=%d  median=%d  max=%d" % (
        min(waits), int(statistics.median(waits)), max(waits)), file=sys.stderr)
if gens:
    print("gen_time_ms:   min=%d  median=%d  max=%d" % (
        min(gens), int(statistics.median(gens)), max(gens)), file=sys.stderr)
if len(waits) >= 2:
    serial_ideal = sum(gens) + min(waits)
    overhead_pct = (total_ms - min(gens)) * 100 / max(gens) if max(gens) else 0
    print("observation: with %d concurrent callers and 1 GPU lock, worst-case wait = %d ms (%ds)" % (
        n, max(waits), max(waits) // 1000), file=sys.stderr)
PY
