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

if [ "$FAILED" -gt 0 ]; then
  echo "selftest: $PASSED passed, $FAILED failed"
  exit 1
fi
echo "selftest: $PASSED passed, 0 failed"
