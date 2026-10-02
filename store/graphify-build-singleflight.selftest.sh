#!/usr/bin/env bash
# graphify-build-singleflight.selftest.sh -- card 0cfd1dbc acceptance test: two successive
# landings' graphify triggers must leave exactly ONE graphify build running at a time (never
# one process per landing), and must not exceed 2 total builds for 2 landings.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

REPO="$TMP/repo"
mkdir -p "$REPO"

CALLS="$TMP/calls.log"
RUNNING="$TMP/running.count"
MAXCONC="$TMP/max-concurrency.txt"
COUNTER_LOCK="$TMP/counter.lock"
echo 0 >"$RUNNING"
echo 0 >"$MAXCONC"

# Fake graphify.sh: records a start marker, sleeps (simulating the real multi-minute build so
# overlap/coalescing is observable), then records an end marker. Concurrency bookkeeping is
# itself lock-protected so the test's own counter writes are not the thing racing.
FAKE_GRAPHIFY="$TMP/graphify.sh"
cat >"$FAKE_GRAPHIFY" <<EOF
#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" = "build" ] || { echo "unexpected args: \$*" >&2; exit 9; }
echo "build \$\$ start" >>"$CALLS"
exec 8>"$COUNTER_LOCK"
flock 8
n=\$(cat "$RUNNING"); n=\$((n + 1)); echo "\$n" >"$RUNNING"
m=\$(cat "$MAXCONC"); [ "\$n" -gt "\$m" ] && echo "\$n" >"$MAXCONC" || true
flock -u 8
sleep 0.4
exec 8>"$COUNTER_LOCK"
flock 8
n=\$(cat "$RUNNING"); n=\$((n - 1)); echo "\$n" >"$RUNNING"
flock -u 8
echo "build \$\$ end" >>"$CALLS"
EOF
chmod +x "$FAKE_GRAPHIFY"

SUT="$HERE/graphify-build-singleflight.sh"

# Simulate two successive landings firing the trigger back-to-back, the way mopsion-land.sh does
# (detached) -- the 2nd fires while the 1st's build is still running, which is the exact shape
# that produced the measured pileup (card 0cfd1dbc comments: 5-11 concurrent builds).
GRAPHIFY_SH="$FAKE_GRAPHIFY" "$SUT" "$REPO" &
P1=$!
sleep 0.05
GRAPHIFY_SH="$FAKE_GRAPHIFY" "$SUT" "$REPO" &
P2=$!
wait "$P1" 2>/dev/null || true
wait "$P2" 2>/dev/null || true

# The lock-holder may still be looping to cover the 2nd landing's dirty flag; wait for the lock
# to become free (bounded) before reading final counts.
LOCK="$REPO/graphify-out/.graphify-build.lock"
for _ in $(seq 1 50); do
  exec 7>"$LOCK"
  if flock -n 7; then
    flock -u 7
    exec 7>&-
    break
  fi
  exec 7>&-
  sleep 0.1
done

CALL_COUNT="$(grep -c '^build .* start$' "$CALLS" || true)"
MAX_CONCURRENCY="$(cat "$MAXCONC")"

echo "calls: $CALL_COUNT, max concurrency: $MAX_CONCURRENCY"

PASSED=0
FAILED=0

if [ "$MAX_CONCURRENCY" -le 1 ]; then
  echo "ok   at most one graphify build ran concurrently (max=$MAX_CONCURRENCY)"
  PASSED=$((PASSED + 1))
else
  echo "FAIL at most one graphify build ran concurrently -- got max=$MAX_CONCURRENCY"
  FAILED=$((FAILED + 1))
fi

if [ "$CALL_COUNT" -ge 1 ] && [ "$CALL_COUNT" -le 2 ]; then
  echo "ok   two successive landings produced <=2 total builds, never one-per-landing (calls=$CALL_COUNT)"
  PASSED=$((PASSED + 1))
else
  echo "FAIL two successive landings should produce 1 or 2 total builds -- got calls=$CALL_COUNT"
  FAILED=$((FAILED + 1))
fi

# --- L3 (WhiteHat, card 33a587b5): a killed wrapper must not leave the lock pinned forever by a
# surviving grandchild. graphify.sh's own multi-process workers can outlive the top-level build if
# it is killed -- fd 9 must be closed in the build child so only the wrapper's own fd can hold/
# release the flock.
REPO3="$TMP/repo3"
mkdir -p "$REPO3"
FAKE_L3="$TMP/graphify-l3.sh"
cat >"$FAKE_L3" <<'EOF'
#!/usr/bin/env bash
sleep 30 &
sleep 30
EOF
chmod +x "$FAKE_L3"
LOCK3="$REPO3/graphify-out/.graphify-build.lock"
GRAPHIFY_SH="$FAKE_L3" "$SUT" "$REPO3" &
P3=$!
for _ in $(seq 1 50); do [ -e "$LOCK3" ] && fuser "$LOCK3" >/dev/null 2>&1 && break; sleep 0.05; done
kill -9 "$P3" 2>/dev/null || true
sleep 0.3
if fuser "$LOCK3" >/dev/null 2>&1; then
  echo "FAIL fd-9 inheritance -- lock still held after killing the wrapper (orphan grandchild pinned it)"
  FAILED=$((FAILED + 1))
else
  echo "ok   fd-9 closed in the build child -- a killed wrapper's lock frees even with a surviving grandchild"
  PASSED=$((PASSED + 1))
fi
pkill -9 -f "$FAKE_L3" >/dev/null 2>&1 || true

# --- L2 (WhiteHat, card 33a587b5): a failing build must not abort the wrapper under `set -e` --
# it should still complete (and leave any dirty flag for the next acquirer), not wedge.
REPO2="$TMP/repo2"
mkdir -p "$REPO2"
FAKE_L2="$TMP/graphify-l2.sh"
cat >"$FAKE_L2" <<'EOF'
#!/usr/bin/env bash
exit 7
EOF
chmod +x "$FAKE_L2"
if GRAPHIFY_SH="$FAKE_L2" "$SUT" "$REPO2"; then
  echo "ok   a failing build does not abort the wrapper (set -e tolerated)"
  PASSED=$((PASSED + 1))
else
  echo "FAIL a failing build aborted the wrapper instead of completing"
  FAILED=$((FAILED + 1))
fi

# --- L1 (WhiteHat, card 33a587b5): lost wakeup in the window between the last "no dirty, break"
# check and `flock -u 9`. The real window is microseconds wide, so we test an instrumented copy of
# the SUT with that window artificially widened (the same technique WhiteHat used to prove the
# bug) -- only the FIRST `flock -u 9` (the one in that race window) gets the extra sleep.
REPO4="$TMP/repo4"
mkdir -p "$REPO4"
INSTRUMENTED="$TMP/instrumented.sh"
sed '0,/^flock -u 9$/{s/^flock -u 9$/sleep 0.5\nflock -u 9/}' "$SUT" >"$INSTRUMENTED"
chmod +x "$INSTRUMENTED"
L1_CALLS_LOG="$TMP/l1-calls.log"
FAKE_L1="$TMP/graphify-l1.sh"
cat >"$FAKE_L1" <<EOF
#!/usr/bin/env bash
set -euo pipefail
echo "start \$\$" >>"$L1_CALLS_LOG"
sleep 0.2
echo "end \$\$" >>"$L1_CALLS_LOG"
EOF
chmod +x "$FAKE_L1"
GRAPHIFY_SH="$FAKE_L1" "$INSTRUMENTED" "$REPO4" &
L1P1=$!
sleep 0.35
GRAPHIFY_SH="$FAKE_L1" "$INSTRUMENTED" "$REPO4" &
L1P2=$!
wait "$L1P1" 2>/dev/null || true
wait "$L1P2" 2>/dev/null || true
sleep 0.2
L1_CALLS="$(grep -c '^start' "$L1_CALLS_LOG" 2>/dev/null || true)"
L1_DIRTY="$REPO4/graphify-out/.graphify-build.dirty"
if [ "${L1_CALLS:-0}" -ge 2 ] && [ ! -e "$L1_DIRTY" ]; then
  echo "ok   lost-wakeup closer covers a request that loses the race for the lock (calls=$L1_CALLS, dirty=absent)"
  PASSED=$((PASSED + 1))
else
  DIRTY_PRESENT="no"; [ -e "$L1_DIRTY" ] && DIRTY_PRESENT="yes"
  echo "FAIL lost-wakeup closer did not cover the race -- calls=${L1_CALLS:-0}, dirty-present=$DIRTY_PRESENT"
  FAILED=$((FAILED + 1))
fi

if [ "$FAILED" -gt 0 ]; then
  echo "selftest: $PASSED passed, $FAILED failed"
  exit 1
fi
echo "selftest: $PASSED passed, 0 failed"
