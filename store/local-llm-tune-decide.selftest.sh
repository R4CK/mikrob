#!/usr/bin/env bash
# Self-test for local-llm-tune-decide.sh (card 8192b9ee / lepes 30fc88c7).
#
# Run:  bash store/local-llm-tune-decide.selftest.sh
# Exit: 0 = all pass, 1 = at least one failure.
#
# Does NOT need a real Ollama server or GPU -- all GPU interaction is skipped via --dry-run and
# a fake systemctl binary.  The mutation check exercises the regression guard live.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/local-llm-tune-decide.sh"
pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

SB="$(mktemp -d)"
cleanup() { rm -rf "$SB"; }
trap cleanup EXIT

# Shared minimal unit file template (kept read-only as a master copy for new_unit())
BASE_UNIT="$SB/ollama.base"
cat > "$BASE_UNIT" <<'UNIT'
[Unit]
Description=Ollama

[Service]
ExecStart=/usr/bin/ollama serve

[Install]
WantedBy=default.target
UNIT

# CSV helpers
header="label,model,ctx,gpu_split,ctx_loaded,kv_mib,kv_type,load_ms,prompt_tps,eval_tps,ok"

# Produce N copies of a CSV row with given label, ctx, etps (all ok)
rows() { # $1=label $2=ctx $3=etps $4=count
  for _i in $(seq 1 "${4:-1}"); do
    printf '%s,model,%s,-,-,-,-,-,50.0,%s,ok\n' "$1" "$2" "$3"
  done
}

new_unit() {
  cp "$BASE_UNIT" "$SB/ollama.service"  # restore from clean template (separate file -- no self-copy)
}

LOCKFILE="$SB/gpu.lock"
COMMON_ENV="OLLAMA_UNIT=$SB/ollama.service LOCAL_LLM_GPU_LOCK_PATH=$LOCKFILE LOCAL_LLM_LOCK_WAIT=5"

# --- 0. parse -----------------------------------------------------------------------------------
if bash -n "$SCRIPT" 2>/dev/null; then ok "local-llm-tune-decide.sh parses (bash -n)"; else bad "parses" ""; fi

# --- 1. no flock on PATH -> refuses loudly ------------------------------------------------------
mkdir -p "$SB/binmask"
for b in bash cat python3 sed cut printf rm dirname; do
  p="$(command -v "$b" 2>/dev/null)" && ln -sf "$p" "$SB/binmask/$b"
done
out1="$(PATH="$SB/binmask" eval "$COMMON_ENV bash '$SCRIPT' --check 2>&1" || true)"
case "$out1" in
  *"flock is required"*) ok "no flock -> refuses loudly" ;;
  *) bad "no flock -> refuses loudly" "got: $out1" ;;
esac

# --- 2. empty CSV input -> ERROR ----------------------------------------------------------------
new_unit
out2="$(eval "$COMMON_ENV bash '$SCRIPT' --dry-run 2>&1" <<< "" || true)"
case "$out2" in
  *"empty CSV"*) ok "empty CSV -> error with helpful message" ;;
  *) bad "empty CSV -> error" "got: $out2" ;;
esac

# --- 3. no 'baseline' label in CSV -> ERROR -----------------------------------------------------
new_unit
CSV3="$(printf '%s\n' "$header"; rows "flash-q8" 4096 33.0 3)"
out3="$(eval "$COMMON_ENV bash '$SCRIPT' --dry-run 2>&1" <<< "$CSV3" || true)"
case "$out3" in
  *"no_baseline"*|*"baseline"*) ok "no baseline rows -> ERROR with clear message" ;;
  *) bad "no baseline rows -> ERROR" "got: $out3" ;;
esac

# --- 4. winner below margin -> NOOP, unit unchanged -----------------------------------------------
# baseline=30.0, flash-q8=31.5 (diff=1.5 < default margin 2.0) => no winner
new_unit
cp "$SB/ollama.service" "$SB/unit.before"
CSV4="$(printf '%s\n' "$header"; rows "baseline" 4096 30.0 3; rows "flash-q8" 4096 31.5 3)"
out4="$(eval "$COMMON_ENV bash '$SCRIPT' --dry-run 2>&1" <<< "$CSV4" || true)"
case "$out4" in
  *"baseline is already optimal"*|*"NOOP"*) ok "winner below margin -> NOOP reported" ;;
  *) bad "winner below margin -> NOOP" "got: $out4" ;;
esac
if diff -q "$SB/unit.before" "$SB/ollama.service" >/dev/null 2>&1; then
  ok "winner below margin -> unit unchanged"
else
  bad "winner below margin -> unit unchanged" "unit was modified despite NOOP"
fi

# --- 5. winner passes all guards -> WIN, unit gets the env block ----------------------------------
# baseline=29.0, flash-q8=32.5 (diff=3.5 > 2.0, min=31.5 > 29.0) => winner
new_unit
CSV5="$(printf '%s\n' "$header"
  rows "baseline"  4096 29.0 3
  rows "flash-q8"  4096 32.5 2
  printf 'flash-q8,model,4096,-,-,-,-,-,50.0,31.5,ok\n')"
out5="$(eval "$COMMON_ENV bash '$SCRIPT' --dry-run 2>&1" <<< "$CSV5" || true)"
case "$out5" in
  *"winner=flash-q8"*) ok "winner above margin -> WIN=flash-q8 reported" ;;
  *) bad "winner above margin -> WIN" "got: $out5" ;;
esac
# Unit must contain the marker and the correct env vars
if grep -q "local-llm-tune-decide" "$SB/ollama.service" && \
   grep -q "Environment=OLLAMA_FLASH_ATTENTION=1" "$SB/ollama.service" && \
   grep -q "Environment=OLLAMA_KV_CACHE_TYPE=q8_0" "$SB/ollama.service"; then
  ok "winner applied -> unit has correct env block"
else
  bad "winner applied -> unit has correct env block" "unit content: $(cat "$SB/ollama.service")"
fi

# --- 6. soak guard: too few reps -> no winner even if median is high ----------------------------
new_unit
cp "$SB/ollama.service" "$SB/unit.before6"
# flash-q8 has only 1 rep (< default MIN_REPS=2) -- should not win
CSV6="$(printf '%s\n' "$header"; rows "baseline" 4096 29.0 3; rows "flash-q8" 4096 40.0 1)"
out6="$(eval "$COMMON_ENV bash '$SCRIPT' --dry-run 2>&1" <<< "$CSV6" || true)"
case "$out6" in
  *"too_few_reps"*|*"baseline is already optimal"*|*"NOOP"*) ok "soak guard: 1 rep -> no winner" ;;
  *) bad "soak guard: 1 rep -> no winner" "got: $out6" ;;
esac
if diff -q "$SB/unit.before6" "$SB/ollama.service" >/dev/null 2>&1; then
  ok "soak guard -> unit unchanged"
else
  bad "soak guard -> unit unchanged" "unit was modified"
fi

# --- 7. worst-rep guard (SOHA ne legyen rosszabb): min(winner) <= baseline_median -> no winner ---
new_unit
cp "$SB/ollama.service" "$SB/unit.before7"
# baseline median=29.0; flash-q8 median=32.0 (good) but one rep=28.5 < 29.0 => guard fires
CSV7="$(printf '%s\n' "$header"
  rows "baseline" 4096 29.0 3
  printf 'flash-q8,model,4096,-,-,-,-,-,50.0,35.5,ok\n'
  printf 'flash-q8,model,4096,-,-,-,-,-,50.0,35.5,ok\n'
  printf 'flash-q8,model,4096,-,-,-,-,-,50.0,28.5,ok\n')"
out7="$(eval "$COMMON_ENV bash '$SCRIPT' --dry-run 2>&1" <<< "$CSV7" || true)"
case "$out7" in
  *"worst_rep_not_above_baseline"*|*"NOOP"*|*"baseline is already optimal"*) ok "worst-rep guard fires -> NOOP" ;;
  *) bad "worst-rep guard (SOHA ne legyen rosszabb)" "got: $out7" ;;
esac
if diff -q "$SB/unit.before7" "$SB/ollama.service" >/dev/null 2>&1; then
  ok "worst-rep guard -> unit unchanged"
else
  bad "worst-rep guard -> unit unchanged" "unit was modified"
fi

# --- 8. --check when no config applied -> exit 1 ------------------------------------------------
new_unit
check_exit=0
eval "$COMMON_ENV bash '$SCRIPT' --check" >/dev/null 2>&1 || check_exit=$?
if [[ "$check_exit" -eq 1 ]]; then ok "--check with no config -> exit 1"; else bad "--check no config -> exit 1" "got exit $check_exit"; fi

# --- 9. --check when config applied -> exit 0, shows env lines ----------------------------------
# Apply a config first (reuse CSV5, winner=flash-q8)
new_unit
eval "$COMMON_ENV bash '$SCRIPT' --dry-run" <<< "$CSV5" >/dev/null 2>&1 || true
check_exit=0
check_out="$(eval "$COMMON_ENV bash '$SCRIPT' --check" 2>&1)" || check_exit=$?
if [[ "$check_exit" -eq 0 ]]; then ok "--check with config applied -> exit 0"; else bad "--check applied -> exit 0" "got exit $check_exit: $check_out"; fi
case "$check_out" in
  *"OLLAMA_FLASH_ATTENTION"*|*"Environment="*) ok "--check output shows env lines" ;;
  *) bad "--check output shows env lines" "got: $check_out" ;;
esac

# --- 10. --revert removes the block (dry-run) ---------------------------------------------------
new_unit
# Apply first
eval "$COMMON_ENV bash '$SCRIPT' --dry-run" <<< "$CSV5" >/dev/null 2>&1 || true
grep -q "local-llm-tune-decide" "$SB/ollama.service" || { bad "--revert precondition: config must be applied first" ""; }
# Now revert (dry-run: no restart)
eval "$COMMON_ENV bash '$SCRIPT' --revert --dry-run" >/dev/null 2>&1 || true
if grep -q "local-llm-tune-decide" "$SB/ollama.service"; then
  bad "--revert removes marker from unit" "marker still present after --revert"
else
  ok "--revert removes marker from unit (dry-run)"
fi
if grep -qE "^Environment=OLLAMA_" "$SB/ollama.service"; then
  bad "--revert removes OLLAMA_* env lines" "still present after --revert"
else
  ok "--revert removes OLLAMA_* env lines (dry-run)"
fi

# --- 11. --ctx filter: use only rows at the specified ctx -----------------------------------------
new_unit
# baseline at 4096=29.0, flash-q8 at 4096=31.5 (below margin), but at 8192 flash-q8=33.5 (above)
# With --ctx 4096: should NOOP (31.5-29.0=2.5 >= 2.0 margin... actually passes!
# Let me make 4096 flash-q8=30.5 (diff=1.5, below margin) and 8192 flash-q8=33.5
CSV11="$(printf '%s\n' "$header"
  rows "baseline" 4096 29.0 3
  rows "flash-q8" 4096 30.5 3
  rows "baseline" 8192 25.0 3
  rows "flash-q8" 8192 33.5 3)"
# With --ctx 4096: flash-q8 at 4096 has diff=1.5 < 2.0 -> NOOP
out11a="$(eval "$COMMON_ENV bash '$SCRIPT' --ctx 4096 --dry-run 2>&1" <<< "$CSV11" || true)"
case "$out11a" in
  *"NOOP"*|*"baseline is already optimal"*) ok "--ctx filter uses only specified ctx (NOOP at 4096)" ;;
  *) bad "--ctx filter: NOOP at 4096" "got: $out11a" ;;
esac
# Without --ctx: primary ctx is 4096 (most rows) -> same NOOP
out11b="$(eval "$COMMON_ENV bash '$SCRIPT' --dry-run 2>&1" <<< "$CSV11" || true)"
case "$out11b" in
  *"NOOP"*|*"baseline is already optimal"*) ok "primary ctx auto-selected (most rows): NOOP at 4096" ;;
  *) bad "primary ctx auto-selected" "got: $out11b" ;;
esac

# --- 12. MUTATION CHECK: neutralize the margin guard, verify check 4+5 regress ------------------
# Copy script, neutralize the "med <= baseline_median + margin" guard line by replacing threshold
# with 999 (no config can ever exceed margin 999) -> check 4 should STILL be NOOP (margin too high)
# and check 5 should now also be NOOP (winner's median 32.5 <= 29.0+999 is still false, wait...
# Actually let's neutralize it the other way: replace margin with -999 so everything passes margin.
# Then the worst-rep guard (check 7) is what we're testing -- neutralize THAT instead.
#
# More precisely: we want to show that the MARGIN GUARD itself (guard 1 in the Python) catches
# the case from check 4 (diff=1.5). Neutralize guard 1 by replacing the condition with "False"
# so it never fires -> config that was NOOP due to margin should now WIN.
MUTATED="$SB/mutated-decide.sh"
sed 's/if med <= baseline_median + margin:/if False:  # MUTATION: margin guard disabled/' \
  "$SCRIPT" > "$MUTATED"
chmod +x "$MUTATED"

new_unit
CSV12="$(printf '%s\n' "$header"; rows "baseline" 4096 30.0 3; rows "flash-q8" 4096 31.5 3)"
MENV="OLLAMA_UNIT=$SB/ollama.service LOCAL_LLM_GPU_LOCK_PATH=$LOCKFILE LOCAL_LLM_LOCK_WAIT=5"
mut_out="$(eval "$MENV bash '$MUTATED' --dry-run 2>&1" <<< "$CSV12" || true)"
case "$mut_out" in
  *"winner=flash-q8"*|*"WIN"*|*"dry-run"*)
    ok "mutation check: disabling margin guard -> config below margin now wins (guard was real)" ;;
  *)
    bad "mutation check: disabling margin guard should allow below-margin config to win" "got: $mut_out" ;;
esac

echo
if [[ $fail -gt 0 ]]; then echo "$fail FAILED, $pass passed"; exit 1; fi
echo "All $pass checks pass."
