#!/usr/bin/env bash
# Self-test for the OLLAMA_HOST loopback guard in local-llm.sh (card 0d2be5e5, Cybersec).
#
# Run:  bash store/local-llm-host-guard.selftest.sh
# Exit: 0 = all pass, 1 = at least one case wrong.
#
# WHY THIS EXISTS. OLLAMA_HOST was overridable with no validation, and since the specialist routing
# landed, --task morning-brief / daily-log / board-reconcile / tg-draft carry the owner's email and
# calendar content and the whole kanban state. A remote value made every one of those a silent
# outbound transfer. The guard fails closed; these cases pin BOTH directions, because an
# over-eager refusal breaks every local call and a lax one restores the leak.
#
# The REFUSAL half deliberately includes the shapes that LOOK local and are not -- a suffixed host
# (127.0.0.1.example.com) and userinfo smuggling (http://127.0.0.1@elsewhere/) -- since those are
# what a prefix test would wave through.
#
# No network and no model needed: --status is a read-only path, and the guard runs before it.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM="$HERE/local-llm.sh"
fail=0
n=0

# $1 label, $2 expected (allow|refuse), $3 host, $4 optional extra env assignment
t() {
  n=$((n + 1))
  local out got
  if [ -n "${4:-}" ]; then
    out="$(OLLAMA_HOST="$3" env "$4" bash "$LLM" --status 2>&1)"
  else
    out="$(OLLAMA_HOST="$3" bash "$LLM" --status 2>&1)"
  fi
  if printf '%s' "$out" | grep -q "is not loopback"; then got="refuse"; else got="allow"; fi
  if [ "$got" = "$2" ]; then
    printf 'OK   %-6s <- %-6s %s\n' "$2" "$got" "$1"
  else
    printf 'FAIL %-6s <- %-6s %s\n' "$2" "$got" "$1"
    fail=$((fail + 1))
  fi
}

echo "local-llm OLLAMA_HOST guard selftest"

# --- must be ALLOWED: every genuine loopback spelling -----------------------------------------
t "the default host"                       allow "http://127.0.0.1:11434"
t "localhost by name"                      allow "http://localhost:11434"
t "uppercase LOCALHOST (host names are case-insensitive)" allow "http://LOCALHOST:11434"
t "anywhere in 127.0.0.0/8, not just .0.1" allow "http://127.0.0.2:11434"
t "IPv6 loopback in brackets"              allow "http://[::1]:11434"
t "a non-default PORT is still loopback"   allow "http://127.0.0.1:9999"
t "https to loopback"                      allow "https://127.0.0.1:11434"

# --- must be REFUSED --------------------------------------------------------------------------
t "a plain remote address"                 refuse "http://10.0.0.5:11434"
t "a remote name"                          refuse "http://ollama.example.com:11434"
# The two that a naive prefix/substring test would let through:
t "SUFFIXED host that starts with 127.0.0.1" refuse "http://127.0.0.1.example.com:11434"
t "USERINFO smuggling: the authority is after the @" refuse "http://127.0.0.1@ollama.example.com/"
t "userinfo smuggling with a bracketed v6 user"      refuse "http://[::1]@ollama.example.com/"
# Not just egress: an unknown scheme makes curl exit 1 (CURLE_UNSUPPORTED_PROTOCOL), which
# local-llm.sh reports as `die 6 gpu lock busy -- not a generation failure`, on which
# local-llm-worker.sh REVERTS the attempt count. A typo'd scheme would retry for ever.
t "unknown scheme (also the exit-1 hazard)" refuse "xyzzy://127.0.0.1:11434"
t "file:// scheme"                          refuse "file:///etc/passwd"
t "0.0.0.0 is not provably loopback"        refuse "http://0.0.0.0:11434"

# --- the opt-in escape, which must work AND be loud -------------------------------------------
t "an explicit opt-in allows a remote host" allow "http://10.0.0.5:11434" "LOCAL_LLM_ALLOW_REMOTE_HOST=1"

n=$((n + 1))
out="$(OLLAMA_HOST="http://10.0.0.5:11434" env LOCAL_LLM_ALLOW_REMOTE_HOST=1 bash "$LLM" --status 2>&1)"
if printf '%s' "$out" | grep -q "prompt content LEAVES THIS MACHINE"; then
  printf 'OK   %-6s <- %-6s %s\n' "loud" "loud" "the opt-in says what it costs, on every call"
else
  printf 'FAIL %-6s <- %-6s %s\n' "loud" "quiet" "the opt-in says what it costs, on every call"
  fail=$((fail + 1))
fi

# A non-default but still-loopback host must be NAMED (the card's "log which host is used"): a
# hijack that stays on loopback -- a different port, say -- should not be invisible either.
n=$((n + 1))
out="$(OLLAMA_HOST="http://127.0.0.1:9999" bash "$LLM" --status 2>&1)"
if printf '%s' "$out" | grep -q "OLLAMA_HOST=http://127.0.0.1:9999"; then
  printf 'OK   %-6s <- %-6s %s\n' "named" "named" "a non-default loopback host is still announced"
else
  printf 'FAIL %-6s <- %-6s %s\n' "named" "silent" "a non-default loopback host is still announced"
  fail=$((fail + 1))
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "selftest: $n case(s), PASS"
  exit 0
fi
echo "selftest: $n case(s), $fail FAILED"
exit 1
