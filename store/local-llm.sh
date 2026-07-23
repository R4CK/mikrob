#!/usr/bin/env bash
# local-llm.sh -- fleet-shared client for the LOCAL offload LLM (Ollama on the WSL GPU).
#
# PURPOSE: let any fleet agent hand a bounded sub-task to a locally-hosted model
# (GTX 1660 Ti, CUDA via Ollama) instead of burning online Anthropic tokens.
# Use for cheap, well-scoped jobs: MarkdownV2/JSON escaping, text reformat,
# log/email triage, dedup, short summaries, classification, i18n string drafts.
# NOT for high-stakes reasoning, security gates, or anything that ships unreviewed.
#
# The active model is read at call time from store/local-llm-model (one line),
# so the model is swappable/updatable centrally without touching this script or
# any agent. Update the model with:  ollama pull <name>  (then edit that file).
#
# USAGE:
#   local-llm.sh "your prompt"                 # prompt as arg
#   echo "your prompt" | local-llm.sh          # prompt on stdin
#   local-llm.sh --task escape "raw text"      # apply a named task template
#   local-llm.sh --system "You are X" "prompt" # custom system prompt
#   local-llm.sh --model llama3.1:8b "prompt"  # one-off model override
#   local-llm.sh --health                      # check Ollama + active model
#   local-llm.sh --list                        # list locally available models
#
# Exit codes: 0 ok | 2 ollama down | 3 model missing | 4 bad usage | 5 api error
# No secrets are embedded; this talks only to 127.0.0.1 Ollama.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
MODEL_FILE="$HERE/local-llm-model"
SKILL_DIR="$HERE/local-llm-skills"
TIMEOUT="${LOCAL_LLM_TIMEOUT:-120}"

read_model() {
  if [[ -f "$MODEL_FILE" ]]; then
    tr -d '[:space:]' < "$MODEL_FILE" | head -c 200
  else
    echo "qwen2.5:7b-instruct-q4_K_M"
  fi
}

die() { echo "local-llm: $2" >&2; exit "$1"; }

ollama_up() { curl -fsS -m 5 "$OLLAMA_HOST/api/tags" >/dev/null 2>&1; }

# Usage metering (fail-open, metadata only -- NEVER the prompt/content).
# One TSV line per real model invocation: epoch \t caller \t task \t model \t ms \t status
USAGE_LOG="$HERE/local-llm-usage.log"
log_usage() { # $1=status(ok|err)  $2=elapsed_ms
  { printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$(date +%s 2>/dev/null || echo 0)" "${CALLER:-direct}" "${TASK:-chat}" \
      "$MODEL" "${2:-0}" "$1" "${SOURCE:-bare}" >> "$USAGE_LOG"; } 2>/dev/null || true
}

MODEL=""; SYSTEM=""; TASK=""; MODE="generate"; CALLER=""; SOURCE="bare"
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)  MODEL="$2"; shift 2 ;;
    --system) SYSTEM="$2"; shift 2 ;;
    --task)   TASK="$2"; shift 2 ;;
    --caller) CALLER="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --health) MODE="health"; shift ;;
    --list)   MODE="list"; shift ;;
    -h|--help) MODE="help"; shift ;;
    --) shift; while [[ $# -gt 0 ]]; do ARGS+=("$1"); shift; done ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

[[ -z "$MODEL" ]] && MODEL="$(read_model)"

if [[ "$MODE" == "help" ]]; then
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

if [[ "$MODE" == "health" ]]; then
  if ollama_up; then
    have=$(curl -fsS -m 5 "$OLLAMA_HOST/api/tags" | python3 -c "import json,sys; print('yes' if any(m.get('name','').split(':')[0]==sys.argv[1].split(':')[0] for m in json.load(sys.stdin).get('models',[])) else 'no')" "$MODEL" 2>/dev/null || echo "?")
    echo "ollama: UP ($OLLAMA_HOST)"
    echo "active model: $MODEL  (present locally: $have)"
    exit 0
  else
    echo "ollama: DOWN ($OLLAMA_HOST) -- start it: systemctl --user start ollama"
    exit 2
  fi
fi

if [[ "$MODE" == "list" ]]; then
  ollama_up || die 2 "ollama down at $OLLAMA_HOST"
  curl -fsS -m 10 "$OLLAMA_HOST/api/tags" | python3 -c "import json,sys; [print(m['name'], f\"({round(m.get('size',0)/1e9,1)}GB)\") for m in json.load(sys.stdin).get('models',[])]"
  exit 0
fi

# ---- generate mode ----
# Gather prompt: args joined, or stdin if no args
if [[ ${#ARGS[@]} -gt 0 ]]; then
  PROMPT="${ARGS[*]}"
else
  if [[ -t 0 ]]; then die 4 "no prompt (pass as arg or pipe via stdin); see --help"; fi
  PROMPT="$(cat)"
fi
[[ -z "${PROMPT// }" ]] && die 4 "empty prompt"

# Optional named task template (store/local-llm-skills/<task>.txt); {{INPUT}} is replaced.
if [[ -n "$TASK" ]]; then
  TPL="$SKILL_DIR/$TASK.txt"
  [[ -f "$TPL" ]] || die 4 "unknown --task '$TASK' (no $TPL)"
  # split template: first a system line block until a line '---', then user template
  SYS_FROM_TPL="$(awk '/^---$/{exit} {print}' "$TPL")"
  USER_TPL="$(awk 'f{print} /^---$/{f=1}' "$TPL")"
  [[ -z "$SYSTEM" ]] && SYSTEM="$SYS_FROM_TPL"
  PROMPT="${USER_TPL//\{\{INPUT\}\}/$PROMPT}"
fi

ollama_up || die 2 "ollama down at $OLLAMA_HOST -- systemctl --user start ollama"

# Build request JSON safely via python (handles all escaping)
REQ=$(SYSTEM="$SYSTEM" MODEL="$MODEL" PROMPT="$PROMPT" python3 -c '
import json,os
d={"model":os.environ["MODEL"],"prompt":os.environ["PROMPT"],"stream":False}
s=os.environ.get("SYSTEM","")
if s: d["system"]=s
print(json.dumps(d))')

# nanosecond clock -> milliseconds (robust across date impls; 0 if unavailable)
START_NS=$(date +%s%N 2>/dev/null || echo 0)
_elapsed() { # -> elapsed milliseconds since START_NS
  local e; e=$(date +%s%N 2>/dev/null || echo 0)
  if [[ "$START_NS" == 0 || "$e" == 0 ]]; then echo 0; else echo $(( (e - START_NS) / 1000000 )); fi
}

RESP=$(curl -fsS -m "$TIMEOUT" -X POST "$OLLAMA_HOST/api/generate" \
  -H "Content-Type: application/json" -d "$REQ" 2>/dev/null) || {
  log_usage err "$(_elapsed)"
  # distinguish model-missing from generic error
  if ollama_up && ! curl -fsS -m 5 "$OLLAMA_HOST/api/tags" | grep -q "${MODEL%%:*}"; then
    die 3 "model '$MODEL' not pulled -- run: ollama pull $MODEL"
  fi
  die 5 "ollama api error (timeout ${TIMEOUT}s or server error)"
}
log_usage ok "$(_elapsed)"

echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('response','').rstrip()) if 'response' in d else sys.exit('local-llm: '+d.get('error','unknown error'))"
