#!/usr/bin/env bash
# fleet-test-priority-lane.selftest.sh -- dedicated test for fleet-test.sh's priority ticket queue
# (card b7d8ecc4). Round 2, after Cybersec NO-GO 30007 on round 1: round 1 only ordered the TREE
# mutex, where CPU_SLOTS=2 almost never lets more than one other waiter accumulate -- this round
# ALSO exercises the SLOT-stage queue (where the real multi-way contention forms, N1), pid-recycle
# reaping (N2), no-barge (N3) and bounded aging against starvation (N4).
#
# WHY A SOURCED EXTRACTION, NOT A REIMPLEMENTATION. Same reasoning as
# fleet-test-incomplete-run.selftest.sh: pulls the ACTUAL functions out of fleet-test.sh with sed,
# so a future edit to the real functions is what this test exercises, not a hand-written copy.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/fleet-test.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FUNCS_LIST="fleet_test_resolve_priority_rank fleet_test_pid_starttime fleet_test_take_ticket fleet_test_reap_stale_tickets fleet_test_is_head"

extract_functions() {
  # $1 = output path. Pulls every function above, in source order, verbatim.
  sed -n '/^fleet_test_resolve_priority_rank() {/,/^}/p;/^fleet_test_pid_starttime() {/,/^}/p;/^fleet_test_take_ticket() {/,/^}/p;/^fleet_test_reap_stale_tickets() {/,/^}/p;/^fleet_test_is_head() {/,/^}/p' "$SRC" > "$1"
}

FUNCS="$TMP/funcs.sh"
extract_functions "$FUNCS"
for fn in $FUNCS_LIST; do
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

FLEET_TEST_AGING_S=180

take() { # $1=ticket_dir $2=FLEET_TEST_PRIORITY value -> echoes ticket path
  PRIORITY_RANK="$(fleet_test_resolve_priority_rank "$2")"
  fleet_test_take_ticket "$1"
}

# --- Test A: ticket ordering -- a land ticket sorts before normal tickets regardless of arrival
# order, and FIFO holds within the same priority tier.
a_dir="$TMP/a.tickets"
normal1="$(take "$a_dir" normal)"
normal2="$(take "$a_dir" normal)"
land1="$(take "$a_dir" land)"

check "land ticket (arrived 3rd) is head, not the two earlier normal tickets" "yes" "$(fleet_test_is_head "$a_dir" "$land1" && echo yes || echo no)"
check "first normal ticket is NOT head while a land ticket is queued" "no" "$(fleet_test_is_head "$a_dir" "$normal1" && echo yes || echo no)"
check "second normal ticket is NOT head either" "no" "$(fleet_test_is_head "$a_dir" "$normal2" && echo yes || echo no)"

rm -f "$land1"
check "after the land ticket is served, the FIRST normal ticket becomes head (FIFO preserved)" "yes" "$(fleet_test_is_head "$a_dir" "$normal1" && echo yes || echo no)"
rm -f "$normal1" "$normal2"

# --- Test B (N1 fix, behavioral): the SLOT stage, not just the tree mutex, is ordered. Simulates
# CPU_SLOTS=2 with two tiny per-slot lock files, a slot already held, and 3 real waiters queueing
# for the ONE remaining slot -- a land arriving last must still win it ahead of the two earlier
# normal waiters, matching Cybersec's exact repro shape (2 slots, a holder, mixed waiters).
slot1="$TMP/slot-1.lock"; slot2="$TMP/slot-2.lock"
slot_dir="$TMP/slot.tickets"
exec 8>"$slot1"; flock 8 # slot 1 permanently held by an unrelated run for this test
acquire_either_slot() { # mirrors fleet-test.sh's acquire_cpu_slot shape, 2 slots
  local f
  for f in "$slot1" "$slot2"; do
    exec {TEST_FD}>>"$f" || continue
    if flock -n "$TEST_FD"; then return 0; fi
    exec {TEST_FD}>&-
  done
  return 1
}
exec 7>"$slot2"; flock 7 # slot 2 ALSO held, so no slot is free when the waiters below start

order_file="$TMP/order-b.txt"
: >"$order_file"
wait_for_slot() { # $1=label $2=FLEET_TEST_PRIORITY value
  (
    PRIORITY_RANK="$(fleet_test_resolve_priority_rank "$2")"
    ticket="$(fleet_test_take_ticket "$slot_dir")"
    while ! { fleet_test_is_head "$slot_dir" "$ticket" && acquire_either_slot; }; do sleep 0.1; done
    rm -f "$ticket"
    echo "$1" >> "$order_file"
  ) &
}
wait_for_slot "normal-A" normal
sleep 0.3
wait_for_slot "normal-B" normal
sleep 0.3
wait_for_slot "land-C" land
sleep 0.3
flock -u 7 # free slot 2 now that all three are queued (land-C arrived last)
wait
result_b="$(tr '\n' ' ' < "$order_file")"
check "N1: land waiter wins the SLOT stage ahead of two earlier normal waiters" "land-C normal-A normal-B " "$result_b"
flock -u 8 2>/dev/null

# --- Test C (N2 fix): a ticket recorded against a pid that has since been reused by an UNRELATED
# live process (different start time) is reaped, not treated as still alive.
c_dir="$TMP/c.tickets"
mkdir -p "$c_dir"
sleep 2 &
real_pid=$!
real_start="$(fleet_test_pid_starttime "$real_pid")"
# A ticket claiming to be this same live pid, but with a WRONG recorded start time (simulates the
# pid having been recycled since the ticket was written).
stale="$c_dir/1-000000000001.${real_pid}.1"
: > "$stale"
fleet_test_reap_stale_tickets "$c_dir"
check "N2: a live pid with a MISMATCHED recorded start time is reaped (recycled-pid case)" "no" "$([ -e "$stale" ] && echo yes || echo no)"
# Control: the SAME live pid with its ACTUAL start time survives.
genuine="$c_dir/1-000000000002.${real_pid}.${real_start}"
: > "$genuine"
fleet_test_reap_stale_tickets "$c_dir"
check "N2 control: a live pid with its correct start time is NOT reaped" "yes" "$([ -e "$genuine" ] && echo yes || echo no)"
rm -f "$genuine"
wait "$real_pid" 2>/dev/null

# --- Test D (N3 fix, structural): N3 is a property of the WAIT-LOOP SHAPE in the script body
# (ticket taken unconditionally, THEN the loop condition checks is_head AND the resource), not of
# the extracted functions alone -- a barge means some code path tries to acquire the resource
# BEFORE/without taking a ticket. Pin the real source: both stages' wait loops must have the
# unconditional-ticket shape, and neither may contain the old bare "try first, queue on failure"
# shape that let a fresh arrival skip the ticket queue entirely on the fast path.
check "N3: slot-stage loop checks is_head before acquire_cpu_slot (no bare 'while ! acquire_cpu_slot')" "0" "$(grep -c '^while ! acquire_cpu_slot; do$' "$SRC")"
check "N3: slot-stage loop is the ticket-gated shape" "1" "$(grep -cF 'while ! { fleet_test_is_head "$SLOT_TICKET_DIR" "$SLOT_TICKET" && acquire_cpu_slot; }; do' "$SRC")"
check "N3: tree-stage loop has no bare 'if ! flock -n 9' fast-path-then-queue shape" "0" "$(grep -c '^if ! flock -n 9; then$' "$SRC")"
check "N3: tree-stage loop is the ticket-gated shape" "1" "$(grep -cF 'while ! { fleet_test_is_head "$TREE_TICKET_DIR" "$TREE_TICKET" && flock -n 9; }; do' "$SRC")"

# --- Test E (N4 fix): bounded aging. A normal ticket older than FLEET_TEST_AGING_S is promoted to
# rank 0 for ordering, so a continuous stream of later-arriving land tickets cannot starve it
# forever.
e_dir="$TMP/e.tickets"
old_normal="$(take "$e_dir" normal)"
touch -d "@$(( $(date +%s) - FLEET_TEST_AGING_S - 5 ))" "$old_normal"
new_land="$(take "$e_dir" land)"
check "N4: an aged normal ticket outranks a freshly-arrived land ticket" "yes" "$(fleet_test_is_head "$e_dir" "$old_normal" && echo yes || echo no)"
rm -f "$old_normal" "$new_land"
# Control: a normal ticket younger than the aging threshold still loses to a land ticket.
young_normal="$(take "$e_dir" normal)"
land2="$(take "$e_dir" land)"
check "N4 control: a FRESH normal ticket still loses to a land ticket (aging has a floor)" "no" "$(fleet_test_is_head "$e_dir" "$young_normal" && echo yes || echo no)"
rm -f "$young_normal" "$land2"

echo
echo "fleet-test-priority-lane.selftest: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
