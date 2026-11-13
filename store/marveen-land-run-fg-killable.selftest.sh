#!/usr/bin/env bash
# Self-test for marveen-land.sh's run_fg_killable() (card 9d1ee327, CYBERSEC NO-GO 28823 LOW
# item 1): a signal received while bash blocks on a FOREGROUND subshell/pipeline is deferred
# until that subshell exits (measured on the real fleet-test call: 10s vs 0s). This proves the
# fix actually changes that timing, not just that the function exists: a RED baseline reproduces
# the deferral with the OLD pattern (a plain foreground subshell), then the GREEN case shows
# run_fg_killable's TERM trap firing promptly instead of waiting out the same sleep.
#
# Same extraction pattern as marveen-land-term-trap.selftest.sh: pull the real, currently-
# committed function body out of the script rather than re-typing it, so a future edit that
# breaks or removes run_fg_killable breaks this test too.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAND_SCRIPT="$HERE/marveen-land.sh"
fail=0

ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; fail=1; }

FN_SRC="$(awk '/^run_fg_killable_pid=""$/{p=1} p{print} p&&/^}$/{exit}' "$LAND_SCRIPT")"
[ -n "$FN_SRC" ] || { echo "FATAL: could not extract run_fg_killable from $LAND_SCRIPT -- anchors moved" >&2; exit 1; }

# run_fg_killable's own body calls release_land_lock_fd (card 81c6fbb5 Q3 fix) -- extract it too,
# or the isolated bash -c below has no such command and run_fg_killable's subshell fails.
RELEASE_FD_SRC="$(awk '/^release_land_lock_fd\(\) \{$/{p=1} p{print} p&&/^}$/{exit}' "$LAND_SCRIPT")"
[ -n "$RELEASE_FD_SRC" ] || { echo "FATAL: could not extract release_land_lock_fd from $LAND_SCRIPT -- anchors moved" >&2; exit 1; }
FN_SRC="$RELEASE_FD_SRC"$'\n'"$FN_SRC"

SLEEP_S=6

# 1. RED baseline: the OLD pattern this card replaced (a plain foreground subshell) defers the
#    TERM trap until the subshell itself finishes -- confirms the deferral this fix addresses is
#    real behavior, not an assumed one.
start=$(date +%s)
bash -c '
trap "exit 143" TERM
( sleep '"$SLEEP_S"' )
' &
old_pid=$!
sleep 0.3
kill -TERM "$old_pid" 2>/dev/null
wait "$old_pid" 2>/dev/null
old_elapsed=$(( $(date +%s) - start ))
if [ "$old_elapsed" -ge $((SLEEP_S - 1)) ]; then
  ok "RED baseline confirmed: a plain foreground subshell defers the TERM trap (${old_elapsed}s, ~${SLEEP_S}s sleep)"
else
  bad "RED baseline did not reproduce the deferral -- plain foreground subshell returned in ${old_elapsed}s, expected ~${SLEEP_S}s"
fi

# 2. GREEN: run_fg_killable() backgrounds the command and blocks on `wait` instead -- `wait` is
#    interruptible, so the TERM trap fires immediately rather than after the sleep ends.
start=$(date +%s)
bash -c '
'"$FN_SRC"'
trap "exit 143" TERM
run_fg_killable "/tmp" "sleep '"$SLEEP_S"'"
' &
new_pid=$!
sleep 0.3
kill -TERM "$new_pid" 2>/dev/null
wait "$new_pid" 2>/dev/null
new_elapsed=$(( $(date +%s) - start ))
if [ "$new_elapsed" -lt $((SLEEP_S - 1)) ]; then
  ok "run_fg_killable: TERM trap fires promptly (${new_elapsed}s, not deferred to the ${SLEEP_S}s sleep)"
else
  bad "run_fg_killable: TERM trap was still deferred (${new_elapsed}s, ~${SLEEP_S}s sleep) -- fix not effective"
fi

# 3. Non-vacuity / correctness: run_fg_killable still returns the wrapped command's real exit
#    code and output when nothing interrupts it (the backgrounding must not change behavior on
#    the ordinary, un-signaled path).
bash -c '
'"$FN_SRC"'
run_fg_killable "/tmp" "echo hello; exit 7"
echo "rc=$?"
' >"/tmp/run-fg-killable-selftest-out.$$" 2>&1
out="$(cat "/tmp/run-fg-killable-selftest-out.$$")"
rm -f "/tmp/run-fg-killable-selftest-out.$$"
case "$out" in
  *"hello"*"rc=7"*) ok "run_fg_killable passes through real stdout and the wrapped command's exit code" ;;
  *) bad "run_fg_killable did not pass through output/exit code correctly: $out" ;;
esac

# 3b. Regression test (card 78339a8a): LANDING_DOWNWARD_CHECK=off, exported into marveen-land.sh's
#    own process (the usual way an operator overrides the downward check for one landing), must
#    NOT survive into the command run_fg_killable executes -- that command is fleet-test.sh in
#    production, and its own vitest run spawns marveen-land.sh --selftest as a child, whose
#    downward-check selftest cases read the same env var. Measured on a real land (4f3c0287,
#    2026-11-13): the override leaked all the way down and flipped 5 "foreign commit refuses"
#    selftest cases from PASS to FAIL, with nothing wrong in the merged content itself.
leak_out="$(
bash -c '
'"$FN_SRC"'
export LANDING_DOWNWARD_CHECK=off
run_fg_killable "/tmp" "echo \"child=[\${LANDING_DOWNWARD_CHECK:-UNSET}]\""
echo "parent=[$LANDING_DOWNWARD_CHECK]"
' 2>&1
)"
case "$leak_out" in
  *"child=[UNSET]"*"parent=[off]"*)
    ok "run_fg_killable's subshell does not inherit an exported LANDING_DOWNWARD_CHECK override (parent keeps it for its own downward_check() call)" ;;
  *)
    bad "LANDING_DOWNWARD_CHECK leaked into run_fg_killable's wrapped command: $leak_out" ;;
esac

# 4-5. Regression test (card 07f1fe6e, CYBERSEC GO 29154 M1 + M2): a TERM to the process running
#    run_fg_killable must kill the WHOLE process group the wrapped command runs in, not just the
#    one subshell -- otherwise the wrapped command's own children (the fleet-test/vitest tree in
#    production) survive as orphans, reparented but alive, holding a CPU slot (measured). Pulls
#    the REAL production TERM trap line out of marveen-land.sh (same extraction discipline as the
#    function bodies above), so a future edit that drops the group-kill breaks this test too.
SIG_FN_SRC="$(awk '/^  _land_sig_stop\(\) \{/{p=1} p{print} p&&/^  \}$/{exit}' "$LAND_SCRIPT")"
[ -n "$SIG_FN_SRC" ] || { echo "FATAL: could not extract _land_sig_stop from $LAND_SCRIPT -- anchor moved" >&2; exit 1; }
TERM_TRAP_LINE="$(command grep -F "trap '_land_sig_stop TERM" "$LAND_SCRIPT")"
[ -n "$TERM_TRAP_LINE" ] || { echo "FATAL: could not extract the production TERM trap registration from $LAND_SCRIPT -- anchor moved" >&2; exit 1; }
HUP_TRAP_LINE="$(command grep -F "trap '_land_sig_stop HUP" "$LAND_SCRIPT")"
[ -n "$HUP_TRAP_LINE" ] || { echo "FATAL: could not extract the production HUP trap registration from $LAND_SCRIPT -- anchor moved" >&2; exit 1; }
TRAP_SRC="$SIG_FN_SRC"$'\n'"$TERM_TRAP_LINE"
HUP_TRAP_SRC="$SIG_FN_SRC"$'\n'"$HUP_TRAP_LINE"

WRAPPED_CMD_SCRIPT="/tmp/run-fg-killable-selftest-wrapped.$$.sh"
cat >"$WRAPPED_CMD_SCRIPT" <<'WRAPPED'
#!/usr/bin/env bash
sleep 20 &
echo "$!" >"$1"
wait
WRAPPED
chmod +x "$WRAPPED_CMD_SCRIPT"

# $1 = signal to send (TERM/HUP), $2 = the trap source to use (real or a hand-built mutant);
# echoes 0 if the grandchild died (fixed behavior), 1 if it survived (the bug this card fixes).
run_orphan_probe() {
  local sig="$1" trap_src="$2" gc_mark outer_pid gc_pid result
  gc_mark="/tmp/run-fg-killable-selftest-gc.$$.$RANDOM"
  rm -f "$gc_mark"
  bash -c '
'"$FN_SRC"'
'"$trap_src"'
run_fg_killable "/tmp" "bash '"$WRAPPED_CMD_SCRIPT"' '"$gc_mark"'"
' &
  outer_pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do [ -s "$gc_mark" ] && break; sleep 0.2; done
  gc_pid="$(cat "$gc_mark" 2>/dev/null)"
  if [ -z "$gc_pid" ]; then
    kill -9 "$outer_pid" 2>/dev/null
    rm -f "$gc_mark"
    echo "NOGRANDCHILD"
    return
  fi
  kill -"$sig" "$outer_pid" 2>/dev/null
  sleep 1
  if kill -0 "$gc_pid" 2>/dev/null; then
    result=1
    kill -9 "$gc_pid" 2>/dev/null
  else
    result=0
  fi
  rm -f "$gc_mark"
  echo "$result"
}

real_result="$(run_orphan_probe TERM "$TRAP_SRC")"
case "$real_result" in
  0) ok "TERM to the wrapper kills the wrapped command's own child too (no surviving orphan)" ;;
  NOGRANDCHILD) bad "grandchild never started in the real-trap probe -- cannot test the regression" ;;
  *) bad "TERM left the wrapped command's child running as an orphan -- process-group kill not effective" ;;
esac

# M2 mutant pin: a trap that forwards TERM to just run_fg_killable_pid (the OLD, pre-fix single-pid
# form, no leading `-- -`) must leave the probe's grandchild alive -- proving the real selftest
# above is actually sensitive to the group-kill and would catch a regression back to the old form.
MUTANT_TRAP_SRC='trap '"'"'[ -n "${run_fg_killable_pid:-}" ] && kill -TERM "$run_fg_killable_pid" 2>/dev/null'"'"' TERM'
mutant_result="$(run_orphan_probe TERM "$MUTANT_TRAP_SRC")"
case "$mutant_result" in
  1) ok "M2 mutant pin confirmed: the pre-fix single-pid TERM (no process-group kill) leaves the grandchild running -- the real test above is sensitive to this" ;;
  NOGRANDCHILD) bad "grandchild never started in the mutant probe -- cannot confirm the M2 pin" ;;
  *) bad "M2 mutant pin did NOT reproduce the orphan -- the probe itself may be vacuous (mutant_result=$mutant_result)" ;;
esac

# HUP pin (card 07f1fe6e delta, CYBERSEC GO 29326 L1): a HUP sent to the wrapper's own pid (not
# the whole group -- the lander itself only ever gets a lander-pid-directed signal from an
# external sender; the group-directed variant Cybersec measured is a different threat than this
# selftest's harness can address without changing run_orphan_probe's shape) must now also kill the
# wrapped command's own child, proving the new HUP trap (_land_sig_stop HUP 129) is wired the same
# way as TERM and is not a no-op.
hup_result="$(run_orphan_probe HUP "$HUP_TRAP_SRC")"
case "$hup_result" in
  0) ok "HUP to the wrapper kills the wrapped command's own child too (no surviving orphan)" ;;
  NOGRANDCHILD) bad "grandchild never started in the HUP probe -- cannot test the regression" ;;
  *) bad "HUP left the wrapped command's child running as an orphan -- HUP trap not effective" ;;
esac

rm -f "$WRAPPED_CMD_SCRIPT"

echo "marveen-land.sh run_fg_killable selftest done"
[ "$fail" -eq 0 ] && echo "selftest: PASS" || echo "selftest: FAIL"
exit "$fail"
