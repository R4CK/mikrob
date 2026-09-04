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
# Exit codes: 0 ok | 2 ollama down | 3 model missing | 4 bad usage | 5 api error |
#             6 gpu lock busy (contention, not a generation failure -- card ea931c14)
# No secrets are embedded; this talks only to a LOOPBACK Ollama -- enforced at startup
# (require_loopback_ollama_host), not merely intended. Deliberate remote use must set
# LOCAL_LLM_ALLOW_REMOTE_HOST=1, which is loud on every call.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# STATE_DIR vs HERE (card b536501e). HERE is where this FILE lives; STATE_DIR is where the RUNNING
# INSTALL's dashboard state lives. They are the same in the install and different in every agent
# worktree, which is the whole point -- see store/local-llm-state-dir.sh for the defect this closes.
# Everything the dashboard WRITES is read from STATE_DIR; everything version-controlled that travels
# with the code stays on HERE.
if [ -r "$HERE/local-llm-state-dir.sh" ]; then
  # shellcheck source=/dev/null
  . "$HERE/local-llm-state-dir.sh"
  # NOT `$(resolve ...)`: command substitution is a subshell, and the origin the resolver sets there
  # would not survive it -- announce() keys on that origin, so it would warn on every call.
  resolve_local_llm_state_dir "$HERE"
  STATE_DIR="$LOCAL_LLM_STATE_RESOLVED"
  announce_local_llm_state_dir "local-llm" "$HERE" "$STATE_DIR"
else
  # Missing helper is not a reason to go quiet: without it the kill switch below reads this copy's
  # own directory, which in a worktree holds nothing.
  STATE_DIR="$HERE"
  echo "local-llm: WARNING -- $HERE/local-llm-state-dir.sh is missing, falling back to $HERE for dashboard state; switches may NOT be in force for this call." >&2
fi

OLLAMA_HOST_DEFAULT="http://127.0.0.1:11434"
OLLAMA_HOST="${OLLAMA_HOST:-$OLLAMA_HOST_DEFAULT}"
# Dashboard-written (routes/local-llm.ts atomically writes it) -> STATE_DIR.
MODEL_FILE="$STATE_DIR/local-llm-model"
SKILL_DIR="$HERE/local-llm-skills"
TIMEOUT="${LOCAL_LLM_TIMEOUT:-120}"
# GPU-concurrency guard (card 2026-08-03, Peti driver-update follow-up): the WSL2 GPU-passthrough
# kernel driver (dxgkrnl) crashed the whole VM under sustained/overlapping Ollama GPU load -- this
# serializes generate calls system-wide so only one runs at a time, regardless of how many cards/
# agents try to offload concurrently. Cheap insurance that holds even if a future driver regresses.
GPU_LOCK="${LOCAL_LLM_GPU_LOCK_PATH:-/tmp/local-llm-gpu.lock}"
GPU_LOCK_WAIT="${LOCAL_LLM_LOCK_WAIT:-600}"

# Active-task registration (card 5dcd9bc8): best-effort, fail-open, never blocks/breaks the actual
# model call if the dashboard is down or on a platform that doesn't run it (see DASH_TOKEN_FILE
# check at the call site). Skipped entirely when QUEUE_MANAGED=1 (local-llm-worker.sh passes
# --queue-managed): a worker-claimed call already has a real running row from claimNext(), so
# self-registering here would double-count the same unit of work.
DASH_API="http://127.0.0.1:${WEB_PORT:-3420}/api/local-llm/queue"
DASH_TOKEN_FILE="${LOCAL_LLM_DASH_TOKEN_FILE:-$STATE_DIR/.dashboard-token}"

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

# ONE opinion about which model is active, and it is this file -- no reader carries its own fallback.
# Before this, THREE files carried FOUR different literals and they DISAGREED: this one fell back to
# the general `qwen2.5:7b` while local-llm-bench.sh and quota-bridge.py fell back to the CODER build.
# So a missing config did not degrade to a known state -- it silently started asking a non-coding
# model for code while the bench and the quota bridge still reported on the coder model, and nothing
# errored. A loud failure is the only safe answer: the config is written by first-run, and using the
# local LLM before that step has run is itself the bug.
read_model() {
  if [[ -f "$MODEL_FILE" ]]; then
    local m; m="$(tr -d '[:space:]' < "$MODEL_FILE" | head -c 200)"
    if [[ -n "$m" ]]; then echo "$m"; return 0; fi
  fi
  die 4 "no model configured ($MODEL_FILE missing or empty) -- run store/first-run-llm.sh"
}

die() { echo "local-llm: $2" >&2; exit "$1"; }

ollama_up() { curl -fsS -m 5 "$OLLAMA_HOST/api/tags" >/dev/null 2>&1; }

# --- OLLAMA_HOST is a switch, so it gets checked (card 0d2be5e5, Cybersec on the 8417fa5e gate) --
# The variable was overridable with no validation at all. That mattered little while this path
# carried code fragments, but the specialist routing changed what flows through it: --task
# morning-brief / daily-log / board-reconcile / tg-draft now pass the owner's email and calendar
# content and the whole kanban state. A remote value would have made every morning brief a silent
# outbound transfer, and nothing in the script would have said so.
#
# Enforcing loopback also restores a premise the script ALREADY depends on further down, where the
# generate call's exit status is interpreted: "curl itself (this fixed, well-formed invocation:
# static OLLAMA_HOST ...) never legitimately exits 1". Measured here: with an unknown scheme
# (xyzzy://, notaproto://) curl DOES exit 1 -- CURLE_UNSUPPORTED_PROTOCOL -- and this script then
# reports `die 6 "gpu lock busy ... (not a generation failure)"`, on which local-llm-worker.sh
# abstains and REVERTS the attempt count. A single typo in the scheme would therefore retry for
# ever instead of failing. Constraining the host is what makes that reasoning sound.
#
# Fail-closed on anything not provably loopback, including the shapes that look local but are not
# (userinfo smuggling `http://127.0.0.1@elsewhere/`, a suffix like `127.0.0.1.example.com`).
local_llm_host_is_loopback() {
  local url="$1" hostpart
  case "$url" in
    http://*|https://*) ;;
    *) return 1 ;;                      # a non-http scheme is both an egress and an exit-code risk
  esac
  hostpart="${url#*://}"
  hostpart="${hostpart%%/*}"            # drop path
  hostpart="${hostpart%%\?*}"          # drop query
  hostpart="${hostpart##*@}"            # drop userinfo: the authority is what comes AFTER the last @
  case "$hostpart" in
    \[*\]*) hostpart="${hostpart#\[}"; hostpart="${hostpart%%\]*}" ;;   # [::1]:11434
    *)        hostpart="${hostpart%%:*}" ;;                            # host:port
  esac
  hostpart="$(printf '%s' "$hostpart" | tr '[:upper:]' '[:lower:]')"
  # Exact matches only. A prefix test like 127.* would accept 127.0.0.1.example.com.
  [[ "$hostpart" == "localhost" || "$hostpart" == "::1" ]] && return 0
  [[ "$hostpart" =~ ^127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] && return 0
  return 1
}

require_loopback_ollama_host() {
  if local_llm_host_is_loopback "$OLLAMA_HOST"; then
    # Named even when allowed, whenever it is not the default: a hijacked-but-still-loopback value
    # (a different port, say) should not be invisible either. This is the card's "log it once".
    [[ "$OLLAMA_HOST" == "$OLLAMA_HOST_DEFAULT" ]] \
      || echo "local-llm: OLLAMA_HOST=$OLLAMA_HOST (loopback, non-default)" >&2
    return 0
  fi
  if [[ "${LOCAL_LLM_ALLOW_REMOTE_HOST:-}" == "1" ]]; then
    echo "local-llm: WARNING -- OLLAMA_HOST=$OLLAMA_HOST is NOT loopback and LOCAL_LLM_ALLOW_REMOTE_HOST=1 is set." >&2
    echo "local-llm: WARNING -- prompt content LEAVES THIS MACHINE, including --task payloads that carry email, calendar and kanban state." >&2
    return 0
  fi
  die 4 "OLLAMA_HOST=$OLLAMA_HOST is not loopback -- refusing to send prompt content off this machine (--task payloads carry email/calendar/kanban state). Use a 127.0.0.0/8, localhost or ::1 URL, or set LOCAL_LLM_ALLOW_REMOTE_HOST=1 deliberately."
}

require_loopback_ollama_host

# Usage metering (fail-open, metadata only -- NEVER the prompt/content).
# One TSV line per real model invocation: epoch \t caller \t task \t model \t ms \t status
# STATE_DIR, not HERE: the dashboard reads this file from the INSTALL store (routes/local-llm.ts
# USAGE_FILE), so a worktree copy writing beside itself would keep its calls out of the usage and
# metering views entirely -- the same install-owned-data-resolved-script-relative class as the
# kill switch above, with a metrics consequence instead of a security one.
USAGE_LOG="$STATE_DIR/local-llm-usage.log"
log_usage() { # $1=status(ok|err|busy)  $2=elapsed_ms  $3=eval_count  $4=prompt_eval_count  $5=eval_duration_ms
  # Strip TAB/NEWLINE from free-text fields so a caller/task/source value can never
  # inject extra TSV columns or fake rows (metric-integrity hardening; Cybersec LOW).
  # LOG_TASK is the label ONLY (card ea3e4270). --task also picks a prompt template and is subject to
  # the dashboard's per-category switch, so a caller that just wants the metric to say what this call
  # WAS cannot use it without changing what the model receives. Measured consequence of not having
  # this: the fleet's whole dispatch-offload path logged as `chat` (median 35s, 941 output tokens --
  # real drafting work), so "the share of task=code" measured who typed a flag, not what ran.
  local c="${CALLER:-direct}" t="${LOG_TASK:-${TASK:-chat}}" s="${SOURCE:-bare}" m="$MODEL"
  c="${c//[$'\t\n']/_}"; t="${t//[$'\t\n']/_}"; s="${s//[$'\t\n']/_}"; m="${m//[$'\t\n']/_}"
  # Column 10 (eval_duration_ms, card b21deb9a) is Ollama's OWN measured generation time, separate
  # from column 5 ($2, wall time): $2 also counts GPU-lock queueing (up to GPU_LOCK_WAIT seconds),
  # so deriving tokens/s from it would understate real throughput under contention. A row written
  # before this column existed has no field 10 at all; the reader (parseUsageRows) treats that the
  # same as 0, i.e. "speed unknown", never a guess.
  { printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$(date +%s 2>/dev/null || echo 0)" "$c" "$t" "$m" "${2:-0}" "$1" "$s" "${3:-0}" "${4:-0}" "${5:-0}" \
      >> "$USAGE_LOG"; } 2>/dev/null || true
}

MODEL=""; SYSTEM=""; TASK=""; MODE="generate"; CALLER=""; SOURCE="bare"; LOG_TASK=""; QUEUE_MANAGED=0
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)  MODEL="$2"; shift 2 ;;
    --system) SYSTEM="$2"; shift 2 ;;
    --task)   TASK="$2"; shift 2 ;;
    --log-task) LOG_TASK="$2"; shift 2 ;;   # label the usage log only; no template, no gating
    --caller) CALLER="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --queue-managed) QUEUE_MANAGED=1; shift ;;   # worker: skip self-registration, see DASH_API above
    --health) MODE="health"; shift ;;
    --list)   MODE="list"; shift ;;
    -h|--help) MODE="help"; shift ;;
    --) shift; while [[ $# -gt 0 ]]; do ARGS+=("$1"); shift; done ;;
    *) ARGS+=("$1"); shift ;;
  esac
done


# PER-TASK MODEL ROUTING (card baf1b1b0, Peti kerese 2026-09-02): explicit --model always wins
# (checked first, below); otherwise, if --task names a template with an entry in
# local-llm-model-routing.json's "overrides", that model is used INSTEAD of the plain default --
# today this exists so the ~4 templates that require actual Hungarian output (grep -l -i
# 'hungarian\|magyar' store/local-llm-skills/*.txt) can route to a different local model than the
# fast default. Fails OPEN to read_model()'s default on ANY problem (missing file, bad JSON, no
# --task, no matching entry) -- same philosophy as the disabledCategories check below: a routing
# config is an opt-in override, never a new way for the primary call path to break.
route_model_for_task() {
  local task="$1" cfg="$HERE/local-llm-model-routing.json"
  [[ -z "$task" || ! -f "$cfg" ]] && return 0
  TASK="$task" CFG="$cfg" python3 -c '
import json, os
try:
    with open(os.environ["CFG"]) as f:
        cfg = json.load(f)
    m = (cfg.get("overrides") or {}).get(os.environ["TASK"])
    if m: print(m)
except Exception:
    pass
' 2>/dev/null
}
if [[ -z "$MODEL" ]]; then
  ROUTED="$(route_model_for_task "$TASK")"
  if [[ -n "$ROUTED" ]]; then MODEL="$ROUTED"; else MODEL="$(read_model)"; fi
fi

# PER-MODEL KILL SWITCH (card 5d151091, pair-FE 5dd4a211). Peti switches a model off from the
# dashboard (Lokális LLM -> modell sor kapcsolója), which writes store/local-llm-model-disabled.json;
# this is where that becomes enforcement. Deliberately the LAST step of model selection -- after an
# explicit --model, after the per-task routing override, after the default -- so no path can reach
# the model around it.
#
# It STOPS, it does not substitute. A silent fallback to another model is exactly the fail-open this
# card exists to prevent: the caller would get a draft from a model the operator switched off and
# have no way to know. Exit 9 is the fleet's established "this task belongs online" code (the same
# one a disabled --task category returns), so local-llm-rag.sh and the queue worker already route the
# caller back to online Claude without a new convention.
#
# Fail direction: NO file means nothing was ever disabled (the normal state) and the call proceeds. A
# file that exists but cannot be parsed is state we cannot determine, so it also routes online, loudly
# -- naming the file, because the only way to produce one is to hand-edit it (the API writes atomically).
model_switch_state() {
  MODEL="$1" CFG="$STATE_DIR/local-llm-model-disabled.json" python3 -c '
import json, os
name = os.environ["MODEL"]
canon = name if ":" in name else name + ":latest"
cfg = os.environ["CFG"]
if not os.path.exists(cfg):
    print("OK")
else:
    try:
        with open(cfg) as f:
            doc = json.load(f)
        models = doc["disabledModels"]
        if not isinstance(models, dict):
            raise ValueError("disabledModels is not an object")
        keys = {(k if ":" in k else k + ":latest") for k in models}
        print("DISABLED" if canon in keys else "OK")
    except Exception:
        print("UNREADABLE")
' 2>/dev/null || echo "UNREADABLE"
}

if [[ "$MODE" == "generate" ]]; then
  case "$(model_switch_state "$MODEL")" in
    DISABLED)
      echo "local-llm: model '$MODEL' is DISABLED from the dashboard (Lokális LLM -> a modell sorának kapcsolója) -- this call belongs online. Enable it there, or pass --model with an enabled model." >&2
      exit 9 ;;
    UNREADABLE)
      echo "local-llm: cannot read $STATE_DIR/local-llm-model-disabled.json, so it is unknown whether '$MODEL' is disabled -- routing this call online. Fix or delete that file." >&2
      exit 9 ;;
  esac
fi

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
if [[ -n "$LOG_TASK" ]]; then
  [[ "$LOG_TASK" =~ ^[a-z0-9_-]{1,64}$ ]] || die 4 "invalid --log-task name '$LOG_TASK' (allowed: a-z 0-9 _ -, max 64)"
fi

if [[ -n "$TASK" ]]; then
  # Charset allowlist BEFORE the path join (card 2de47a4e; mirrors isValidCategoryName in
  # src/web/routes/local-llm.ts from 18a0acb9): every real category name is kebab/snake-case, so a
  # strict allowlist stops a '../'-bearing --task value from escaping SKILL_DIR before it is joined
  # into a path. Fail-closed -- no filesystem probe on a malformed name; keeps this shell entry point
  # consistent with the API route (two entry points, one policy).
  [[ "$TASK" =~ ^[a-z0-9_-]{1,64}$ ]] || die 4 "invalid --task name '$TASK' (allowed: a-z 0-9 _ -, max 64)"
  TPL="$SKILL_DIR/$TASK.txt"
  [[ -f "$TPL" ]] || die 4 "unknown --task '$TASK' (no $TPL)"
  # Card 0c054ebf: per-category on/off toggle from the dashboard. Enforced HERE (the one place
  # every --task caller funnels through, direct or via local-llm-rag.sh) so the toggle is not
  # decorative. Same config file the offload-config/categories endpoints read+write; a bad/missing
  # config fails OPEN (treat as enabled) so a config hiccup never silently blocks all offload --
  # the toggle is an opt-out, not a fail-closed gate. Exit 9 matches local-llm-rag.sh's --auto
  # "ROUTE=online" code: to a caller, a disabled category is the same signal as "do this online".
  DISABLED_CHECK="$(TASK="$TASK" CFG="$STATE_DIR/local-llm-offload-active.json" python3 -c '
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
  # `&` IS SPECIAL IN THE REPLACEMENT HALF OF ${var//pat/rep} (card a3b4e0f4). Bash expands a bare
  # `&` there to the text the pattern matched, so an input containing `cd X && grep foo` reached the
  # model as `cd X {{INPUT}}{{INPUT}} grep foo` -- the caller's own command mangled into the
  # placeholder's name, silently, with no error anywhere. Measured on bash 5.3.9 while testing this
  # card's new template; it hits EVERY --task template, not one, because this is the single
  # substitution site for all of them.
  #
  # BOTH escapes are needed, in this order. The replacement half also honours `\` as an escape, so
  # escaping only the ampersands corrupts an input that already contains `\&` (printf '%s' '\&' is a
  # real shape in a command corpus): `\&` would become `\\&`, i.e. a literal backslash followed by a
  # still-special `&`. Backslashes first, ampersands second, and both round-trip. The test file
  # local-llm-template-input-ampersand.test.ts runs THIS line, so it fails if either is dropped --
  # it is what caught the `\&` case above.
  ESCAPED_INPUT="${PROMPT//\\/\\\\}"
  PROMPT="${USER_TPL//\{\{INPUT\}\}/${ESCAPED_INPUT//&/\\&}}"
fi

ollama_up || die 2 "ollama down at $OLLAMA_HOST [$LOCAL_LLM_PLATFORM] -- $(ollama_start_hint)"

# Build request JSON safely via python (handles all escaping)
#
# SAMPLING PARAMETERS (card 05f8d99c, Cybersec F1). Ollama's defaults sample, and nothing here used
# to override them -- fine for drafting prose, WRONG for a caller that uses the model as a
# classifier inside a control path: the same input returned MECHANICAL/SECURITY/SECURITY/SECURITY/
# MECHANICAL/MECHANICAL over six runs, which makes every score measured through this script one
# draw rather than a measurement. Callers that need a reproducible answer set
# LOCAL_LLM_TEMPERATURE=0 (and a seed); everything else keeps ollama's defaults untouched, so this
# changes no existing behaviour.
REQ=$(SYSTEM="$SYSTEM" MODEL="$MODEL" PROMPT="$PROMPT" python3 -c '
import json,os
# think:false (card baf1b1b0): unconditional, every call. Verified harmless on a non-reasoning
# model (qwen2.5-coder ignores the field, plain curl test 2026-09-02) -- Ollama accepts "think" as
# a generic top-level generate param regardless of whether the loaded model supports reasoning, so
# this needs no per-model list and stays correct automatically if a future model IS a reasoner. A
# reasoning model left at its default emits an unbounded <think>...</think> block before the real
# answer, which breaks every one of the ~80 skill templates that promise "output ONLY X" (measured
# on bigatuna/Qwen3.5-9b-Sushi-Coder-RL, card 4dee0c4a) -- this is the fix for that class of bug.
d={"model":os.environ["MODEL"],"prompt":os.environ["PROMPT"],"stream":False,"think":False}
s=os.environ.get("SYSTEM","")
if s: d["system"]=s
opts={}
t=os.environ.get("LOCAL_LLM_TEMPERATURE","").strip()
sd=os.environ.get("LOCAL_LLM_SEED","").strip()
# Junk is ignored rather than fatal: a bad env value must not take down every local call. The
# caller that cares about determinism verifies it by measuring, not by trusting this line.
if t:
    try: opts["temperature"]=float(t)
    except ValueError: pass
if sd:
    try: opts["seed"]=int(sd)
    except ValueError: pass
if opts: d["options"]=opts
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

# Register as `running` BEFORE the flock attempt, not after acquiring it (card 5dcd9bc8 decision,
# documented on the card): with a single GPU only one call ever actually generates at a time, so
# gating registration on lock acquisition would leave the dashboard's active-task count stuck at
# 0/1 under real concurrent load -- exactly the bug Peti reported. A call queued behind the lock is
# still active work from the caller's point of view. Best-effort and silent: no token file, no
# reachable dashboard, or any curl/parse failure just means QUEUE_ID stays empty and the call
# proceeds exactly as before this card.
QUEUE_ID=""
QUEUE_HDR_FILE=""
if [[ "$QUEUE_MANAGED" != "1" && -r "$DASH_TOKEN_FILE" ]]; then
  # 0600 temp header file, never the token on the curl command line: a Bearer header built with a
  # direct command-substitution expansion is visible via /proc/<pid>/cmdline (world-readable, no
  # hidepid here) the moment the shell expands it, before exec -- same pattern as
  # local-llm-worker.sh and weekly-usage-panel-read.sh.
  QUEUE_HDR_FILE="$(mktemp)" && chmod 600 "$QUEUE_HDR_FILE" \
    && printf 'Authorization: Bearer %s\n' "$(cat "$DASH_TOKEN_FILE" 2>/dev/null)" > "$QUEUE_HDR_FILE" \
    || QUEUE_HDR_FILE=""
  trap '[[ -n "$QUEUE_HDR_FILE" ]] && rm -f "$QUEUE_HDR_FILE"' EXIT
fi
if [[ -n "$QUEUE_HDR_FILE" ]]; then
  QUEUE_ID="$(CALLER="${CALLER:-direct}" TASK_LABEL="${LOG_TASK:-$TASK}" python3 -c '
import json, os
print(json.dumps({"agent": os.environ["CALLER"], "task_type": os.environ.get("TASK_LABEL") or None, "source": "direct-sync"}))
' 2>/dev/null | curl -fsS -m 5 -X POST "$DASH_API/start" \
      -H "@$QUEUE_HDR_FILE" \
      -H "Content-Type: application/json" --data-binary @- 2>/dev/null \
      | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("id") or "")
except Exception: pass' 2>/dev/null || true)"
fi
_queue_finish() { # $1=complete|fail
  [[ -z "$QUEUE_ID" ]] && return 0
  local body
  if [[ "$1" == complete ]]; then body='{"result":""}'; else body='{"error":"local-llm.sh call failed"}'; fi
  curl -fsS -m 5 -X POST "$DASH_API/$QUEUE_ID/$1" \
    -H "@$QUEUE_HDR_FILE" \
    -H "Content-Type: application/json" -d "$body" >/dev/null 2>&1 || true
}

# INTERNAL SAFETY-NET TIMEOUT (card cea524b1): a CALLER wrapping this whole script in its own
# `timeout N` is not reliable enforcement on its own. Measured directly: a bash process with an
# EXIT trap installed (the header-file cleanup trap above) that is blocked in a foreground command
# substitution can fail to act on the caller's SIGTERM until the blocked child finishes on its own --
# reproduced with a hung curl behind flock, where an external `timeout 3` did not stop it and it ran
# to curl's own -m budget instead. That left the ONLY real ceiling as GPU_LOCK_WAIT (600s) + TIMEOUT
# (120s) = up to 720s, versus the 45s a caller like route-classify.sh actually expects -- the gap the
# reported incident (20+ minute lock hold) fell into.
#
# `timeout -k` from a FRESH (non-bash) process is immune to that trap/wait interaction -- verified:
# it killed a hung curl+flock chain at its deadline with zero stragglers, repeatedly. `-k 5` escalates
# to SIGKILL 5s after the initial TERM, which cannot be deferred or ignored by anything downstream.
# This bounds the worst case to a known, guaranteed number instead of leaving it fully open; it does
# NOT replace a caller doing its own tighter budgeting (see route-classify.sh's env overrides).
#
# Guarded by `command -v`: `timeout` is not guaranteed on macOS (no hard new cross-platform
# dependency, matching this file's own "nothing branches on OS" invariant) -- absent, it falls back
# to the pre-existing behavior, no worse than before this fix.
GEN_CMD=(flock -w "$GPU_LOCK_WAIT" "$GPU_LOCK" curl -fsS -m "$TIMEOUT" -X POST "$OLLAMA_HOST/api/generate" \
  -H "Content-Type: application/json" -d "$REQ")
if command -v timeout >/dev/null 2>&1; then
  GEN_CMD=(timeout -k 5 "$(( GPU_LOCK_WAIT + TIMEOUT + 10 ))" "${GEN_CMD[@]}")
fi
RESP=$("${GEN_CMD[@]}" 2>/dev/null) || {
  gen_rc=$?
  # 'busy', not 'err' (card b8fff0fe, Cybersec finding on 71188a2a): gen_rc=1 means the GPU lock was
  # contended, not that generation failed -- see the flock-exit-code note just below, which this
  # reuses the SAME condition from rather than re-deriving it. Before this, every busy-vs-real-error
  # row logged identically, so the log itself could never answer "how often does contention happen",
  # the exact question 71188a2a asked and could not.
  log_usage "$([[ "$gen_rc" -eq 1 ]] && echo busy || echo err)" "$(_elapsed)"
  _queue_finish fail
  # `flock -w N` exits 1, and ONLY 1, when it fails to acquire the lock within the wait -- it never
  # execs the wrapped curl in that case, so this is reliably flock's own status, not curl's. curl
  # itself (this fixed, well-formed invocation: static OLLAMA_HOST, fixed method/headers) never
  # legitimately exits 1 -- that code is CURLE_UNSUPPORTED_PROTOCOL, which cannot occur here. So
  # gen_rc=1 means "GPU busy with someone else's call", not "the model call failed" -- the local
  # model never even started on this task (card ea931c14, plan-grilling requirement 2, MikroB
  # komment 14138). The caller (local-llm-worker.sh) must not count this as a used attempt.
  if [[ "$gen_rc" -eq 1 ]]; then
    die 6 "gpu lock busy -- could not acquire within ${GPU_LOCK_WAIT}s (not a generation failure)"
  fi
  # distinguish model-missing from generic error
  if ollama_up && ! curl -fsS -m 5 "$OLLAMA_HOST/api/tags" | grep -q "${MODEL%%:*}"; then
    die 3 "model '$MODEL' not pulled -- run: ollama pull $MODEL"
  fi
  die 5 "ollama api error (timeout ${TIMEOUT}s or server error)"
}
# Exact local token accounting (Ollama returns eval_count=out, prompt_eval_count=in) plus
# eval_duration (ns, generation-only time -- excludes prompt processing and GPU-lock wait), the
# same figure LM Studio/llama.cpp's own "[generation: ... speed=N tokens/s]" log line is computed
# from (card b21deb9a). Converted to whole ms here so the ledger stays integer-only like every
# other numeric column; the dashboard divides eval_count by this to get tokens/s.
_TOKS=$(echo "$RESP" | python3 -c "import json,sys
try:
    d=json.load(sys.stdin)
    print(int(d.get('eval_count',0)), int(d.get('prompt_eval_count',0)), round(d.get('eval_duration',0)/1e6))
except Exception:
    print('0 0 0')" 2>/dev/null || echo "0 0 0")
log_usage ok "$(_elapsed)" $_TOKS
_queue_finish complete

echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('response','').rstrip()) if 'response' in d else sys.exit('local-llm: '+d.get('error','unknown error'))"
