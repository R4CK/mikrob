#!/usr/bin/env bash
# fleet-test-lock-log.selftest.sh -- dedicated test for fleet-test.sh's wait/run lock logging
# (card c5ff36bf). Non-behavioral: this instruments the TREE-lock stage (the one real bottleneck,
# per b7d8ecc4's own follow-up) with an append-only log line so a wait/run table can be built from
# real data instead of a single live snapshot. Extracts the ACTUAL function with sed, same pattern
# as fleet-test-priority-lane.selftest.sh, so a future edit to the real function is what this test
# exercises, not a hand-written copy.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/fleet-test.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FUNCS="$TMP/funcs.sh"
sed -n '/^fleet_test_log_lock_event() {/,/^}/p' "$SRC" > "$FUNCS"
grep -q '^fleet_test_log_lock_event() {' "$FUNCS" || { echo "FAIL: could not extract fleet_test_log_lock_event from $SRC -- source and selftest have drifted"; exit 1; }
# shellcheck disable=SC1090
. "$FUNCS"

pass=0
fail=0
check() { # $1=description $2=expected-regex $3=actual
  if [[ "$3" =~ $2 ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $1 (want match: $2, got: $3)"
  fi
}

# --- Test A: a "run" event on a scoped call logs scope=scoped:<n>, and the fields asked for by
# MikroB (ts, pid, priority, ref, wait_s, run_s, status) all land on one line.
LOCK_LOG="$TMP/lock-a.log"
ARGS=(src/__tests__/a.test.ts src/__tests__/b.test.ts)
REF="deadbeef123"
PRIORITY_RANK=1
FLEET_TEST_PRIORITY=normal
fleet_test_log_lock_event run 42 613 0
line="$(cat "$LOCK_LOG")"
check "one line written" '^[^
]*$' "$line"
check "end_ts is an explicitly-named ISO timestamp, at line start" '^end_ts=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z ' "$line"
check "start_ts is an explicitly-named ISO timestamp" 'start_ts=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z' "$line"
check "pid field present" 'pid=[0-9]+' "$line"
check "event=run" 'event=run' "$line"
check "scope=scoped:2 for a 2-file ARGS" 'scope=scoped:2' "$line"
check "ref echoed verbatim" 'ref=deadbeef123' "$line"
check "wait_s echoed" 'wait_s=42' "$line"
check "run_s echoed" 'run_s=613' "$line"
check "status echoed" 'status=0' "$line"

# --- Test A2 (card 2c49a628): start_ts must be end_ts - run_s, not a copy of end_ts -- a reader
# needs the ACTUAL lock-held window, and card 2c49a628 was opened because two back-to-back runs
# looked like they overlapped when both were (wrongly) read as starting at their own end_ts.
end_ts_a="$(sed -n 's/.*end_ts=\([0-9TZ:-]*\).*/\1/p' <<<"$line")"
start_ts_a="$(sed -n 's/.*start_ts=\([0-9TZ:-]*\).*/\1/p' <<<"$line")"
end_epoch_a="$(date -u -d "$end_ts_a" +%s)"
start_epoch_a="$(date -u -d "$start_ts_a" +%s)"
check "start_ts = end_ts - run_s (613s)" "^$((end_epoch_a - 613))$" "$start_epoch_a"

# --- Test A3 (card 2c49a628): two back-to-back runs (second's start_ts == first's end_ts) must
# NOT be mistaken for an overlap -- this is the exact misreading that produced the false "29s
# overlap" finding. A correct reader compares [start_ts, end_ts] windows, not [end_ts, end_ts+run_s].
LOCK_LOG="$TMP/lock-a3.log"
ARGS=()
REF="first"
fleet_test_log_lock_event run 0 100 0
first_line="$(tail -n1 "$LOCK_LOG")"
first_end="$(sed -n 's/.*end_ts=\([0-9TZ:-]*\).*/\1/p' <<<"$first_line")"
sleep 1
REF="second"
# run_s=1 models a run that acquired the lock the instant the first one released it (sleep 1
# above advanced end_ts by ~1s, so start_ts = end_ts - 1 lands back on the first run's end_ts).
fleet_test_log_lock_event run 0 1 0
second_line="$(tail -n1 "$LOCK_LOG")"
second_start="$(sed -n 's/.*start_ts=\([0-9TZ:-]*\).*/\1/p' <<<"$second_line")"
first_end_epoch="$(date -u -d "$first_end" +%s)"
second_start_epoch="$(date -u -d "$second_start" +%s)"
no_overlap=$(( second_start_epoch >= first_end_epoch ? 1 : 0 ))
check "second run's start_ts is not before the first run's end_ts (no overlap)" '^1$' "$no_overlap"

# --- Test B: a full run (ARGS empty) logs scope=full, not scoped:0.
LOCK_LOG="$TMP/lock-b.log"
ARGS=()
REF="cafef00d"
fleet_test_log_lock_event run 5 900 1
check "scope=full when ARGS is empty" 'scope=full' "$(cat "$LOCK_LOG")"
check "nonzero status echoed" 'status=1' "$(cat "$LOCK_LOG")"

# --- Test C: a timeout event (never acquired) has wait_s but run_s is the n/a marker, not a
# fabricated number -- a reader must not confuse "never ran" with "ran for 0s".
LOCK_LOG="$TMP/lock-c.log"
ARGS=()
REF="timedout01"
fleet_test_log_lock_event timeout 900 - 3
check "timeout event recorded" 'event=timeout' "$(cat "$LOCK_LOG")"
check "run_s is the n/a marker for a timeout (never ran)" 'run_s=-' "$(cat "$LOCK_LOG")"
check "start_ts is the n/a marker for a timeout (lock never acquired, no start)" 'start_ts=-( |$)' "$(cat "$LOCK_LOG")"

# --- Test D: append-only -- two calls add two lines, never truncate.
LOCK_LOG="$TMP/lock-d.log"
ARGS=()
REF="r1"
fleet_test_log_lock_event run 1 1 0
REF="r2"
fleet_test_log_lock_event run 2 2 0
n="$(wc -l < "$LOCK_LOG")"
check "two events -> two lines (append, not overwrite)" '^2$' "$n"

# --- Test E: logging never fails the caller even if the log path is unwritable (best-effort,
# card c5ff36bf's own "must never slow down or fail a real test run" constraint).
LOCK_LOG="$TMP/no-such-dir/lock.log"
ARGS=()
REF="r3"
if fleet_test_log_lock_event run 1 1 0; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL: fleet_test_log_lock_event must not fail the caller when its own log path is unwritable"
fi

# --- Mutation check: a weakened version that skips the append (e.g. redirects to /dev/null
# instead of >>$LOCK_LOG) must fail Test D above -- confirms the test is not vacuously green.
LOCK_LOG="$TMP/mut.log"
mut_fleet_test_log_lock_event() { :; } # mutant: logs nothing at all
ARGS=()
REF="m1"
mut_fleet_test_log_lock_event run 1 1 0
if [ -s "$LOCK_LOG" ]; then
  fail=$((fail + 1))
  echo "FAIL: mutant unexpectedly wrote a log (test setup is broken)"
else
  pass=$((pass + 1))
fi

echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
