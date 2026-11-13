#!/usr/bin/env bash
# fleet-test-priority-lane.selftest.sh -- dedicated test for fleet-test.sh's priority ticket queue
# (card b7d8ecc4: a land run holds marveen-land.sh's develop-push lock for its whole wait on the
# fleet-test tree mutex below, so it must jump ahead of non-land waiters already queued, never
# behind more than the one run already holding the lock when it arrives).
#
# WHY A SOURCED EXTRACTION, NOT A REIMPLEMENTATION. Same reasoning as
# fleet-test-incomplete-run.selftest.sh: pulls the ACTUAL fleet_test_take_ticket /
# fleet_test_reap_stale_tickets / fleet_test_is_head functions out of fleet-test.sh with sed, so a
# future edit to the real functions is what this test exercises, not a hand-written copy.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/fleet-test.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

extract_functions() {
  # $1 = output path. Pulls all four functions, in source order, verbatim -- including the
  # FLEET_TEST_PRIORITY -> PRIORITY_RANK mapping itself, not just the ticket mechanics, so a
  # mutation of THAT mapping (e.g. "land" silently resolving to rank 1, same as everyone else)
  # is caught too, not just a mutation of the ticket-ordering code.
  sed -n '/^fleet_test_resolve_priority_rank() {/,/^}/p;/^fleet_test_take_ticket() {/,/^}/p;/^fleet_test_reap_stale_tickets() {/,/^}/p;/^fleet_test_is_head() {/,/^}/p' "$SRC" > "$1"
}

FUNCS="$TMP/funcs.sh"
extract_functions "$FUNCS"
for fn in fleet_test_resolve_priority_rank fleet_test_take_ticket fleet_test_reap_stale_tickets fleet_test_is_head; do
  grep -q "^$fn() {" "$FUNCS" || { echo "FAIL: could not extract $fn from $SRC -- source and selftest have drifted"; exit 1; }
done
# shellcheck disable=SC1090
. "$FUNCS"

pass=0
fail=0
check() { # $1=description $2=expected $3=actual
  if [ "$2" = "$3" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $1 (want: $2, got: $3)"
  fi
}

# --- Test A: ticket ordering -- a land ticket sorts before normal tickets regardless of arrival
# order, and FIFO holds within the same priority tier.
a_base="$TMP/a-test.lock"
LOCK_FILE="$a_base"
PRIORITY_RANK="$(fleet_test_resolve_priority_rank normal)"
normal1="$(fleet_test_take_ticket)"
PRIORITY_RANK="$(fleet_test_resolve_priority_rank normal)"
normal2="$(fleet_test_take_ticket)"
PRIORITY_RANK="$(fleet_test_resolve_priority_rank land)"
land1="$(fleet_test_take_ticket)"

check "land ticket (arrived 3rd) is head, not the two earlier normal tickets" "yes" "$(fleet_test_is_head "$land1" && echo yes || echo no)"
check "first normal ticket is NOT head while a land ticket is queued" "no" "$(fleet_test_is_head "$normal1" && echo yes || echo no)"
check "second normal ticket is NOT head either" "no" "$(fleet_test_is_head "$normal2" && echo yes || echo no)"

# Remove the land ticket (as the real wait-loop does once served) -- FIFO among the remaining
# normal tickets should now put the earlier arrival first.
rm -f "$land1"
check "after the land ticket is served, the FIRST normal ticket becomes head (FIFO preserved)" "yes" "$(fleet_test_is_head "$normal1" && echo yes || echo no)"
rm -f "$normal1" "$normal2"

# --- Test B (behavioral, Kész-ha #3): with a real flock held by a simulated already-running
# holder, a land waiter that arrives AFTER two normal waiters are already queued still acquires the
# lock before them -- it only ever waits behind the one run already holding it, never behind
# waiters that were merely queued.
b_base="$TMP/b-test.lock"
exec 9>"$b_base"
flock 9 # simulate a non-land run already holding the tree mutex when everyone else arrives

order_file="$TMP/order.txt"
: >"$order_file"

wait_and_record() { # $1=label $2=FLEET_TEST_PRIORITY value
  (
    LOCK_FILE="$b_base"
    PRIORITY_RANK="$(fleet_test_resolve_priority_rank "$2")"
    exec {fd}>"$b_base"
    ticket="$(fleet_test_take_ticket)"
    while ! { fleet_test_is_head "$ticket" && flock -n "$fd"; }; do sleep 0.1; done
    rm -f "$ticket"
    echo "$1" >> "$order_file"
    flock -u "$fd"
  ) &
}

wait_and_record "normal-A" normal
sleep 0.3
wait_and_record "normal-B" normal
sleep 0.3
wait_and_record "land-C" land
sleep 0.3
# Release the simulated holder now that all three are queued (land-C arrived last).
flock -u 9
wait

result="$(tr '\n' ' ' < "$order_file")"
check "land waiter served before either normal waiter despite arriving last" "land-C normal-A normal-B " "$result"

echo
echo "fleet-test-priority-lane.selftest: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
