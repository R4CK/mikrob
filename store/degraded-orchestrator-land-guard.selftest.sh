#!/usr/bin/env bash
# degraded-orchestrator-land-guard.selftest.sh -- card d5638d28: proves marveen-land.sh refuses to
# land while degraded-orchestrator mode is on, and does NOT refuse (for this reason) when it is
# off or when --actor mikrob is given. Runs the REAL marveen-land.sh (not a copy of its logic),
# pointed at a scratch switch file via the DEGRADED_ORCHESTRATOR_SWITCH env override and a
# throwaway MARVEEN_MAIN so the check fires and dies BEFORE any real git operation is attempted
# (the check runs first, right after arg parsing -- see marveen-land.sh's own comment at its
# definition).
set -uo pipefail
HERE="$(dirname "$0")"
LAND="$HERE/marveen-land.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
SWITCH="$TMPDIR/degraded-orchestrator-enabled.json"
FAKE_MAIN="$TMPDIR/fake-main"
mkdir -p "$FAKE_MAIN"
# A real (empty) git repo, so marveen-land.sh's OWN "is this a git repo" check (line ~1118, a
# different refusal that happens to also exit 3) passes and execution actually reaches the
# degraded-orchestrator guard this selftest is pinning, instead of dying earlier for an unrelated
# reason that would make every case below a false pass.
git init -q "$FAKE_MAIN"

PASS=0; FAIL=0

# Case 1: switch missing (default OFF) -- the guard itself must not be what refuses. Using a
# nonexistent agent name so the REAL refusal (unrelated to this guard) is "agent branch not found",
# never the degraded-orchestrator message -- that is the thing under test.
rm -f "$SWITCH"
out="$(DEGRADED_ORCHESTRATOR_SWITCH="$SWITCH" MARVEEN_MAIN="$FAKE_MAIN" bash "$LAND" --dry-run no-such-agent-d5638d28 2>&1)"
if echo "$out" | grep -q "degraded-orchestrator mode is ON"; then
  FAIL=$((FAIL+1)); echo "  FAIL case 1 (switch missing = OFF): guard fired anyway: $out"
else
  PASS=$((PASS+1))
fi

# Case 2: {"enabled": true} -- must refuse with the degraded-orchestrator message, exit 3, BEFORE
# touching $FAKE_MAIN (git -C $FAKE_MAIN ... would itself fail since it is not a git repo -- the
# guard must win that race, not lose to a different error).
printf '{"enabled": true}' > "$SWITCH"
out="$(DEGRADED_ORCHESTRATOR_SWITCH="$SWITCH" MARVEEN_MAIN="$FAKE_MAIN" bash "$LAND" --dry-run some-agent 2>&1)"
rc=$?
if [ "$rc" = 3 ] && echo "$out" | grep -q "degraded-orchestrator mode is ON"; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1)); echo "  FAIL case 2 (enabled:true refuses): rc=$rc, out=$out"
fi

# Case 3: {"enabled": true} + --actor mikrob -- the one bypass. Must NOT produce the
# degraded-orchestrator refusal (it may still fail later for unrelated reasons -- $FAKE_MAIN is not
# a real git repo -- but that failure must not be THIS guard's message).
out="$(DEGRADED_ORCHESTRATOR_SWITCH="$SWITCH" MARVEEN_MAIN="$FAKE_MAIN" bash "$LAND" --dry-run some-agent --actor mikrob 2>&1)"
if echo "$out" | grep -q "degraded-orchestrator mode is ON"; then
  FAIL=$((FAIL+1)); echo "  FAIL case 3 (--actor mikrob bypass): guard still fired: $out"
else
  PASS=$((PASS+1))
fi

# Case 4: malformed/unreadable switch file -- fails CLOSED (refused), same as enabled:true.
printf '{not valid json' > "$SWITCH"
out="$(DEGRADED_ORCHESTRATOR_SWITCH="$SWITCH" MARVEEN_MAIN="$FAKE_MAIN" bash "$LAND" --dry-run some-agent 2>&1)"
rc=$?
if [ "$rc" = 3 ] && echo "$out" | grep -q "degraded-orchestrator mode is ON"; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1)); echo "  FAIL case 4 (malformed switch fails closed): rc=$rc, out=$out"
fi

echo "degraded-orchestrator-land-guard.selftest: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
