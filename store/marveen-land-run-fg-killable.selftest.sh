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

echo "marveen-land.sh run_fg_killable selftest done"
[ "$fail" -eq 0 ] && echo "selftest: PASS" || echo "selftest: FAIL"
exit "$fail"
