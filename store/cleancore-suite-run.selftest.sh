#!/usr/bin/env bash
# Self-test for store/cleancore-suite-run.sh (card 5af57bd7).
#
# Run: bash store/cleancore-suite-run.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
#
# HERMETIC: never runs the real suite (60-90 minutes) and never posts to the real board. Slots are
# held by plain `flock` holders under a temp prefix, and the API is pointed at a closed port so the
# best-effort comment path takes its failure branch -- which is itself worth exercising, since a
# comment must never be able to fail a test run.
#
# The probe for "did it get a slot" is an agent name with no worktree: the script acquires FIRST and
# only then resolves the worktree, so exit 3 with the worktree message proves acquisition, without
# starting vitest. The two exit-3 reasons are told apart by their stderr text, deliberately -- an
# exit code alone would make "queued out" and "acquired but nowhere to run" the same observation.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/cleancore-suite-run.sh"
pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

TMP="$(mktemp -d)"
PREFIX="$TMP/slot"
HOLDERS=()
cleanup() { for p in "${HOLDERS[@]:-}"; do [ -n "$p" ] && kill -9 "$p" 2>/dev/null; done; rm -rf "$TMP"; }
trap cleanup EXIT

# Common env: temp slots, a closed port for the API, no waiting to speak of.
env_common=(
  "CLEANCORE_SUITE_LOCK_PREFIX=$PREFIX"
  "CLEANCORE_SUITE_API=http://127.0.0.1:9"      # discard port: always refused, never hangs
  "CLEANCORE_SUITE_POLL_S=1"
)

hold_slot() { # $1 = slot number -- takes it and sleeps until killed
  ( exec 9>"${PREFIX}-${1}.lock"; flock 9; sleep 300 ) &
  HOLDERS+=("$!")
  sleep 0.5
}

# --- 1. usage --------------------------------------------------------------------------------
bash "$RUN" >/dev/null 2>&1; rc=$?
[[ $rc -eq 2 ]] && ok "no agent -> exit 2 (usage)" || bad "no-agent exit $rc, want 2"

# --- 2. a FREE slot is taken, and taken SILENTLY ----------------------------------------------
# The routine case must not comment: a notice that fires on healthy traffic is one people learn to
# skip. Proven by the absence of the queueing line, with acquisition proven by the worktree error.
out="$(env "${env_common[@]}" CLEANCORE_SUITE_WAIT_MAX_S=5 bash "$RUN" no-such-agent-xyz 2>&1)"; rc=$?
if [[ $rc -eq 3 ]] && echo "$out" | grep -q 'no CleanCore worktree'; then
  ok "a free slot is acquired (reached the worktree step)"
else
  bad "did not acquire a free slot" "rc=$rc out=$out"
fi
echo "$out" | grep -q 'queueing' \
  && bad "it announced queueing while a slot was FREE" "$out" \
  || ok "the routine case is silent -- no queueing notice when a slot is free"

# --- 3. SLOTS is respected: all busy -> queue, then give up with a distinguishable reason -------
hold_slot 1; hold_slot 2
out="$(env "${env_common[@]}" CLEANCORE_SUITE_SLOTS=2 CLEANCORE_SUITE_WAIT_MAX_S=3 \
       bash "$RUN" no-such-agent-xyz 2>&1)"; rc=$?
if [[ $rc -eq 3 ]] && echo "$out" | grep -q 'no slot after'; then
  ok "all slots busy -> waits, then gives up with the SLOT reason (not the worktree one)"
else
  bad "queue-out did not happen or was indistinguishable" "rc=$rc out=$out"
fi
echo "$out" | grep -q 'slots busy -- queueing' \
  && ok "waiting is ANNOUNCED, so a waiter is not silent" \
  || bad "no queueing announcement" "$out"

# --- 4. a THIRD slot exists when SLOTS says so -------------------------------------------------
# The count is the parameter, not a hardcoded 2: raising it must actually admit another run.
out="$(env "${env_common[@]}" CLEANCORE_SUITE_SLOTS=3 CLEANCORE_SUITE_WAIT_MAX_S=3 \
       bash "$RUN" no-such-agent-xyz 2>&1)"; rc=$?
if [[ $rc -eq 3 ]] && echo "$out" | grep -q 'no CleanCore worktree'; then
  ok "SLOTS=3 admits a run while 2 are held (the count is honoured, not hardcoded)"
else
  bad "SLOTS was not honoured" "rc=$rc out=$out"
fi

# --- 5. a KILLED holder releases its slot -------------------------------------------------------
# This is why the lock is on a file descriptor rather than file content: two of the four runs that
# motivated this card were killed outright, and a leaked slot would have needed a stale sweeper.
kill -9 "${HOLDERS[0]}" 2>/dev/null; wait "${HOLDERS[0]}" 2>/dev/null; sleep 0.3
out="$(env "${env_common[@]}" CLEANCORE_SUITE_SLOTS=2 CLEANCORE_SUITE_WAIT_MAX_S=3 \
       bash "$RUN" no-such-agent-xyz 2>&1)"; rc=$?
if [[ $rc -eq 3 ]] && echo "$out" | grep -q 'no CleanCore worktree'; then
  ok "a SIGKILLed holder's slot is released by the kernel -- no stale-lock sweeper needed"
else
  bad "slot not released after the holder was killed" "rc=$rc out=$out"
fi

# --- 6. an unreachable dashboard must not break anything ---------------------------------------
# Every case above ran with the API pointed at the discard port, so the comment path took its
# failure branch each time and nothing above failed because of it. Stated as its own case so the
# property is named rather than merely incidental.
ok "comments are best-effort: every case above ran with the API unreachable"

echo
echo "cleancore-suite-run.selftest: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
