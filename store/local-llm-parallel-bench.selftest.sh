#!/usr/bin/env bash
# Self-test for local-llm-parallel-bench.sh (card 2c28ecee).
#
# Run:  bash store/local-llm-parallel-bench.selftest.sh
# Exit: 0 = all pass, 1 = at least one failure.
#
# No real Ollama server or GPU needed -- uses --dry-run and --analyze-vram.
# The key behavioral properties under test:
#   - N=1: worker gets the lock without waiting (~0ms queue_wait)
#   - N=2: one worker waits ~DRY_SLEEP for the other (max queue_wait >= 0.8*DRY_SLEEP_MS)
#   - N=3: worst-case wait ~2*DRY_SLEEP (one worker waits for two full cycles)
#   - --analyze-vram: 7B Q4_K_M fits on 6 GiB, 14B does not
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/local-llm-parallel-bench.sh"
pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

SB="$(mktemp -d)"
cleanup() { rm -rf "$SB"; }
trap cleanup EXIT

LOCKFILE="$SB/gpu.lock"
# Short DRY_SLEEP: measurable wait without slow tests.
# 0.3s: with N=2, max queue_wait >= 200ms; with N=3, max >= 500ms.
SLEEP_S="0.3"
SLEEP_MS="300"
COMMON="LOCAL_LLM_GPU_LOCK_PATH=$LOCKFILE LOCAL_LLM_LOCK_WAIT=30 LOCAL_LLM_PARALLEL_DRY_SLEEP=$SLEEP_S"

# --- 0. parse ---------------------------------------------------------------------------------
if bash -n "$SCRIPT" 2>/dev/null; then ok "local-llm-parallel-bench.sh parses (bash -n)"; else bad "parses" ""; fi

# --- 1. no flock on PATH -> refuses loudly ---------------------------------------------------
mkdir -p "$SB/binmask"
for b in bash python3 date seq mktemp rm cat sleep; do
  p="$(command -v "$b" 2>/dev/null)" && ln -sf "$p" "$SB/binmask/$b"
done
out1="$(PATH="$SB/binmask" eval "$COMMON bash '$SCRIPT' --dry-run 2>&1" || true)"
case "$out1" in
  *"flock is required"*) ok "no flock on PATH -> refuses loudly" ;;
  *) bad "no flock -> refuses loudly" "got: $out1" ;;
esac

# Helper: parse queue_wait_ms values from bench CSV output (skip header, skip summary)
parse_waits() {  # stdin: full bench output; stdout: space-separated queue_wait_ms integers
  grep -v '^worker,' | grep -v '^---' | grep ',ok$' | cut -d, -f2 | tr '\n' ' '
}
# Helper: parse gen_time_ms values
parse_gens() {
  grep -v '^worker,' | grep -v '^---' | grep ',ok$' | cut -d, -f3 | tr '\n' ' '
}

# --- 2. N=1: single worker, queue_wait should be near 0 (< SLEEP_MS/4) ----------------------
out2="$(eval "$COMMON bash '$SCRIPT' --workers 1 --dry-run 2>/dev/null" || true)"
waits2="$(echo "$out2" | parse_waits)"
wait2_max="$(echo "$waits2" | tr ' ' '\n' | grep -v '^$' | sort -n | tail -1)"
if [[ -n "$wait2_max" && "$wait2_max" -lt $(( SLEEP_MS / 4 )) ]]; then
  ok "N=1: queue_wait < SLEEP/4 (no contention expected)"
else
  bad "N=1: queue_wait small" "max queue_wait=${wait2_max}ms (expected < $((SLEEP_MS/4))ms)"
fi
# Also: 1 result row
row_count2="$(echo "$out2" | grep -v '^worker,' | grep -v '^---' | grep -c ',ok$' || true)"
if [[ "$row_count2" -eq 1 ]]; then ok "N=1: exactly 1 result row"; else bad "N=1: 1 result row" "got $row_count2"; fi

# --- 3. N=2: max queue_wait >= 0.8 * SLEEP_MS -----------------------------------------------
out3="$(eval "$COMMON bash '$SCRIPT' --workers 2 --dry-run 2>/dev/null" || true)"
waits3="$(echo "$out3" | parse_waits)"
wait3_max="$(echo "$waits3" | tr ' ' '\n' | grep -v '^$' | sort -n | tail -1)"
threshold3=$(( SLEEP_MS * 80 / 100 ))
if [[ -n "$wait3_max" && "$wait3_max" -ge "$threshold3" ]]; then
  ok "N=2: max queue_wait >= 80% of DRY_SLEEP (one worker waited for the other)"
else
  bad "N=2: max queue_wait >= $threshold3 ms" "got ${wait3_max:-none} ms (expected >= $threshold3 ms)"
fi
row_count3="$(echo "$out3" | grep -v '^worker,' | grep -v '^---' | grep -c ',ok$' || true)"
if [[ "$row_count3" -eq 2 ]]; then ok "N=2: exactly 2 result rows"; else bad "N=2: 2 result rows" "got $row_count3"; fi

# --- 4. N=3: max queue_wait >= 1.6 * SLEEP_MS (two full waits for the last worker) ----------
out4="$(eval "$COMMON bash '$SCRIPT' --workers 3 --dry-run 2>/dev/null" || true)"
waits4="$(echo "$out4" | parse_waits)"
wait4_max="$(echo "$waits4" | tr ' ' '\n' | grep -v '^$' | sort -n | tail -1)"
threshold4=$(( SLEEP_MS * 160 / 100 ))
if [[ -n "$wait4_max" && "$wait4_max" -ge "$threshold4" ]]; then
  ok "N=3: max queue_wait >= 160% of DRY_SLEEP (worst worker waited for 2 full cycles)"
else
  bad "N=3: max queue_wait >= $threshold4 ms" "got ${wait4_max:-none} ms"
fi
row_count4="$(echo "$out4" | grep -v '^worker,' | grep -v '^---' | grep -c ',ok$' || true)"
if [[ "$row_count4" -eq 3 ]]; then ok "N=3: exactly 3 result rows"; else bad "N=3: 3 result rows" "got $row_count4"; fi

# --- 5. No deadlock: all workers complete within 5 * N * SLEEP_MS ----------------------------
# (Already covered by checks 3-4 completing in finite time, but explicit timeout makes it clear.)
timeout_s=$(( 5 * 3 ))  # 15 seconds is generous for 3 * 0.3s = 0.9s of work
deadlock_out="$(timeout "$timeout_s" bash -c "eval \"$COMMON bash '$SCRIPT' --workers 3 --dry-run\" 2>/dev/null" || true)"
dead_rows="$(echo "$deadlock_out" | grep -v '^worker,' | grep -v '^---' | grep -c ',ok$' || true)"
if [[ "$dead_rows" -eq 3 ]]; then ok "No deadlock: all 3 workers complete within ${timeout_s}s"; else bad "No deadlock" "got $dead_rows rows within ${timeout_s}s"; fi

# --- 6. Lock released after all workers: a subsequent bench run completes without LOCKBUSY ---
out6="$(eval "$COMMON bash '$SCRIPT' --workers 1 --dry-run 2>/dev/null" || true)"
case "$out6" in
  *",ok"*) ok "Lock released: subsequent N=1 run succeeds (not LOCKBUSY)" ;;
  *LOCKBUSY*) bad "Lock released after workers" "subsequent run got LOCKBUSY" ;;
  *) bad "Lock released" "unexpected output: $out6" ;;
esac

# --- 7. CSV header present -------------------------------------------------------------------
out7="$(eval "$COMMON bash '$SCRIPT' --workers 2 --dry-run 2>/dev/null" || true)"
case "$out7" in
  *"worker,queue_wait_ms,gen_time_ms,eval_tps,ok"*) ok "CSV header present in output" ;;
  *) bad "CSV header present" "header missing in: $(echo "$out7" | head -1)" ;;
esac

# --- 8. --analyze-vram --vram 6144: 7B Q4_K_M fits, 14B does NOT fit -----------------------
out8="$(bash "$SCRIPT" --analyze-vram --vram 6144 2>/dev/null || true)"
case "$out8" in
  *"7b  Q4_K_M"*"YES"*) ok "--analyze-vram: 7B Q4_K_M reports YES (fits on 6 GiB)" ;;
  *) bad "--analyze-vram: 7B Q4_K_M fits" "got: $(echo "$out8" | grep '7b  Q4_K_M' || echo 'line not found')" ;;
esac
case "$out8" in
  *"14b Q4_K_M"*"NO"*) ok "--analyze-vram: 14B Q4_K_M reports NO (does not fit on 6 GiB)" ;;
  *) bad "--analyze-vram: 14B Q4_K_M does not fit" "got: $(echo "$out8" | grep '14b Q4_K_M' || echo 'line not found')" ;;
esac
case "$out8" in
  *"CONCLUSION"*"7B"*"quality ceiling"*|*"CONCLUSION"*) ok "--analyze-vram: conclusion section present" ;;
  *) bad "--analyze-vram: conclusion section present" "missing in output" ;;
esac

# --- 9. --analyze-vram with large VRAM: 7B Q8_0 fits on a hypothetical 16 GiB GPU ----------
out9="$(bash "$SCRIPT" --analyze-vram --vram 16384 2>/dev/null || true)"
case "$out9" in
  *"7b  Q8_0"*"YES"*) ok "--analyze-vram 16 GiB: 7B Q8_0 fits" ;;
  *) bad "--analyze-vram 16 GiB: 7B Q8_0 fits" "got: $(echo "$out9" | grep '7b  Q8_0' || echo 'not found')" ;;
esac

# --- 10. MUTATION CHECK: reduce DRY_SLEEP to near-0 -> N=2 max queue_wait drops below threshold
# With DRY_SLEEP=0.001 (1ms), workers don't hold the lock long enough for measurable queue delay.
# The max queue_wait should be < 100ms (well below our normal threshold of 240ms).
TINY_SLEEP="0.001"
MENV="LOCAL_LLM_GPU_LOCK_PATH=$LOCKFILE LOCAL_LLM_LOCK_WAIT=30 LOCAL_LLM_PARALLEL_DRY_SLEEP=$TINY_SLEEP"
mut_out="$(eval "$MENV bash '$SCRIPT' --workers 2 --dry-run 2>/dev/null" || true)"
mut_waits="$(echo "$mut_out" | parse_waits)"
mut_max="$(echo "$mut_waits" | tr ' ' '\n' | grep -v '^$' | sort -n | tail -1)"
if [[ -n "$mut_max" && "$mut_max" -lt 100 ]]; then
  ok "Mutation check: tiny DRY_SLEEP -> max queue_wait < 100ms (confirms DRY_SLEEP drives the wait)"
else
  bad "Mutation check: tiny DRY_SLEEP should reduce wait" "got max queue_wait=${mut_max}ms (expected < 100ms)"
fi

echo
if [[ $fail -gt 0 ]]; then echo "$fail FAILED, $pass passed"; exit 1; fi
echo "All $pass checks pass."
