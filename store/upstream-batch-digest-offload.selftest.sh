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
    UBD_LOCAL_LLM="$STUB_LOCAL" UBD_GEMINI_OFFLOAD="$STUB_GEMINI" \
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

echo "-------------------------------------------------------------"
echo "passed: $PASS   failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "FAILED CASES:"
  for f in "${FAILED[@]}"; do echo "  - $f"; done
  exit 1
fi
echo "All cases passed."
