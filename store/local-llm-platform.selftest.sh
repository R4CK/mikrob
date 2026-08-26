#!/usr/bin/env bash
# Self-test for the cross-platform bits of local-llm.sh (card b097b578).
#
# Run:  bash store/local-llm-platform.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
#
# It exercises BOTH OS branches on ONE machine by driving the detection override
# (LOCAL_LLM_PLATFORM) and by simulating a BSD `date` that lacks %N -- so the macOS
# path is genuinely tested here, not merely written and hoped for. What it CANNOT
# prove is real Ollama/Metal behaviour on Apple hardware; see the card REVIEW.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/local-llm.sh"
pass=0; fail=0
ok()   { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

# --- 1. detect_platform() classifies this host, and the override wins ---------------------------
# Source only the top of the script (the definitions) without running the CLI body.
eval "$(sed -n '/^detect_platform()/,/^}/p' "$SCRIPT")"

got="$(detect_platform)"
case "$got" in
  linux|wsl|macos|unknown) ok "detect_platform returns a known class ($got)" ;;
  *) bad "detect_platform returns a known class" "got '$got'" ;;
esac

# On this host (Linux/WSL) it must NOT claim macOS.
if [[ "$(uname -s)" == "Linux" && "$got" == "macos" ]]; then
  bad "Linux host not misdetected as macos" "got $got"
else
  ok "host not misdetected (uname=$(uname -s) -> $got)"
fi

# --- 2. the start hint is platform-correct for EVERY branch -------------------------------------
eval "$(sed -n '/^ollama_start_hint()/,/^}/p' "$SCRIPT")"

check_hint() { # $1=platform  $2=substring that MUST appear  $3=substring that must NOT
  LOCAL_LLM_PLATFORM="$1"
  local out; out="$(ollama_start_hint)"
  if [[ "$out" != *"$2"* ]]; then bad "hint[$1] mentions '$2'" "got: $out"; return; fi
  if [[ -n "${3:-}" && "$out" == *"$3"* ]]; then bad "hint[$1] omits '$3'" "got: $out"; return; fi
  ok "hint[$1] correct: $out"
}
# macOS has no systemd -- the hint must never tell a Mac user to run systemctl.
check_hint macos   "Ollama"    "systemctl"
check_hint linux   "systemctl" ""
check_hint wsl     "systemctl" ""
check_hint unknown "ollama serve" "systemctl"

# --- 3. the millisecond clock works with AND without GNU `date %N` ------------------------------
eval "$(sed -n '/^_now_ms()/,/^}/p' "$SCRIPT")"

t="$(_now_ms)"
if [[ "$t" =~ ^[0-9]+$ && "$t" -gt 1000000000000 ]]; then
  ok "_now_ms returns a plausible epoch-ms ($t)"
else
  bad "_now_ms returns a plausible epoch-ms" "got '$t'"
fi

# Simulate BSD/macOS date: %N unsupported -> emits a trailing literal 'N'.
# This is the exact shape that used to poison the arithmetic under `set -e`.
date() { if [[ "${1:-}" == "+%s%N" ]]; then echo "1785441395N"; else command date "$@"; fi; }
t2="$(_now_ms)"
unset -f date
if [[ "$t2" =~ ^[0-9]+$ && "$t2" -gt 1000000000000 ]]; then
  ok "_now_ms falls back correctly when date lacks %N (BSD/macOS): $t2"
else
  bad "_now_ms BSD fallback" "got '$t2' -- a Mac would break here"
fi

# --- 4. no Linux-only assumption remains in the RUNTIME path ------------------------------------
# systemctl may appear ONLY inside an echoed hint string, never as an executed command
# (a line that INVOKES it would start with optional whitespace then `systemctl`).
if grep -nE '^[[:space:]]*systemctl' "$SCRIPT" >/dev/null 2>&1; then
  bad "systemctl is never INVOKED (hints only)" "$(grep -nE '^[[:space:]]*systemctl' "$SCRIPT" | head -3)"
else
  ok "systemctl never invoked -- it only appears inside the Linux hint string"
fi

# --- 5. the script still parses on this shell ----------------------------------------------------
if bash -n "$SCRIPT" 2>/dev/null; then ok "local-llm.sh parses (bash -n)"; else bad "local-llm.sh parses" ""; fi

echo
if [[ $fail -gt 0 ]]; then echo "$fail FAILED, $pass passed"; exit 1; fi
echo "All $pass checks pass."
