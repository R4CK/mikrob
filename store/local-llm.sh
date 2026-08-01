#!/usr/bin/env bash
# local-llm.sh -- fleet-shared client for the LOCAL offload LLM (Ollama).
#
# PURPOSE: let any fleet agent hand a bounded sub-task to a locally-hosted model
# instead of burning online Anthropic tokens. CROSS-PLATFORM (card b097b578): it talks
# only to the Ollama HTTP API, which is identical on Linux, WSL and macOS -- on Linux/WSL
# the GPU path is CUDA (the fleet host is a GTX 1660 Ti), on macOS Ollama uses Metal
# automatically. Only the "how to start Ollama" HINT is platform-specific; see
# detect_platform() below. Nothing else branches on the OS.
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

# --- host-platform detection (card b097b578) -----------------------------------------------------
# The Ollama HTTP API is identical on every platform, so ONLY the operator-facing "how do I start it"
# hint differs. Detection is `uname -s` plus the WSL marker, and it is used for MESSAGES ONLY -- no
# code path branches on it, so a wrong guess can never change what the script actually does.
#   Linux + /proc/version contains microsoft -> WSL   (systemd --user unit)
#   Linux                                    -> Linux (systemd --user unit)
#   Darwin                                   -> macOS (Ollama.app, or `ollama serve` from brew)
detect_platform() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin) echo macos ;;
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then echo wsl; else echo linux; fi
      ;;
    *) echo unknown ;;
  esac
}
LOCAL_LLM_PLATFORM="${LOCAL_LLM_PLATFORM:-$(detect_platform)}"

# Per-platform "Ollama is down, start it like this" hint. macOS has no systemd: Ollama runs either as
# the menu-bar app or as a plain `ollama serve` (brew install ollama). Homebrew's services wrapper is
# offered as the background option.
ollama_start_hint() {
  case "$LOCAL_LLM_PLATFORM" in
    macos)
      echo "start it: open -a Ollama   (or: ollama serve &   |   brew services start ollama)"
      ;;
    wsl | linux)
      echo "start it: systemctl --user start ollama"
      ;;
    *)
      echo "start it: run 'ollama serve' (or your platform's Ollama service)"
      ;;
  esac
}

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
  # Strip TAB/NEWLINE from free-text fields so a caller/task/source value can never
  # inject extra TSV columns or fake rows (metric-integrity hardening; Cybersec LOW).
  local c="${CALLER:-direct}" t="${TASK:-chat}" s="${SOURCE:-bare}" m="$MODEL"
  c="${c//[$'\t\n']/_}"; t="${t//[$'\t\n']/_}"; s="${s//[$'\t\n']/_}"; m="${m//[$'\t\n']/_}"
  { printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$(date +%s 2>/dev/null || echo 0)" "$c" "$t" "$m" "${2:-0}" "$1" "$s" "${3:-0}" "${4:-0}" \
      >> "$USAGE_LOG"; } 2>/dev/null || true
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
    echo "platform: $LOCAL_LLM_PLATFORM  (override with LOCAL_LLM_PLATFORM=macos|linux|wsl)"
    echo "active model: $MODEL  (present locally: $have)"
    exit 0
  else
    echo "ollama: DOWN ($OLLAMA_HOST) [$LOCAL_LLM_PLATFORM] -- $(ollama_start_hint)"
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
  # Card 0c054ebf: per-category on/off toggle from the dashboard. Enforced HERE (the one place
  # every --task caller funnels through, direct or via local-llm-rag.sh) so the toggle is not
  # decorative. Same config file the offload-config/categories endpoints read+write; a bad/missing
  # config fails OPEN (treat as enabled) so a config hiccup never silently blocks all offload --
  # the toggle is an opt-out, not a fail-closed gate. Exit 9 matches local-llm-rag.sh's --auto
  # "ROUTE=online" code: to a caller, a disabled category is the same signal as "do this online".
  DISABLED_CHECK="$(TASK="$TASK" CFG="$HERE/local-llm-offload-active.json" python3 -c '
import json, os
task = os.environ["TASK"]
try:
    with open(os.environ["CFG"]) as f:
        cfg = json.load(f)
    disabled = cfg.get("disabledCategories") or []
    print("DISABLED" if task in disabled else "OK")
except Exception:
    print("OK")
' 2>/dev/null)"
  if [[ "$DISABLED_CHECK" == "DISABLED" ]]; then
    echo "local-llm: category '$TASK' is disabled from the dashboard (Lokális LLM -> Kategóriák) -- this call belongs online" >&2
    exit 9
  fi
  # split template: first a system line block until a line '---', then user template
  SYS_FROM_TPL="$(awk '/^---$/{exit} {print}' "$TPL")"
  USER_TPL="$(awk 'f{print} /^---$/{f=1}' "$TPL")"
  [[ -z "$SYSTEM" ]] && SYSTEM="$SYS_FROM_TPL"
  PROMPT="${USER_TPL//\{\{INPUT\}\}/$PROMPT}"
fi

ollama_up || die 2 "ollama down at $OLLAMA_HOST [$LOCAL_LLM_PLATFORM] -- $(ollama_start_hint)"

# Build request JSON safely via python (handles all escaping)
REQ=$(SYSTEM="$SYSTEM" MODEL="$MODEL" PROMPT="$PROMPT" python3 -c '
import json,os
d={"model":os.environ["MODEL"],"prompt":os.environ["PROMPT"],"stream":False}
s=os.environ.get("SYSTEM","")
if s: d["system"]=s
print(json.dumps(d))')

# Millisecond clock -- PORTABLE (card b097b578). GNU date supports %N (nanoseconds); BSD/macOS date
# does NOT and silently emits a literal "N" (e.g. "1785441395N") with exit status 0, so the old
# `|| echo 0` guard never fired and the later arithmetic hit a non-numeric operand -- under
# `set -euo pipefail` that is a hard failure, i.e. the metering broke the whole call on a Mac.
# We therefore VALIDATE that the output is all digits and fall back to python3 (already a hard
# dependency of this script for JSON) when it is not.
_now_ms() {
  local ns
  ns=$(date +%s%N 2>/dev/null || true)
  if [[ "$ns" =~ ^[0-9]+$ ]]; then
    echo $(( ns / 1000000 ))
  else
    python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || echo 0
  fi
}
START_MS=$(_now_ms)
_elapsed() { # -> elapsed milliseconds since START_MS
  local e; e=$(_now_ms)
  if [[ "$START_MS" == 0 || "$e" == 0 ]]; then echo 0; else echo $(( e - START_MS )); fi
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
# Exact local token accounting (Ollama returns eval_count=out, prompt_eval_count=in).
_TOKS=$(echo "$RESP" | python3 -c "import json,sys
try:
    d=json.load(sys.stdin); print(int(d.get('eval_count',0)), int(d.get('prompt_eval_count',0)))
except Exception:
    print('0 0')" 2>/dev/null || echo "0 0")
log_usage ok "$(_elapsed)" $_TOKS

echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('response','').rstrip()) if 'response' in d else sys.exit('local-llm: '+d.get('error','unknown error'))"
