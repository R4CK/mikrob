#!/usr/bin/env bash
# local-llm-bench.sh -- measure the local Ollama model at a given context size (card 7041c165).
#
# WHY A SCRIPT: the offload tuning card asks for flash-attention + KV-cache quantisation "for a bigger
# context". That is only worth doing if it MEASURABLY buys context or speed on THIS box (GTX 1660 Ti,
# 6 GiB, ~5 GiB usable, Turing/compute 7.5). "Feels faster" is not evidence, so every claim in the
# card review comes from this script: same prompt, same model, one variable changed at a time.
#
# WHAT IT REPORTS (one CSV line per run):
#   ctx            requested num_ctx
#   gpu_split      ollama ps PROCESSOR for THIS model (100% GPU vs a CPU/GPU split -- the thing to avoid)
#   ctx_loaded     context the server actually allocated for it
#   kv_mib/kv_type KV cache size the server actually allocated, and its element type (f16 vs q8_0)
#   load_ms        model load time (0 when already resident)
#   prompt_tps     prompt-eval tokens/sec
#   eval_tps       generation tokens/sec
#   ok             whether the request succeeded at all
#
# USAGE:
#   local-llm-bench.sh [--model M] [--ctx 4096,8192,16384] [--label baseline] [--repeat 3]
# Use --repeat >= 3: single runs on this box vary by several tok/s, which is the same order as the
# effect being measured -- one run per config would let noise masquerade as a result.
# Env knobs are read by the OLLAMA SERVER, not here -- set them in the service unit and restart
# ollama, then re-run this with a different --label to get the comparison rows.

set -uo pipefail

HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
MODEL="${LOCAL_LLM_MODEL:-$(cat "$(dirname "${BASH_SOURCE[0]}")/local-llm-model" 2>/dev/null || echo 'qwen2.5-coder:7b-instruct-q4_K_M')}"
CTX_LIST="4096"
LABEL="run"
REPEAT=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    --ctx)   CTX_LIST="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --repeat) REPEAT="$2"; shift 2 ;;
    *) echo "local-llm-bench: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

# A prompt long enough to make prompt-eval measurable but identical across runs.
PROMPT='Write a TypeScript function `sumEven(nums: number[]): number` that returns the sum of the even numbers. Return only the code.'

server_facts() { # -> "gpu_split ctx_loaded" for $MODEL, attributed to THE MODEL, not the journal tail
  # `ollama ps` names the model on each row, so a concurrent embed/other-model load cannot be
  # mis-read as this model's. Parsing the journal tail DID exactly that during the first run of this
  # card: rows showed "13/13 layers" -- the 13-layer embedding model another agent had just called --
  # making a 7B/29-layer measurement look like a full offload. Attribute by name or do not report.
  ollama ps 2>/dev/null | awk -v m="$MODEL" '
    $1 == m {
      split($0, _f, "  +")
      proc = ""; ctxv = ""
      for (i = 1; i <= NF; i++) {
        if ($i ~ /(GPU|CPU)$/ || $i ~ /%$/) proc = proc (proc == "" ? "" : "") $i
        if ($i ~ /^[0-9]+$/ && $i+0 >= 512) ctxv = $i
      }
      printf "%s %s", (proc == "" ? "?" : proc), (ctxv == "" ? "?" : ctxv); found = 1; exit
    }
    END { if (!found) printf "unloaded ?" }'
}

kv_facts() { # -> "kv_mib kv_type" from the LAST kv_cache line that belongs to a 28-layer (7B) load
  journalctl --user -u ollama --no-pager -n 400 2>/dev/null | awk '
    /llama_kv_cache: size/ && / 28 layers/ {
      if (match($0, /size =[ ]*[0-9.]+ MiB/)) { kv = substr($0, RSTART, RLENGTH); gsub(/[^0-9.]/, "", kv) }
      if (match($0, /K \(([a-z0-9_]+)\)/)) { kvt = substr($0, RSTART+3, RLENGTH-4) }
    }
    END { printf "%s %s", (kv == "" ? "?" : kv), (kvt == "" ? "?" : kvt) }'
}

echo "label,model,ctx,gpu_split,ctx_loaded,kv_mib,kv_type,load_ms,prompt_tps,eval_tps,ok"

IFS=',' read -ra CTXS <<< "$CTX_LIST"
for ctx in "${CTXS[@]}"; do
 for _rep in $(seq 1 "$REPEAT"); do
  # Force a clean load so layer/KV numbers belong to THIS ctx, not a resident model.
  curl -fsS -m 20 -X POST "$HOST/api/generate" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$MODEL\",\"keep_alive\":0}" >/dev/null 2>&1
  sleep 2

  resp=$(curl -fsS -m 300 -X POST "$HOST/api/generate" \
    -H 'Content-Type: application/json' \
    -d "$(MODEL="$MODEL" PROMPT="$PROMPT" CTX="$ctx" python3 -c '
import json, os
print(json.dumps({
  "model": os.environ["MODEL"],
  "prompt": os.environ["PROMPT"],
  "stream": False,
  "options": {"num_ctx": int(os.environ["CTX"]), "num_predict": 128, "temperature": 0},
}))')" 2>/dev/null)

  if [[ -z "$resp" ]]; then
    echo "$LABEL,$MODEL,$ctx,-,-,-,-,-,-,-,FAIL"
    continue
  fi

  read -r split ctxload <<< "$(server_facts)"
  read -r kv kvtype <<< "$(kv_facts)"
  metrics=$(echo "$resp" | python3 -c '
import json, sys
d = json.load(sys.stdin)
def tps(count_key, dur_key):
    c, ns = d.get(count_key, 0), d.get(dur_key, 0)
    return round(c / (ns / 1e9), 1) if c and ns else 0.0
print(round(d.get("load_duration", 0) / 1e6), tps("prompt_eval_count", "prompt_eval_duration"), tps("eval_count", "eval_duration"))' 2>/dev/null)
  [[ -z "$metrics" ]] && metrics="- - -"
  read -r load_ms ptps etps <<< "$metrics"
  echo "$LABEL,$MODEL,$ctx,$split,$ctxload,$kv,$kvtype,$load_ms,$ptps,$etps,ok"
 done
done
