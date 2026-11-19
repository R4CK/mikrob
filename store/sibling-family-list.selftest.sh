#!/usr/bin/env bash
# sibling-family-list.selftest.sh -- unit tests for sibling-family-list.sh (card ce452df8,
# WhiteHat2 N1, comment 17982 on card 31e70128).
#
# N1: two mutants survived BOTH consuming selftests (sibling-skill-drift-check.sh --selftest and
# agent-skill-drift-sync.sh selftest) because their fixtures only exercise backend/backend2 --
# nothing asserted that the KEYS array and the case branches agree on the FULL known family set.
#   MA: dropping "cybersec" from SIBLING_FAMILY_KEYS -- the array is a separate hand-written list
#       from the case statement, so this slips past any test that only iterates the array itself.
#   MB: dropping the "cybersec|cybersec2)" branch from sibling_family_members -- same silent skip
#       as the original bug this whole file was built to fix (31e70128).
# This file pins the full expected family set with FIXED values (not derived from KEYS or from the
# case statement), so either mutation goes red here regardless of which side it touches.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./sibling-family-list.sh
source "$HERE/sibling-family-list.sh"

PASS=0
FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    echo "FAIL: $desc"
    echo "  want: $want"
    echo "  got:  $got"
  fi
}

# MA: every known family name must be present in SIBLING_FAMILY_KEYS, checked by explicit
# membership against a fixed list -- not by iterating the array (that would vacuously pass
# if a name were dropped from it).
for family in backend qa fron-ted cybersec; do
  found=no
  for k in "${SIBLING_FAMILY_KEYS[@]}"; do
    [[ "$k" == "$family" ]] && { found=yes; break; }
  done
  check "SIBLING_FAMILY_KEYS contains '$family' (MA pin)" "$found" "yes"
done

# MB: every known family's membership function call returns its full, fixed sibling set.
check "sibling_family_members backend" "$(sibling_family_members backend)" "backend backend2 backend3"
check "sibling_family_members backend2" "$(sibling_family_members backend2)" "backend backend2 backend3"
check "sibling_family_members backend3" "$(sibling_family_members backend3)" "backend backend2 backend3"
check "sibling_family_members qa" "$(sibling_family_members qa)" "qa qa2"
check "sibling_family_members qa2" "$(sibling_family_members qa2)" "qa qa2"
check "sibling_family_members fron-ted" "$(sibling_family_members fron-ted)" "fron-ted fron-teddy"
check "sibling_family_members fron-teddy" "$(sibling_family_members fron-teddy)" "fron-ted fron-teddy"
check "sibling_family_members cybersec (MB pin)" "$(sibling_family_members cybersec)" "cybersec cybersec2"
check "sibling_family_members cybersec2 (MB pin)" "$(sibling_family_members cybersec2)" "cybersec cybersec2"

# non-family agents (cybered has no sibling despite the digit-free "red" stem, per the file's
# own comment) and unknown agents both return empty.
check "sibling_family_members cybered (no sibling, by design)" "$(sibling_family_members cybered)" ""
check "sibling_family_members unknown-agent" "$(sibling_family_members unknown-agent)" ""

echo
echo "sibling-family-list.selftest: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
