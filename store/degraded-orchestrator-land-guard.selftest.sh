#!/usr/bin/env bash
# degraded-orchestrator-land-guard.selftest.sh -- card d5638d28: proves marveen-land.sh refuses to
# land while degraded-orchestrator mode is on, and does NOT refuse (for this reason) when it is
# off or when --actor mikrob is given. Runs the REAL marveen-land.sh (not a copy of its logic),
# pointed at a scratch switch file via the DEGRADED_ORCHESTRATOR_SWITCH env override and a
# throwaway MARVEEN_MAIN so the check fires and dies BEFORE any real git operation is attempted
# (the check runs first, right after arg parsing -- see marveen-land.sh's own comment at its
# definition).
#
# Round 3 (CYBERED NO-GO 32245 F1, MikroB decision 32246): Kesz ha #1 is now "default path absent
# = OFF; explicit override to a missing path = refuse; override to {"enabled": false} = OFF" --
# OFF must be simulated via an override to an EXISTING {"enabled": false} file (cases 1/7 below),
# never via an override to a REMOVED file (that is now case 8's own refuse scenario).
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

# Case 1: override to an EXISTING {"enabled": false} file -- the guard itself must not be what
# refuses. Using a nonexistent agent name so the REAL refusal (unrelated to this guard) is "agent
# branch not found", never the degraded-orchestrator message -- that is the thing under test.
printf '{"enabled": false}' > "$SWITCH"
out="$(DEGRADED_ORCHESTRATOR_SWITCH="$SWITCH" MARVEEN_MAIN="$FAKE_MAIN" bash "$LAND" --dry-run no-such-agent-d5638d28 2>&1)"
if echo "$out" | grep -q "degraded-orchestrator mode is ON"; then
  FAIL=$((FAIL+1)); echo "  FAIL case 1 (override to {enabled:false} = OFF): guard fired anyway: $out"
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

# Case 5 (CYBERED NO-GO 32207, residual 2; MikroB Fix-Direction 32209 #4): --actor accepts ONLY
# the allowlisted owner identity, not any non-empty name. Before this case, 4/4 only ever tried
# --actor mikrob, so a mutant that let ANY --actor through left the suite green.
printf '{"enabled": true}' > "$SWITCH"
out="$(DEGRADED_ORCHESTRATOR_SWITCH="$SWITCH" MARVEEN_MAIN="$FAKE_MAIN" bash "$LAND" --dry-run some-agent --actor someone-else 2>&1)"
rc=$?
if [ "$rc" = 3 ] && echo "$out" | grep -q "degraded-orchestrator mode is ON"; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1)); echo "  FAIL case 5 (non-owner --actor still refused): rc=$rc, out=$out"
fi

# Case 6 (MikroB msg 19635, WhiteHat round-1 measurement): python3 missing from PATH means the
# check cannot run at all -- must refuse (fail closed), not silently proceed as if the switch were
# off. A minimal fakebin dir carries every OTHER coreutils binary the script needs so execution
# reaches the degraded-orchestrator guard and not some unrelated "command not found" earlier.
printf '{"enabled": true}' > "$SWITCH"
FAKEBIN="$TMPDIR/fakebin"
mkdir -p "$FAKEBIN"
for b in bash git grep sed awk cat tr cut head tail mktemp rm mkdir printf test sort uniq wc date tee dirname basename find xargs; do
  p=$(command -v "$b" 2>/dev/null) && ln -sf "$p" "$FAKEBIN/$b"
done
out="$(PATH="$FAKEBIN" DEGRADED_ORCHESTRATOR_SWITCH="$SWITCH" MARVEEN_MAIN="$FAKE_MAIN" bash "$LAND" --dry-run some-agent 2>&1)"
rc=$?
if [ "$rc" = 3 ] && echo "$out" | grep -q "degraded-orchestrator mode is ON"; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1)); echo "  FAIL case 6 (python3 missing -> refuse): rc=$rc, out=$out"
fi

# Case 7: MUTATION PIN -- override to an EXISTING {"enabled": false} file (case 1's own pattern)
# must stay unaffected by case 6's python3 fix -- re-run case 1 itself with python3 present.
printf '{"enabled": false}' > "$SWITCH"
out="$(DEGRADED_ORCHESTRATOR_SWITCH="$SWITCH" MARVEEN_MAIN="$FAKE_MAIN" bash "$LAND" --dry-run no-such-agent-d5638d28-again 2>&1)"
if echo "$out" | grep -q "degraded-orchestrator mode is ON"; then
  FAIL=$((FAIL+1)); echo "  FAIL case 7 (override to {enabled:false} = OFF, unaffected by case 6): guard fired anyway: $out"
else
  PASS=$((PASS+1))
fi

# Case 8 (CYBERED NO-GO 32245 F1, MikroB decision 32246): an EXPLICIT override pointing at a
# missing path is a broken configuration, not a statement of normal mode -- must refuse. Distinct
# from case 9's default-path-missing scenario below.
NO_SUCH_SWITCH="$TMPDIR/no-such-switch.json"
rm -f "$NO_SUCH_SWITCH"
out="$(DEGRADED_ORCHESTRATOR_SWITCH="$NO_SUCH_SWITCH" MARVEEN_MAIN="$FAKE_MAIN" bash "$LAND" --dry-run some-agent 2>&1)"
rc=$?
if [ "$rc" = 3 ] && echo "$out" | grep -q "degraded-orchestrator mode is ON"; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1)); echo "  FAIL case 8 (explicit override to missing path -> refuse): rc=$rc, out=$out"
fi

# Case 9: MUTATION PIN -- the DEFAULT path (no override at all) never having been written is
# STILL the legitimate OFF state, unaffected by case 8's fix. Unset DEGRADED_ORCHESTRATOR_SWITCH
# entirely so the script's own default applies, pointed at a MARVEEN_MAIN whose store/ never got
# a switch file written.
unset DEGRADED_ORCHESTRATOR_SWITCH
out="$(MARVEEN_MAIN="$FAKE_MAIN" bash "$LAND" --dry-run no-such-agent-d5638d28-default 2>&1)"
if echo "$out" | grep -q "degraded-orchestrator mode is ON"; then
  FAIL=$((FAIL+1)); echo "  FAIL case 9 (default path missing, no override = OFF, unaffected by case 8): guard fired anyway: $out"
else
  PASS=$((PASS+1))
fi

# Case 10 (card 2ba008f2 round 3, WhiteHat2 probe on origin/develop): the --actor mikrob bypass
# in case 3 must NOT apply while a session outage is active, even though the switch itself is ON.
OUTAGE="$TMPDIR/mikrob-session-outage.json"
printf '{"enabled": true}' > "$SWITCH"
printf '{"active": true, "heartbeat": %s}' "$(date +%s)" > "$OUTAGE"
out="$(DEGRADED_ORCHESTRATOR_SWITCH="$SWITCH" MIKROB_SESSION_OUTAGE_PATH="$OUTAGE" MARVEEN_MAIN="$FAKE_MAIN" bash "$LAND" --dry-run some-agent --actor mikrob 2>&1)"
rc=$?
if [ "$rc" = 3 ] && echo "$out" | grep -q "degraded-orchestrator mode is ON"; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1)); echo "  FAIL case 10 (--actor mikrob refused during active outage): rc=$rc, out=$out"
fi

# Case 11: MUTATION PIN -- the SAME outage marker, but the switch itself is {"enabled": false}
# (OFF): the lander must proceed normally -- an outage must not turn an OFF switch into a refusal.
printf '{"enabled": false}' > "$SWITCH"
out="$(DEGRADED_ORCHESTRATOR_SWITCH="$SWITCH" MIKROB_SESSION_OUTAGE_PATH="$OUTAGE" MARVEEN_MAIN="$FAKE_MAIN" bash "$LAND" --dry-run no-such-agent-d5638d28-outage-off --actor mikrob 2>&1)"
if echo "$out" | grep -q "degraded-orchestrator mode is ON"; then
  FAIL=$((FAIL+1)); echo "  FAIL case 11 (switch OFF during outage): guard fired anyway: $out"
else
  PASS=$((PASS+1))
fi

# Cases 12-14 (CYBERSEC NO-GO 32558 F1): _session_outage_active's python3 subprocess crashing
# (exit 1 / 137 / 139) must refuse the --actor mikrob bypass, same as a fresh active marker -- the
# old `[ $? = 0 ]` read let any non-zero, non-intended exit fall through to "not active", wrongly
# granting the bypass on a crash. The stub below crashes ONLY the outage-check's own inline
# script (matched by a string unique to it, "FileNotFoundError", absent from the switch-file
# reader's script) and passes every other python3 call through to the real interpreter, so the
# switch check itself still runs correctly and this pins the outage check specifically.
printf '{"enabled": true}' > "$SWITCH"
CRASHBIN="$TMPDIR/crashbin"
mkdir -p "$CRASHBIN"
REAL_PYTHON3="$(command -v python3)"
cat > "$CRASHBIN/python3" <<STUBEOF
#!/bin/sh
for a in "\$@"; do
  case "\$a" in
    *FileNotFoundError*) exit "\${STUB_CRASH_CODE:-1}" ;;
  esac
done
exec "$REAL_PYTHON3" "\$@"
STUBEOF
chmod +x "$CRASHBIN/python3"
case_n=12
for code in 1 137 139; do
  out="$(STUB_CRASH_CODE=$code PATH="$CRASHBIN:$PATH" DEGRADED_ORCHESTRATOR_SWITCH="$SWITCH" MIKROB_SESSION_OUTAGE_PATH="$OUTAGE" MARVEEN_MAIN="$FAKE_MAIN" bash "$LAND" --dry-run some-agent --actor mikrob 2>&1)"
  rc=$?
  if [ "$rc" = 3 ] && echo "$out" | grep -q "degraded-orchestrator mode is ON"; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1)); echo "  FAIL case $case_n (outage-check python3 crash exit $code refuses the bypass): rc=$rc, out=$out"
  fi
  case_n=$((case_n+1))
done

echo "degraded-orchestrator-land-guard.selftest: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
