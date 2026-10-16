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
# Threat model (card a020247b comment on the kanban card has the full STRIDE table; delta per
# WhiteHat2's CYBERSEC NO-GO, komment 19540, @48cb0100). The short version MikroB and backend2
# agreed on: the jailed agy process can ALREADY reach the network (scripts/seged-hivo.py's
# jail_cmd() does not --unshare-net) and the plain `ollama` binary is already ro-bound onto its
# PATH (~/.local/bin/ollama) -- so this script does not open a new attack surface, it gives the
# GOOD-FAITH path a gate the raw path never had: the kill-switch and the GPU-utilization guard.
# A bad-faith agy could still bypass this script and hit Ollama raw; that gap is tracked on
# 5229ea1e (DevO), not this card, per MikroB's explicit scoping (inter-agent msg 12422/12427,
# 2026-10-15) -- it is not safe to hand-roll a netns/veth/iptables fix here without the tooling
# (nft/iptables/slirp4netns/pasta are not installed on this host, verified).
#
# WhiteHat2's F3: a bad-faith agy ALSO controls the environment of its own child processes (it is
# the direct parent of any gemini-local-subtask invocation), so every GEMINI_LOCAL_SUBTASK_* value
# below is just as forgeable by that same bad-faith path as the raw-bypass above -- there is no env
# var a process can set for a child it spawns that the parent cannot also override, so "selftest-
# only" was never literally true in production. Forging any of them (killswitch off, model, host,
# log path) grants nothing beyond what raw-bypassing this wrapper already grants, which is the
# already-accepted 5229ea1e scope, not a new capability -- the gates below remain correctly
# described as GOOD-FAITH conveniences only, same as the opening paragraph already says about the
# wrapper as a whole.
#
# Every path below is a FIXED, jail-internal location this script is bind-mounted alongside
# (scripts/seged-hivo.py's jail_cmd(), engine == 'agy' only) -- never an argument, never derived
# from caller input.
set -euo pipefail

# Jail-internal, under $HOME (not /opt: that is root-owned and part of the whole-root ro-bind in
# scripts/seged-hivo.py's jail_cmd(), so a new path cannot be created there inside the sandbox --
# measured directly while wiring this up). $HOME inside the jail is fixed to the real host HOME
# value (jail_cmd sets it via --setenv), so this resolves the same way every invocation.
SUBTASK_DIR="${HOME:-/root}/.gemini-local-subtask"
# Card a020247b F1/F2 (WhiteHat2 NO-GO 19540): both now come from the ONE read-only DIRECTORY bind
# at the literal jail path below (scripts/seged-hivo.py's agy_subtask_binds()) instead of
# individual single-file binds -- see that function's comment for why a directory bind is required
# for the host's atomic rename (tmp+rename) to stay visible for this jail's whole lifetime. Neither
# file is read via nvidia-smi or any GPU device node inside the jail any more (F1): both are
# snapshots the HOST keeps fresh (store/vram-guard-check.sh's ambient GATE_MIRROR writes,
# src/web/routes/local-llm.ts's kill-switch mirror write).
#
# Card 19ef0eca (WhiteHat2 finding on the 67a78f4c gate, komment 20244): these two paths ARE the
# gate decision itself, so unlike OLLAMA_HOST/MODEL/TIMEOUT/LOG below (mechanical config, already
# accepted as no-new-capability per the F3 note above), they are FIXED constants, never env-
# overridable. A bad-faith agy controls the environment of any child process IT spawns (same F3
# reasoning) -- an env override here would let it point the gate at a file it just wrote itself
# inside the jail's own writable --tmpfs, forging an ADMIT without ever touching the real,
# host-written mirror. Measured by WhiteHat2: a forged {"admit":true} file via this env var did
# pass the gate.
#
# Card b30ad7e6 F1 (RedHat finding on 19ef0eca's edc5bd86 GO): the 19ef0eca fix above stopped the
# NAMED env-var override, but these two paths were still COMPUTED from $SUBTASK_DIR, which is
# itself "${HOME:-/root}/..." -- and a bad-faith agy controls $HOME for any child process it spawns
# (gemini-local-subtask.sh included) just as freely as it controlled the named env vars. Exporting
# a scratch HOME before invoking this script would move the WHOLE gate-decision lookup into a
# directory the attacker fully controls, including a forged {"admit":true}/{"enabled":true} pair
# with a fresh timestamp -- the fixed-name-env-var fix above does not block this, because no env
# var named GEMINI_LOCAL_SUBTASK_* is involved, only $HOME itself.
#
# Fix: these two paths are now a LITERAL absolute jail path, matching exactly what
# scripts/seged-hivo.py's agy_subtask_binds() binds there (SUBTASK_GATE_JAIL_DIR) -- no $HOME
# computation on either side any more, so there is nothing left for a scratch HOME to redirect.
GATE_JAIL_DIR="/run/gemini-local-subtask-gate"
KILL_SWITCH_MIRROR="$GATE_JAIL_DIR/killswitch-mirror.json"
GPU_GATE_MIRROR="$GATE_JAIL_DIR/gpu-gate-mirror.json"
# A gate verdict older than this is DOUBT, not absence -- same fail-safe direction as every other
# "tool present but unreadable" branch in this threat model: on doubt, HOLD (route online), never
# silently ADMIT just because nothing has refreshed the mirror lately. Generous relative to how
# often the fleet's ambient dispatch activity calls vram-guard-check.sh in practice (card 108c7b10's
# whole reason to exist is that this happens often), so staleness should be rare. Fixed, not env-
# overridable, same reasoning as the two mirror paths above (cards 19ef0eca, b30ad7e6).
GPU_GATE_STALE_S=600
LOG_FILE="${GEMINI_LOCAL_SUBTASK_LOG:-$SUBTASK_DIR/calls.log}"
OLLAMA_HOST="${GEMINI_LOCAL_SUBTASK_OLLAMA_HOST:-http://127.0.0.1:11434}"
# Fixed, not caller-suppliable in the good-faith path. Keep in sync with store/local-llm-model (the
# fleet's own default coding model) by hand -- binding that file too would be one more jail exit to
# reason about for a value that changes rarely.
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
if [ -f "$KILL_SWITCH_MIRROR" ]; then
  enabled="$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print("off" if d.get("enabled") is False else "on")
except Exception:
    print("on")
' "$KILL_SWITCH_MIRROR" 2>/dev/null || echo on)"
  [ "$enabled" != "off" ] || refuse "killswitch-off"
fi

# 2. GPU-utilization gate (card a020247b F1, WhiteHat2 NO-GO 19540). The jail no longer runs
#    nvidia-smi or touches any GPU device node -- it reads the host-maintained mirror above and
#    applies the SAME fail-safe direction the removed in-jail vram-guard-check.sh call used: tool
#    output absent/stale = doubt = HOLD, never a silent ADMIT. Absent entirely (e.g. not yet
#    written on a fresh host before anything has called vram-guard-check.sh once) also HOLDs here,
#    unlike vram-guard-check.sh's own "nvidia-smi absent -> ADMIT" (that convention is about a GPU
#    not EXISTING; a missing mirror file says nothing about whether a GPU exists, only that nobody
#    has reported in yet, which is doubt).
if [ -f "$GPU_GATE_MIRROR" ]; then
  gate_out="$(python3 -c '
import json, sys, time
try:
    d = json.load(open(sys.argv[1]))
    age = time.time() - float(d["at"])
    if age > float(sys.argv[2]):
        print("stale age=%.0fs" % age); sys.exit(1)
    if d.get("admit") is True:
        print(d.get("reason", "ok")); sys.exit(0)
    print(d.get("reason", "hold")); sys.exit(1)
except Exception as e:
    print("unreadable (%s)" % e); sys.exit(1)
' "$GPU_GATE_MIRROR" "$GPU_GATE_STALE_S")" || refuse "gpu-util-hold" "$gate_out"
else
  refuse "gpu-util-hold" "no-gate-mirror-yet"
fi

# 3. Prompt comes from stdin ONLY. No filename parameter exists for this script to accept.
prompt="$(cat)"
[ -n "$prompt" ] || refuse "empty-prompt"

# 4. The actual call. Canonical shape (store/local-llm.sh): stream:false, think:false, temperature
#    0. Model is the fixed constant above, never the caller's choice. Card a020247b F4 (WhiteHat2
#    19540): the prompt goes through STDIN, not argv -- `python3 -c ... "$prompt"` hit the kernel's
#    ARG_MAX on a prompt over ~128 KB (measured: `Argument list too long`, exit 126, no REFUSED
#    message, no log row -- a silent, unlogged failure). A shell variable fed via a heredoc has no
#    such limit; stdin is a pipe, not an execve() argument vector.
req="$(python3 -c '
import json, sys
model = sys.argv[1]
prompt = sys.stdin.read()
print(json.dumps({"model": model, "prompt": prompt, "stream": False, "think": False,
                   "options": {"temperature": 0}}))
' "$MODEL" <<< "$prompt")"

# --data-binary @- (stdin), NOT -d "$req": the same ARG_MAX limit F4 fixed for python3 -c applies
# just as much to curl's own argv -- measured directly, the same "Argument list too long" on a
# 200 KB body via -d "$req".
if ! resp="$(curl -fsS -m "$TIMEOUT" -X POST "$OLLAMA_HOST/api/generate" \
    -H 'Content-Type: application/json' --data-binary @- <<< "$req")"; then
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
