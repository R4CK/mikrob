#!/usr/bin/env bash
# fleet-test-incomplete-run.selftest.sh -- dedicated test for fleet-test.sh's exit-137/missing-summary
# detection (card 85823628's fix, extracted into is_incomplete_run() and given this test by card
# d54d5de6, QA2 comment 4309).
#
# WHY A SOURCED EXTRACTION, NOT A REIMPLEMENTATION. Pasting an equivalent regex here would test this
# file's own copy, not fleet-test.sh's shipped code -- the two can drift silently. Instead this pulls
# the ACTUAL is_incomplete_run() function body out of fleet-test.sh with sed and sources exactly
# that, so a future edit to the real function is what this test exercises.
#
# MUTATION CHECK (--mutate): before the real fix (card 85823628), a killed run with no summary line
# printed NOTHING and returned the raw vitest/pipe exit code -- silent, easy to misread as a normal
# nonzero exit. This flag temporarily reverts is_incomplete_run() to that always-false shape (never
# detects incomplete) and asserts the fixture below then FAILS, proving the fixture actually pins the
# behaviour rather than trivially passing regardless of the function's body.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/fleet-test.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

MUTATE=0
[ "${1:-}" = "--mutate" ] && MUTATE=1

extract_function() {
  # $1 = replacement body for the mutation check, or empty for the real shipped function
  local out="$TMP/extracted.sh"
  if [ -n "$1" ]; then
    printf 'is_incomplete_run() { %s\n}\n' "$1" > "$out"
  else
    sed -n '/^is_incomplete_run() {/,/^}/p' "$SRC" > "$out"
  fi
  echo "$out"
}

pass=0
fail=0
check() { # $1=description $2=expected(0|1) $3=actual
  if [ "$2" -eq "$3" ]; then
    echo "ok   $1"
    pass=$((pass + 1))
  else
    echo "FAIL $1 (expected rc=$2, got rc=$3)"
    fail=$((fail + 1))
  fi
}

FUNC_FILE="$(extract_function "")"
# shellcheck disable=SC1090
source "$FUNC_FILE"

# Fixture logs, matching the real shapes seen in the wild.
NO_SUMMARY="$TMP/no-summary.log"
printf 'fleet-test.sh: building dist\nRUN  v2.1.9\nKilled\n' > "$NO_SUMMARY"

NORMAL_PASS="$TMP/normal-pass.log"
printf 'RUN  v2.1.9\n Test Files  814 passed (814)\n      Tests  19524 passed | 101 skipped (19625)\n' > "$NORMAL_PASS"

NORMAL_FAIL="$TMP/normal-fail.log"
printf 'RUN  v2.1.9\n Test Files  1 failed | 813 passed (814)\n      Tests  3 failed | 19521 passed (19524)\n' > "$NORMAL_FAIL"

BIRPC_FLAKE="$TMP/birpc-flake.log"
printf 'RUN  v2.1.9\n Test Files  814 passed (814)\n      Tests  19524 passed (19524)\nUnhandled Error: [vitest-worker]: Timeout calling "onTaskUpdate"\n' > "$BIRPC_FLAKE"

if is_incomplete_run 137 "$NO_SUMMARY"; then r=0; else r=1; fi
check "killed run, no summary anywhere, nonzero exit -> incomplete" 0 "$r"

if is_incomplete_run 0 "$NO_SUMMARY"; then r=0; else r=1; fi
check "no summary but exit 0 (should not happen, but status guard must hold) -> NOT incomplete" 1 "$r"

if is_incomplete_run 0 "$NORMAL_PASS"; then r=0; else r=1; fi
check "clean pass, exit 0 -> NOT incomplete" 1 "$r"

if is_incomplete_run 1 "$NORMAL_FAIL"; then r=0; else r=1; fi
check "real test failures WITH a summary, exit 1 -> NOT incomplete (it is a real failure, not a kill)" 1 "$r"

if is_incomplete_run 1 "$BIRPC_FLAKE"; then r=0; else r=1; fi
check "birpc flake HAS a summary, exit 1 -> NOT incomplete (that is the other, benign branch)" 1 "$r"

if [ "$MUTATE" -eq 1 ]; then
  # Pre-85823628 shape: no detection at all, always reports complete.
  MUTATED_FILE="$(extract_function 'return 1')"
  unset -f is_incomplete_run
  # shellcheck disable=SC1090
  source "$MUTATED_FILE"
  if is_incomplete_run 137 "$NO_SUMMARY"; then r=0; else r=1; fi
  check "MUTATION (pre-fix always-false body) on the killed-run fixture -> must now FAIL to detect it" 1 "$r"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "selftest: $pass passed, 0 failed"
  exit 0
else
  echo "selftest: $pass passed, $fail failed"
  exit 1
fi
