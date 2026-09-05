#!/usr/bin/env bash
# Self-test for store/vitest-flake-classify.sh (card c6153a69).
#
# Run: bash store/vitest-flake-classify.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
#
# THE PROPERTY UNDER TEST is a DISCRIMINATION, so every case comes in pairs: the classifier must say
# "known flake" for the flake and stay quiet for everything else. A classifier that always said
# "flake" would be worse than none -- it would explain away a real regression in the exact words a
# reader has been trained to trust.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/vitest-flake-classify.sh"
pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FLAKE_LINE='Error: [vitest-worker]: Timeout calling "onTaskUpdate"'

log() { printf '%s\n' "$@" > "$TMP/log"; echo "$TMP/log"; }

# --- 1. the real thing: nonzero exit, the RPC timeout, and NO failed tests ----------------------
l="$(log 'some output' "$FLAKE_LINE" ' Test Files  878 passed | 2 skipped (880)' '      Tests  18647 passed | 7 skipped (18654)')"
out="$(bash "$RUN" 1 "$l" 2>&1)"; rc=$?
if [[ $rc -eq 0 ]] && echo "$out" | grep -q 'KNOWN BENIGN FLAKE'; then
  ok "the flake signature is recognised (exit 0 + explanation)"
else
  bad "flake not recognised (rc=$rc)" "$out"
fi
echo "$out" | grep -q 'DO NOT read this as a pass' \
  && ok "the explanation says the exit code is not the verdict" \
  || bad "the explanation omits the do-not-trust-exit-code warning" "$out"

# --- 2. THE CASE THAT MATTERS MOST: the flake line AND real failures ----------------------------
# Both appear together whenever a loaded box also has a genuine regression. Calling that benign is
# the one outcome that would make this script harmful rather than merely useless.
l="$(log "$FLAKE_LINE" ' Test Files  3 failed | 875 passed (878)' '      Tests  9 failed | 18000 passed (18009)')"
bash "$RUN" 1 "$l" >/dev/null 2>&1; rc=$?
[[ $rc -eq 1 ]] && ok "a run with REAL failures is NOT excused, even with the flake line present" \
                || bad "real failures were classified as the benign flake (rc=$rc)"

# --- 3. a nonzero exit with no flake line is not this flake -------------------------------------
l="$(log 'ReferenceError: x is not defined' ' Test Files  1 failed (878)')"
bash "$RUN" 1 "$l" >/dev/null 2>&1; rc=$?
[[ $rc -eq 1 ]] && ok "an unrelated failure is left alone" || bad "unrelated failure misclassified (rc=$rc)"

# --- 4. a CLEAN run is never a flake, whatever the log contains ---------------------------------
# Guards the ordering: the status check must come before the log match, or a log that merely QUOTES
# the error text (a REVIEW pasted into CI output, this very selftest's fixtures) would be "explained".
l="$(log "$FLAKE_LINE" '      Tests  18647 passed')"
bash "$RUN" 0 "$l" >/dev/null 2>&1; rc=$?
[[ $rc -eq 1 ]] && ok "exit 0 is never reclassified, even when the log mentions the timeout" \
                || bad "a clean run was called a flake (rc=$rc)"

# --- 5. usage and a missing log --------------------------------------------------------------
bash "$RUN" >/dev/null 2>&1; rc=$?
[[ $rc -eq 2 ]] && ok "no arguments -> exit 2 (usage)" || bad "no-args exit $rc, want 2"
bash "$RUN" 1 "$TMP/definitely-not-here" >/dev/null 2>&1; rc=$?
[[ $rc -eq 1 ]] && ok "a missing log is not a flake verdict" || bad "missing log exit $rc, want 1"

echo
echo "vitest-flake-classify.selftest: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
