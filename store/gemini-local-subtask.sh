#!/usr/bin/env bash
# gemini-local-subtask.sh -- the ONE narrow tool the bwrap-jailed Gemini "agy" engine gets for
# delegating a sub-task to the local Ollama model (card a020247b, Peti decision 2026-10-14).
#
# Interface, by design: stdin carries the prompt text, nothing else. There is NO filename
# parameter and NO caller-suppliable model name -- a file argument would let a compromised/
# manipulated "agy" turn this into a general file-read/exfil tool, and a caller-chosen model name
# would let it pull/run something unbounded. The only thing this script can be asked to do is
# "run this text through the one fixed local model and give the text back."
#
# Threat model (card a020247b comment on the kanban card has the full STRIDE table). The short
# version MikroB and backend2 agreed on: the jailed agy process can ALREADY reach the network
# (scripts/seged-hivo.py's jail_cmd() does not --unshare-net) and the plain `ollama` binary is
# already ro-bound onto its PATH (~/.local/bin/ollama) -- so this script does not open a new
# attack surface, it gives the GOOD-FAITH path a gate the raw path never had: the kill-switch and
# the GPU-utilization guard. A bad-faith agy could still bypass this script and hit Ollama raw;
# that gap is tracked on 5229ea1e (DevO), not this card, per MikroB's explicit scoping (inter-agent
# msg 12422/12427, 2026-10-15) -- it is not safe to hand-roll a netns/veth/iptables fix here
# without the tooling (nft/iptables/slirp4netns/pasta are not installed on this host, verified).
#
# Every path below is a FIXED, jail-internal location this script is bind-mounted alongside
# (scripts/seged-hivo.py's jail_cmd(), engine == 'agy' only) -- never an argument, never derived
# from caller input. Env overrides exist ONLY for the selftest.
set -euo pipefail

# Jail-internal, under $HOME (not /opt: that is root-owned and part of the whole-root ro-bind in
# scripts/seged-hivo.py's jail_cmd(), so a new path cannot be created there inside the sandbox --
# measured directly while wiring this up). $HOME inside the jail is fixed to the real host HOME
# value (jail_cmd sets it via --setenv), so this resolves the same way every invocation.
SUBTASK_DIR="${HOME:-/root}/.gemini-local-subtask"
KILL_SWITCH_FILE="${GEMINI_LOCAL_SUBTASK_KILLSWITCH:-$SUBTASK_DIR/local-first-draft.json}"
VRAM_GUARD_SCRIPT="${GEMINI_LOCAL_SUBTASK_VRAM_GUARD:-$SUBTASK_DIR/vram-guard-check.sh}"
VRAM_GUARD_CONFIG="${GEMINI_LOCAL_SUBTASK_VRAM_GUARD_CONFIG:-$SUBTASK_DIR/vram-guard-config.json}"
VRAM_GUARD_STATE="${GEMINI_LOCAL_SUBTASK_VRAM_GUARD_STATE:-$SUBTASK_DIR/vram-guard-state.json}"
LOG_FILE="${GEMINI_LOCAL_SUBTASK_LOG:-$SUBTASK_DIR/calls.log}"
OLLAMA_HOST="${GEMINI_LOCAL_SUBTASK_OLLAMA_HOST:-http://127.0.0.1:11434}"
# Fixed, not caller-suppliable. Keep in sync with store/local-llm-model (the fleet's own default
# coding model) by hand -- binding that file too would be one more jail exit to reason about for
# a value that changes rarely.
MODEL="${GEMINI_LOCAL_SUBTASK_MODEL:-qwen2.5-coder:7b-instruct-q4_K_M}"
TIMEOUT="${GEMINI_LOCAL_SUBTASK_TIMEOUT:-120}"

# Append-only BY CONVENTION ONLY: the log is a `--bind` (read-write), not something bwrap can make
# OS-enforced-append-only on this filesystem. A compromised agy could truncate its OWN call log --
# it cannot reach any other file. Never logs prompt or response text, only metadata, so there is
# nothing to leak even if an attacker reads it back.
log() {
  printf '%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "agy-local-subtask" "$1" "${2:-}" \
    >> "$LOG_FILE" 2>/dev/null || true
}

refuse() {
  log "$1" "${2:-}"
  echo "LOCAL_SUBTASK_REFUSED: $1" >&2
  exit 1
}

# 1. Master kill-switch (card d57d8a01). Same fail direction as store/local-first-draft-check.sh:
#    absent or unreadable/unparseable file = ON. That is a DELIBERATE, already-measured fleet
#    convention (plan-grilling point 2, d57d8a01 history) for this exact file, not something to
#    relitigate here -- only an explicit {"enabled": false} refuses.
if [ -f "$KILL_SWITCH_FILE" ]; then
  enabled="$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print("off" if d.get("enabled") is False else "on")
except Exception:
    print("on")
' "$KILL_SWITCH_FILE" 2>/dev/null || echo on)"
  [ "$enabled" != "off" ] || refuse "killswitch-off"
fi

# 2. GPU-utilization gate (store/vram-guard-check.sh, gpu-util-hold tier). Its own exit code is
#    authoritative: 0 = ADMIT, non-zero (1 = HOLD, or anything else) = refuse. If the script itself
#    is not present in this jail (should not happen in production, but selftests exercise this),
#    fail OPEN here matches the guard's own "nvidia-smi missing -> ADMIT" convention: absence of
#    the guard is not grounds to block a feature the guard was never wired into.
if [ -x "$VRAM_GUARD_SCRIPT" ]; then
  guard_out="$(bash "$VRAM_GUARD_SCRIPT" --config "$VRAM_GUARD_CONFIG" --state "$VRAM_GUARD_STATE" 2>&1)" \
    || refuse "gpu-util-hold" "${guard_out%%$'\n'*}"
fi

# 3. Prompt comes from stdin ONLY. No filename parameter exists for this script to accept.
prompt="$(cat)"
[ -n "$prompt" ] || refuse "empty-prompt"

# 4. The actual call. Canonical shape (store/local-llm.sh): stream:false, think:false, temperature
#    0. Model is the fixed constant above, never the caller's choice.
req="$(python3 -c '
import json, sys
print(json.dumps({"model": sys.argv[1], "prompt": sys.argv[2], "stream": False, "think": False,
                   "options": {"temperature": 0}}))
' "$MODEL" "$prompt")"

if ! resp="$(curl -fsS -m "$TIMEOUT" -X POST "$OLLAMA_HOST/api/generate" \
    -H 'Content-Type: application/json' -d "$req")"; then
  refuse "ollama-call-failed"
fi

out="$(printf '%s' "$resp" | python3 -c 'import json, sys
try:
    print(json.load(sys.stdin).get("response", ""))
except Exception:
    print("")
')"

log "ok" ""
printf '%s\n' "$out"
