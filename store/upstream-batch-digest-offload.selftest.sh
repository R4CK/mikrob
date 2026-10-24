#!/usr/bin/env bash
# upstream-batch-digest-offload.selftest.sh -- coverage for upstream-batch-digest-offload.sh
# (card efe4aa40). Stubs local-llm.sh and gemini-offload-call.sh via env override so no real
# Ollama/Gemini call happens; the real gemini-heavy-gate.sh functions ARE exercised (against a
# scratch flag file + scratch lock/log), proving the gate is genuinely wired, not stubbed away.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/upstream-batch-digest-offload.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
FAILED=()
check() {
  local name="$1" expect_rc="$2" expect_out="$3" actual_rc="$4" actual_out="$5"
  if [[ "$actual_rc" == "$expect_rc" && "$actual_out" == "$expect_out" ]]; then
    PASS=$((PASS+1)); echo "OK   $name"
  else
    FAIL=$((FAIL+1)); FAILED+=("$name")
    echo "FAIL $name  rc=$actual_rc (expected $expect_rc)  out='$actual_out' (expected '$expect_out')"
  fi
}

# stub local-llm.sh: echoes "LOCAL-OK: <stdin>" and exits 0 when $LOCAL_OK=1, else exits 5.
STUB_LOCAL="$TMP/local-llm.sh"
cat > "$STUB_LOCAL" <<'EOF'
#!/usr/bin/env bash
in="$(cat)"
if [[ "${LOCAL_OK:-0}" == "1" ]]; then
  echo "LOCAL-OK: $in"
  exit 0
fi
exit 5
EOF
chmod +x "$STUB_LOCAL"

# stub gemini-offload-call.sh: echoes "GEMINI-OK: <stdin>" and exits 0 when $GEMINI_OK=1.
STUB_GEMINI="$TMP/gemini-offload-call.sh"
cat > "$STUB_GEMINI" <<'EOF'
#!/usr/bin/env bash
in="$(cat)"
if [[ "${GEMINI_OK:-0}" == "1" ]]; then
  echo "GEMINI-OK: $in"
  exit 0
fi
exit 1
EOF
chmod +x "$STUB_GEMINI"

GEMINI_HEAVY_FLAG="$TMP/heavy-enabled"
HEAVY_HOURLY_LOCK="$TMP/heavy.lock"

# reserve_heavy_gemini_slot() calls into scripts/seged-hivo.py, whose own LOG/STORE/ROOT constants
# are derived from __file__ -- pointing SEGED_HIVO_HELPERS at the REAL repo copy would read/write
# the REAL, fleet-shared Gemini call log (budget pollution + flakiness on real fleet activity,
# measured: "hourly budget capped" in the aggregate selftest run). Same isolation pattern as
# offload-dispatch.selftest.sh's own HEAVY_TD: copy the script into a scratch tree so its __file__-
# derived paths resolve under the scratch tree instead.
HEAVY_TD="$TMP/heavy-td"
mkdir -p "$HEAVY_TD/scripts" "$HEAVY_TD/store"
cp "$HERE/../scripts/seged-hivo.py" "$HEAVY_TD/scripts/seged-hivo.py"
: > "$HEAVY_TD/store/seged-hivo-naplo.jsonl"
SEGED_HIVO_HELPERS="$HEAVY_TD/scripts/seged-hivo.py"

run() {
  LOCAL_OK="${1:-0}" GEMINI_OK="${2:-0}" GEMINI_HEAVY_FLAG="$GEMINI_HEAVY_FLAG" \
    GEMINI_AGY_HOURLY_LOCK="$HEAVY_HOURLY_LOCK" SEGED_HIVO_HELPERS="$SEGED_HIVO_HELPERS" \
    UBD_SELFTEST_MODE=1 UBD_LOCAL_LLM="$STUB_LOCAL" UBD_GEMINI_OFFLOAD="$STUB_GEMINI" \
    bash "$SCRIPT" --caller test "${@:3}"
}

COMMIT_INPUT=$'abc1234 Fix the thing\n src/web/local-llm.ts | 12 +++++++------\n'

echo "=== A. local attempt succeeds -> no Gemini call needed ==="
out="$(run 1 0 <<<"$COMMIT_INPUT")"; rc=$?
check "A: local success" 0 "LOCAL-OK: abc1234 Fix the thing" "$rc" "$out"

echo "=== B. local fails, --confirm-gemini-ok missing -> exit 2, no Gemini call ==="
out="$(run 0 1 <<<"$COMMIT_INPUT")"; rc=$?
check "B: no confirm flag -> exit 2" 2 "" "$rc" "$out"

echo "=== C. local fails, confirm given, heavy flag OFF -> exit 2, no Gemini call ==="
out="$(run 0 1 --confirm-gemini-ok <<<"$COMMIT_INPUT")"; rc=$?
check "C: heavy flag off -> exit 2" 2 "" "$rc" "$out"

echo "=== D. local fails, confirm given, heavy flag ON, Gemini succeeds -> gets the digest INSTRUCTION + filtered text, no stat lines (RedHat K2, komment 23553) ==="
touch "$GEMINI_HEAVY_FLAG"
out="$(run 0 1 --confirm-gemini-ok <<<"$COMMIT_INPUT")"; rc=$?
if [[ "$rc" -eq 0 && "$out" == *"abc1234 Fix the thing"* && "$out" == *"output ONLY a terse digest"* \
      && "$out" == *"FLAGS"* && "$out" != *"local-llm.ts"* ]]; then
  PASS=$((PASS+1)); echo "OK   D: Gemini fallback carries the digest instruction + filtered text, no stat lines"
else
  FAIL=$((FAIL+1)); FAILED+=("D: gemini fallback"); echo "FAIL rc=$rc out='$out'"
fi
rm -f "$GEMINI_HEAVY_FLAG"

echo "=== E. nothing-but-unsafe input (no commit line) -> exit 1 before any local/Gemini attempt ==="
UNSAFE_ONLY=$' src/web/local-llm.ts | 12 +++++++------\n'
out="$(run 1 1 --confirm-gemini-ok <<<"$UNSAFE_ONLY" 2>/dev/null)"; rc=$?
check "E: filter rejects -> exit 1" 1 "" "$rc" "$out"

echo "=== F. local fails, --confirm-gemini-ok MISSING but heavy flag ON -> still exit 2, no Gemini call (RedHat O3, komment 23553) ==="
# Case B already covers confirm-missing+flag-off, where removing the confirm check still exits 2
# via the flag-off gate (same observable rc/stdout) -- it does not actually pin the confirm check.
# With the flag ON, a removed confirm check would fall through to a real (stubbed) Gemini call and
# return rc=0 with output, diverging from this expectation.
touch "$GEMINI_HEAVY_FLAG"
out="$(run 0 1 <<<"$COMMIT_INPUT")"; rc=$?
check "F: confirm flag missing, heavy flag on -> exit 2" 2 "" "$rc" "$out"
rm -f "$GEMINI_HEAVY_FLAG"

echo "=== G. local fails, confirm given, heavy flag ON, hourly budget exhausted -> exit 2, no Gemini call (RedHat O5, komment 23553) ==="
touch "$GEMINI_HEAVY_FLAG"
out="$(GEMINI_AGY_HEAVY_HOURLY_LIMIT=0 run 0 1 --confirm-gemini-ok <<<"$COMMIT_INPUT")"; rc=$?
check "G: hourly budget capped -> exit 2" 2 "" "$rc" "$out"
rm -f "$GEMINI_HEAVY_FLAG"

# H/I use the REAL offload-dispatch.sh --check-blocked (card d886e9c2, MikroB 23556 point (a),
# RedHat GO 23683) -- NOT stubbed, because the whole point is proving the real content-gate
# vocabulary actually runs, not a stand-in that always agrees with the caller.
run_realgate() {
  LOCAL_OK="${1:-0}" GEMINI_OK="${2:-0}" GEMINI_HEAVY_FLAG="$GEMINI_HEAVY_FLAG" \
    GEMINI_AGY_HOURLY_LOCK="$HEAVY_HOURLY_LOCK" SEGED_HIVO_HELPERS="$SEGED_HIVO_HELPERS" \
    UBD_SELFTEST_MODE=1 UBD_LOCAL_LLM="$STUB_LOCAL" UBD_GEMINI_OFFLOAD="$STUB_GEMINI" \
    bash "$SCRIPT" --caller test "${@:3}"
}

echo "=== H. local fails, confirm given, heavy flag ON, budget available, Gemini WOULD succeed, but the commit subject is sensitive -> the content gate blocks, exit 2, no Gemini call (card d886e9c2) ==="
touch "$GEMINI_HEAVY_FLAG"
SENSITIVE_INPUT=$'abc1234 fix auth bypass in login\n'
out="$(run_realgate 0 1 --confirm-gemini-ok <<<"$SENSITIVE_INPUT")"; rc=$?
check "H: sensitive content -> content gate blocks -> exit 2" 2 "" "$rc" "$out"
rm -f "$GEMINI_HEAVY_FLAG"

echo "=== I. the --confirm-gemini-ok switch ALONE is not sufficient: everything else (heavy flag, budget, Gemini) is wide open, yet a sensitive commit is still blocked (same case as H, restated as the acceptance criterion) ==="
touch "$GEMINI_HEAVY_FLAG"
out="$(run_realgate 0 1 --confirm-gemini-ok <<<"$SENSITIVE_INPUT")"; rc=$?
if [[ "$rc" == 2 && "$out" == "" ]]; then
  PASS=$((PASS+1)); echo "OK   I: confirm switch alone does not open the Gemini path"
else
  FAIL=$((FAIL+1)); FAILED+=("I: confirm switch alone"); echo "FAIL rc=$rc out='$out'"
fi
rm -f "$GEMINI_HEAVY_FLAG"

# J/K regress the WhiteHat MEDIUM (card 7b5cf804, d886e9c2 GO @ a7742f46): an env-seam that let
# the caller force the content gate's own rc without going through its real logic at all.

echo "=== J. BASH_ENV/ENV poisoned MID-SCRIPT (e.g. by something the script sources, not by the caller of the top-level script -- BASH_ENV sourcing happens at bash startup, so poisoning it before the top invocation would hijack the whole script before any of its own code runs, which is a noisy crash, not the sneaky selective bypass this finding is about) must NOT let the gate subprocess get forced to exit 42 ==="
BASH_ENV_EXIT42="$TMP/bash-env-exit42.sh"
cat > "$BASH_ENV_EXIT42" <<'EOF'
exit 42
EOF
# Simulate the real attack surface directly: the exact OFFLOAD_DISPATCH invocation line from the
# production script, run with BASH_ENV/ENV already exported in the CURRENT (already-running)
# shell -- this is what the content-gate subprocess call actually sees if something sourced into
# this script's own process (e.g. gemini-heavy-gate.sh) exported BASH_ENV earlier in the run.
run_gate_line() {
  local use_envu="$1"
  local real_dispatch="$HERE/offload-dispatch.sh"
  if [[ "$use_envu" == "1" ]]; then
    env -u BASH_ENV -u ENV bash "$real_dispatch" --check-blocked mikrob "gemini-ok" "" "$SENSITIVE_INPUT" >/dev/null 2>&1
  else
    bash "$real_dispatch" --check-blocked mikrob "gemini-ok" "" "$SENSITIVE_INPUT" >/dev/null 2>&1
  fi
}
( export BASH_ENV="$BASH_ENV_EXIT42" ENV="$BASH_ENV_EXIT42"
  run_gate_line 0; echo "unprotected_rc=$?" > "$TMP/j-unprotected.rc"
  run_gate_line 1; echo "protected_rc=$?" > "$TMP/j-protected.rc"
)
unprotected_rc="$(grep -o '[0-9]*' "$TMP/j-unprotected.rc")"
protected_rc="$(grep -o '[0-9]*' "$TMP/j-protected.rc")"
if [[ "$unprotected_rc" == "42" && "$protected_rc" != "42" ]]; then
  PASS=$((PASS+1)); echo "OK   J: env -u BASH_ENV -u ENV prevents mid-script BASH_ENV poisoning from forcing the gate's exit code to 42 (unprotected got 42, protected got $protected_rc)"
else
  FAIL=$((FAIL+1)); FAILED+=("J: BASH_ENV mid-script poisoning"); echo "FAIL expected unprotected=42 (poisoned) and protected!=42 (immune), got unprotected=$unprotected_rc protected=$protected_rc"
fi

echo "=== K. UBD_OFFLOAD_DISPATCH env var pointed at an always-exit-42 stub has NO effect -- the seam was removed, the real offload-dispatch.sh is always used ==="
STUB_ALWAYS_ALLOW="$TMP/always-exit42.sh"
cat > "$STUB_ALWAYS_ALLOW" <<'EOF'
#!/usr/bin/env bash
exit 42
EOF
chmod +x "$STUB_ALWAYS_ALLOW"
touch "$GEMINI_HEAVY_FLAG"
out="$(UBD_OFFLOAD_DISPATCH="$STUB_ALWAYS_ALLOW" run_realgate 0 1 --confirm-gemini-ok <<<"$SENSITIVE_INPUT")"; rc=$?
check "K: UBD_OFFLOAD_DISPATCH override is inert, sensitive content still blocked" 2 "" "$rc" "$out"
rm -f "$GEMINI_HEAVY_FLAG"

# L/M/N regress WhiteHat NO-GO F1/F2 (card 7b5cf804, komment 23922, Gate-SHA
# bffa6341ef399a75c696a4aa902cddb670d445c6): the J/env -u wrapper above does not help if `env`/
# `bash` themselves are shadowed by an exported function or a PATH-prepended fake binary, and the
# FILTER/LOCAL_LLM/GEMINI_OFFLOAD seams were overridable from ANY caller, not just the selftest.

echo "=== L. a bash function named 'env', exported by the CALLER, must not let a sensitive commit through (old code: rc=0, Gemini-stub received the subject) ==="
touch "$GEMINI_HEAVY_FLAG"
out_l="$( (
  env() { return 42; }
  export -f env
  run_realgate 0 1 --confirm-gemini-ok <<<"$SENSITIVE_INPUT"
) )"; rc_l=$?
check "L: exported env function -> content gate still blocks" 2 "" "$rc_l" "$out_l"
rm -f "$GEMINI_HEAVY_FLAG"

echo "=== M. a PATH-prepended fake 'env' binary must not let a sensitive commit through (old code: rc=0) ==="
FAKE_BIN="$TMP/fakebin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/env" <<'EOF'
#!/usr/bin/env bash
exit 42
EOF
chmod +x "$FAKE_BIN/env"
touch "$GEMINI_HEAVY_FLAG"
out_m="$(PATH="$FAKE_BIN:$PATH" run_realgate 0 1 --confirm-gemini-ok <<<"$SENSITIVE_INPUT")"; rc_m=$?
check "M: PATH-prepended fake env -> content gate still blocks" 2 "" "$rc_m" "$out_m"
rm -f "$GEMINI_HEAVY_FLAG"

echo "=== N. UBD_FILTER override has NO EFFECT without UBD_SELFTEST_MODE (production mode): a malicious passthrough filter cannot let a filter-rejected input through ==="
PASSTHROUGH_FILTER="$TMP/passthrough-filter.sh"
cat > "$PASSTHROUGH_FILTER" <<'EOF'
#!/usr/bin/env bash
cat
EOF
chmod +x "$PASSTHROUGH_FILTER"
# No UBD_SELFTEST_MODE set here -- on fixed code UBD_FILTER is ignored and the real filter.sh
# rejects UNSAFE_ONLY exactly as in case E, before any local/Gemini attempt (fast, no real call).
# Bounded with timeout: on the pre-fix mutation (UBD_FILTER honored unconditionally) the malicious
# filter would let UNSAFE_ONLY through unfiltered, and the script would proceed to call the REAL
# local-llm.sh (not stubbed, since UBD_LOCAL_LLM is not set here either) -- that hangs rather than
# failing fast, so the timeout turns an otherwise-indefinite mutation run into a bounded FAIL.
out_n="$(timeout 10 env UBD_FILTER="$PASSTHROUGH_FILTER" bash "$SCRIPT" --caller test --confirm-gemini-ok <<<"$UNSAFE_ONLY" 2>/dev/null)"; rc_n=$?
check "N: UBD_FILTER override inert without UBD_SELFTEST_MODE, unsafe input still rejected" 1 "" "$rc_n" "$out_n"

echo "-------------------------------------------------------------"
echo "passed: $PASS   failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "FAILED CASES:"
  for f in "${FAILED[@]}"; do echo "  - $f"; done
  exit 1
fi
echo "All cases passed."
