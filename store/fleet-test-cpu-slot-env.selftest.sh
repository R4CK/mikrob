#!/usr/bin/env bash
# Self-test for fleet-test.sh's CPU_SLOTS env wiring (card 22835648 B2, MikroB msg 17042).
#
# WHY: the shared precedence logic (new name wins, old name falls back with a warning) is already
# exhaustively unit-tested in env-compat-lib.selftest.sh. mopsion-suite-run.selftest.sh already
# proves ITS caller wired it in for the SUITE_SLOTS family; this file is fleet-test.sh's own
# missing counterpart -- B2's exact finding: no test anywhere called fleet-test.sh with
# MIKROB_SUITE_SLOTS set and checked it actually took effect, so reverting that one read line back
# to the bare CLEANCORE_SUITE_SLOTS default left every existing suite (including this file's own
# sibling, fleet-test-incomplete-run.selftest.sh) green.
#
# Uses the --cpu-slots diagnostic flag (added alongside this file, same reasoning as the existing
# --cpu-slot-path flag a few lines above it in fleet-test.sh): prints the resolved CPU_SLOTS value
# and exits before any lock is taken or any test actually runs, so this is a fast, side-effect-free
# check of the env_compat_get call itself, not a full suite run.
#
# Run: bash store/fleet-test-cpu-slot-env.selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/fleet-test.sh"
pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n       %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

out="$(env -u MIKROB_SUITE_SLOTS -u CLEANCORE_SUITE_SLOTS "$RUN" --cpu-slots 2>/dev/null)"
[ "$out" = "2" ] && ok "neither var set -> the documented default (2)" \
  || bad "default" "got [$out]"

out="$(MIKROB_SUITE_SLOTS=7 env -u CLEANCORE_SUITE_SLOTS "$RUN" --cpu-slots 2>/dev/null)"
[ "$out" = "7" ] && ok "MIKROB_SUITE_SLOTS (new name) is actually read" \
  || bad "new name" "got [$out]"

out="$(env -u MIKROB_SUITE_SLOTS CLEANCORE_SUITE_SLOTS=9 "$RUN" --cpu-slots 2>/dev/null)"
[ "$out" = "9" ] && ok "the retired CLEANCORE_SUITE_SLOTS still works as a fallback" \
  || bad "old name fallback" "got [$out]"

warn="$(env -u MIKROB_SUITE_SLOTS CLEANCORE_SUITE_SLOTS=9 "$RUN" --cpu-slots 2>&1 >/dev/null)"
case "$warn" in
  *'CLEANCORE_SUITE_SLOTS is deprecated, use $MIKROB_SUITE_SLOTS'*) ok "the fallback warns which new name to use" ;;
  *) bad "fallback warning" "got [$warn]" ;;
esac

out="$(MIKROB_SUITE_SLOTS=3 CLEANCORE_SUITE_SLOTS=9 "$RUN" --cpu-slots 2>/dev/null)"
[ "$out" = "3" ] && ok "the new name wins over the old one when both are set" \
  || bad "precedence" "got [$out]"

# Card 22835648 round 4 (MikroB msg 17083/17102, Cybered NO-GO 28967): this file only covered
# CPU_SLOTS (MIKROB_SUITE_SLOTS); fleet-test.sh's OTHER env_compat_get read, CPU_LOCK_PREFIX
# (MIKROB_SUITE_LOCK_PREFIX/CLEANCORE_SUITE_LOCK_PREFIX, via --cpu-slot-path), had no pinning test
# at all.
out="$(MIKROB_SUITE_LOCK_PREFIX=/tmp/lp-x env -u CLEANCORE_SUITE_LOCK_PREFIX "$RUN" --cpu-slot-path 2>/dev/null)"
[ "$out" = "/tmp/lp-x" ] && ok "MIKROB_SUITE_LOCK_PREFIX (new name) is actually read" \
  || bad "lock-prefix new name" "got [$out]"

out="$(env -u MIKROB_SUITE_LOCK_PREFIX CLEANCORE_SUITE_LOCK_PREFIX=/tmp/lp-y "$RUN" --cpu-slot-path 2>/dev/null)"
[ "$out" = "/tmp/lp-y" ] && ok "the retired CLEANCORE_SUITE_LOCK_PREFIX still works as a fallback" \
  || bad "lock-prefix old name fallback" "got [$out]"

echo
echo "fleet-test-cpu-slot-env.selftest: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
