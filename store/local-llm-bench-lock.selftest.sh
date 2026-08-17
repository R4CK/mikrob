#!/usr/bin/env bash
# Self-test for the GPU-lock contention guard added to local-llm-bench.sh (card d747d772 / alfeladat
# 7529cabb / lepes 06f501a7, plan-grilling 14327 point 2).
#
# Run:  bash store/local-llm-bench-lock.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
#
# Deliberately does NOT need a real Ollama server: it proves the LOCK gate itself -- that a held lock
# is actually waited on (LOCKBUSY, not a fabricated FAIL that would look like the config under test is
# broken), and that a free lock lets the script proceed to its own curl attempt (which then fails for
# the mundane reason that nothing is listening on the fake host -- a plain FAIL, not LOCKBUSY). That
# distinction is the whole point of the fix: a caller must be able to tell "GPU was busy" apart from
# "the config/model itself failed".
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/local-llm-bench.sh"
pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

SB="$(mktemp -d)"
cleanup() { rm -rf "$SB"; }
trap cleanup EXIT

# --- 0. parses ---------------------------------------------------------------------------------
if bash -n "$SCRIPT" 2>/dev/null; then ok "local-llm-bench.sh parses (bash -n)"; else bad "parses" ""; fi

# --- 1. no flock on PATH -> refuses loudly, does not run unlocked (same control as
# cleancore-main-suite-guard-selftest.sh's SEC-1 check) --------------------------------------------
mkdir -p "$SB/binmask"
for b in bash cat curl seq awk mktemp python3 sleep printf rm dirname basename tr; do
  p="$(command -v "$b" 2>/dev/null)" && ln -sf "$p" "$SB/binmask/$b"
done
out1="$(PATH="$SB/binmask" LOCAL_LLM_MODEL="fake-model" bash "$SCRIPT" --ctx 4096 --repeat 1 2>&1)"
case "$out1" in
  *"flock is required"*) ok "no flock on PATH -> refuses loudly, does not run unlocked" ;;
  *) bad "no flock on PATH -> refuses loudly" "got: $out1" ;;
esac

# --- 2. lock genuinely HELD by another process -> the bench run reports LOCKBUSY, not FAIL --------
LOCKFILE="$SB/gpu.lock"
# Hold the lock in a background subshell for long enough to outlast the bench's short wait budget.
( exec 8>"$LOCKFILE"; flock 8; sleep 6 ) &
holder_pid=$!
sleep 1   # let the holder actually acquire before the bench script starts racing it

out2="$(OLLAMA_HOST="http://127.0.0.1:1" LOCAL_LLM_MODEL="fake-model" \
  LOCAL_LLM_GPU_LOCK_PATH="$LOCKFILE" LOCAL_LLM_LOCK_WAIT=2 \
  bash "$SCRIPT" --ctx 4096 --repeat 1 --label lockheld 2>/dev/null | tail -1)"
case "$out2" in
  *,LOCKBUSY) ok "held lock -> LOCKBUSY row (waited, did not fabricate a config FAIL)" ;;
  *) bad "held lock -> LOCKBUSY row" "got: $out2" ;;
esac
wait "$holder_pid" 2>/dev/null

# --- 3. lock FREE -> the script proceeds past the gate; with nothing listening on the fake host it
# fails for the mundane reason (empty curl response), reported as FAIL, never LOCKBUSY. Proves the
# gate does not fire when there is no real contention. ----------------------------------------------
out3="$(OLLAMA_HOST="http://127.0.0.1:1" LOCAL_LLM_MODEL="fake-model" \
  LOCAL_LLM_GPU_LOCK_PATH="$SB/gpu-free.lock" LOCAL_LLM_LOCK_WAIT=2 \
  bash "$SCRIPT" --ctx 4096 --repeat 1 --label lockfree 2>/dev/null | tail -1)"
case "$out3" in
  *,FAIL) ok "free lock -> proceeds past the gate, fails for its own reason (FAIL, not LOCKBUSY)" ;;
  *) bad "free lock -> FAIL (not LOCKBUSY)" "got: $out3" ;;
esac

# --- 4. the lock is released between iterations, not held for the whole sweep: a second bench run
# started right after the first (lock-free) one completes must not itself report LOCKBUSY. ----------
out4="$(OLLAMA_HOST="http://127.0.0.1:1" LOCAL_LLM_MODEL="fake-model" \
  LOCAL_LLM_GPU_LOCK_PATH="$SB/gpu-free.lock" LOCAL_LLM_LOCK_WAIT=2 \
  bash "$SCRIPT" --ctx 4096 --repeat 1 --label lockfree2 2>/dev/null | tail -1)"
case "$out4" in
  *,LOCKBUSY) bad "lock released after each iteration" "second run still saw LOCKBUSY: $out4" ;;
  *) ok "lock released after each iteration (a following run is not blocked by its own predecessor)" ;;
esac

echo
if [[ $fail -gt 0 ]]; then echo "$fail FAILED, $pass passed"; exit 1; fi
echo "All $pass checks pass."
