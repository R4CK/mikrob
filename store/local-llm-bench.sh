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

STATE_FILE="${LOCAL_LLM_STATE_FILE:-$(dirname "${BASH_SOURCE[0]}")/local-llm-model-state.json}"
BEST_TPS=0
BEST_CTX=0

record_bench() { # $1 model, $2 eval_tps, $3 ctx, $4 label
  # Read-modify-write through a temp file: other models' records must survive, and a half-written
  # state file would read as "nothing was ever benchmarked" -- which is the safe direction, but
  # losing another model's record to a crash is not.
  MODEL="$1" TPS="$2" CTX="$3" LBL="$4" STATE="$STATE_FILE" python3 - <<'PY'
import json, os, tempfile, datetime
state = os.environ["STATE"]
try:
    doc = json.load(open(state))
    if not isinstance(doc, dict) or not isinstance(doc.get("models"), dict):
        doc = {"models": {}}
except Exception:
    doc = {"models": {}}
doc["models"][os.environ["MODEL"]] = {
    "benchmarkedAt": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "evalTps": float(os.environ["TPS"]),
    "ctx": int(os.environ["CTX"]),
    "label": os.environ["LBL"],
}
d = os.path.dirname(state) or "."
fd, tmp = tempfile.mkstemp(dir=d)
with os.fdopen(fd, "w") as f:
    json.dump(doc, f, indent=2)
os.replace(tmp, state)
print("local-llm-bench: recorded benchmark for %s (%s tok/s @ ctx %s)" % (
    os.environ["MODEL"], os.environ["TPS"], os.environ["CTX"]))
PY
}

# --record <model> <eval_tps> <ctx> <label>: write the state entry without running a benchmark.
# It exists so the recording itself is testable -- the measurement needs a GPU and a model, the
# bookkeeping does not, and an untested writer is where a silent "everything is benchmarked" bug
# would live.
if [[ "${1:-}" == "--record" ]]; then
  [[ $# -eq 5 ]] || { echo "usage: local-llm-bench.sh --record <model> <eval_tps> <ctx> <label>" >&2; exit 2; }
  record_bench "$2" "$3" "$4" "$5"
  exit 0
fi

# No literal fallback -- see the note in local-llm.sh read_model(). Benchmarking a model nobody
# configured would publish throughput numbers for a model the fleet is not running.
MODEL="${LOCAL_LLM_MODEL:-$(cat "$(dirname "${BASH_SOURCE[0]}")/local-llm-model" 2>/dev/null || true)}"
MODEL="$(printf '%s' "$MODEL" | tr -d '[:space:]')"
if [[ -z "$MODEL" ]]; then
  echo "local-llm-bench: no model configured -- run store/first-run-llm.sh (or set LOCAL_LLM_MODEL)" >&2
  exit 4
fi
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
  # Keep the best successful run, to record afterwards (card d730070e). Best rather than last: a
  # repeat that lands while another agent is on the GPU measures the contention, not the model.
  if [[ "$etps" != "-" ]] && awk "BEGIN{exit !($etps > $BEST_TPS)}"; then
    BEST_TPS="$etps"; BEST_CTX="$ctx"
  fi
 done
done

# RECORD THAT A MEASUREMENT HAPPENED. Until now this script printed CSV and kept nothing, so
# "benchmarked" was a claim no file could support -- the catalogue's benchmarkedAt was hardcoded
# null and the UI could not tell a measured model from one downloaded a minute ago. Only this
# script writes the file: a record asserting that a measurement took place must be written by the
# thing that measures, never by an installer or a UI action.
if [[ "$BEST_TPS" != "0" ]]; then
  record_bench "$MODEL" "$BEST_TPS" "$BEST_CTX" "$LABEL"
else
  echo "local-llm-bench: no successful run -- not recording a benchmark for '$MODEL'" >&2
fi
