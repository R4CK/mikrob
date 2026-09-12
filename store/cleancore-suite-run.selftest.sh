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

# --- 9. THE SEMAPHORE IS FLEET-WIDE, NOT PER-CHECKOUT (card 5af57bd7, Cybered NO-GO) ------------
#
# The defect this pins: LOCK_PREFIX used to default to the script's OWN directory, and every agent
# runs its own marveen worktree copy. Each checkout therefore locked its own files and the cap was 2
# PER CHECKOUT -- 16 checkouts x 2 = up to 32 concurrent suites, the exact state this script exists
# to prevent. Nothing in the previous eight cases could see it: they all pass an explicit
# CLEANCORE_SUITE_LOCK_PREFIX, which is precisely the variable that masks the bug.
#
# So this case runs the script from TWO DIFFERENT directories with NO prefix override, exactly as
# two agents would, and asserts they contend. MARVEEN_MAIN points at a temp anchor so the real
# fleet's slot files are never touched.
ANCHOR="$TMP/anchor"
mkdir -p "$ANCHOR/store" "$TMP/co-a/store" "$TMP/co-b/store"
cp "$RUN" "$TMP/co-a/store/" && cp "$RUN" "$TMP/co-b/store/"
COPY_A="$TMP/co-a/store/$(basename "$RUN")"
COPY_B="$TMP/co-b/store/$(basename "$RUN")"

# Hold both slots on the ANCHOR -- the location a correct default must resolve to.
( exec 9>"$ANCHOR/store/.cleancore-suite-slot-1.lock"; flock 9; sleep 300 ) & HOLDERS+=("$!")
( exec 9>"$ANCHOR/store/.cleancore-suite-slot-2.lock"; flock 9; sleep 300 ) & HOLDERS+=("$!")
sleep 0.5

for co in A B; do
  copy="$COPY_A"; [[ $co == B ]] && copy="$COPY_B"
  out="$(env MARVEEN_MAIN="$ANCHOR" CLEANCORE_SUITE_API=http://127.0.0.1:9 \
         CLEANCORE_SUITE_POLL_S=1 CLEANCORE_SUITE_WAIT_MAX_S=3 \
         bash "$copy" no-such-agent-xyz 2>&1)"; rc=$?
  if [[ $rc -eq 3 ]] && echo "$out" | grep -q 'no slot after'; then
    ok "checkout $co resolves to the SHARED anchor and queues (not its own copy's directory)"
  else
    bad "checkout $co did NOT contend -- the lock path is per-checkout again" "rc=$rc out=$out"
  fi
done

# NEGATIVE CONTROL: reintroduce the old behaviour by pointing each copy at its own directory. If
# this did NOT sail through, the case above would be passing for some unrelated reason and would not
# actually be measuring the anchor.
out="$(env CLEANCORE_SUITE_LOCK_PREFIX="$TMP/co-b/store/.cleancore-suite-slot" \
       CLEANCORE_SUITE_API=http://127.0.0.1:9 CLEANCORE_SUITE_POLL_S=1 CLEANCORE_SUITE_WAIT_MAX_S=3 \
       bash "$COPY_B" no-such-agent-xyz 2>&1)"; rc=$?
if [[ $rc -eq 3 ]] && echo "$out" | grep -q 'no CleanCore worktree'; then
  ok "negative control: a PER-CHECKOUT prefix does not contend -- so case 9 measures the anchor"
else
  bad "negative control did not reproduce the old behaviour" "rc=$rc out=$out"
fi

# --- 10. an unusable lock directory is LOUD, not "busy" ----------------------------------------
# Without this the script would fail to create each slot file, report no slot, and queue for the
# full cap -- an unreachable semaphore indistinguishable from a genuinely busy one, which is the
# same class of defect as the anchor bug.
out="$(env MARVEEN_MAIN="$TMP/definitely-not-a-directory" CLEANCORE_SUITE_API=http://127.0.0.1:9 \
       bash "$RUN" no-such-agent-xyz 2>&1)"; rc=$?
if [[ $rc -eq 2 ]] && echo "$out" | grep -q 'not writable'; then
  ok "a missing lock directory exits 2 with a named reason, instead of queueing silently"
else
  bad "an unusable lock dir was not reported" "rc=$rc out=$out"
fi

# --- 11. a single run must not be able to claim every core (card 34587175) ---------------------
# The slot semaphore bounds concurrent RUNS, but vitest defaults --maxWorkers to nproc, so one run
# alone already saturates the box (measured: 12 vitest processes on 12 cores, load average 16-20).
# This drives the script all the way to the vitest invocation with a FAKE vitest binary that just
# records its argv, since the earlier cases stop at the worktree-resolution step on purpose.
RUN_WT="$TMP/fake-run"
mkdir -p "$RUN_WT/node_modules/.bin" "$RUN_WT/store"
FAKE_RUN="$RUN_WT/store/$(basename "$RUN")"
cp "$RUN" "$FAKE_RUN"
cat > "$RUN_WT/store/agent-worktree.sh" <<EOF
#!/usr/bin/env bash
echo "$RUN_WT"
EOF
chmod +x "$RUN_WT/store/agent-worktree.sh"
# The real script best-effort-sources these two helpers; empty no-op stand-ins keep the run quiet.
: > "$RUN_WT/store/vitest-flake-classify.sh"; chmod +x "$RUN_WT/store/vitest-flake-classify.sh"
: > "$RUN_WT/store/vitest-skip-report.sh"; chmod +x "$RUN_WT/store/vitest-skip-report.sh"
ARGV_CAPTURE="$TMP/vitest-argv.txt"
# Per-invocation capture, ADDED for the api-e2e split (card cae9fb67): the script now calls vitest
# TWICE when the caller picked no projects. $ARGV_CAPTURE keeps its old meaning -- the LAST
# invocation -- so every assertion written before the split still measures exactly what it did.
ARGV_DIR="$TMP/vitest-argv-runs"; mkdir -p "$ARGV_DIR"
ARGV_COUNT="$TMP/vitest-argv-count.txt"
cat > "$RUN_WT/node_modules/.bin/vitest" <<EOF
#!/usr/bin/env bash
n=\$(( \$(cat "$ARGV_COUNT" 2>/dev/null || echo 0) + 1 ))
printf '%s' "\$n" > "$ARGV_COUNT"
printf '%s\n' "\$@" > "$ARGV_DIR/run-\$n.txt"
printf '%s\n' "\$@" > "$ARGV_CAPTURE"
exit 0
EOF
chmod +x "$RUN_WT/node_modules/.bin/vitest"

env_fake_wt=(
  "CLEANCORE_SUITE_LOCK_PREFIX=$PREFIX-fakewt"
  "CLEANCORE_SUITE_API=http://127.0.0.1:9"
  "CLEANCORE_SUITE_POLL_S=1"
)

: > "$ARGV_CAPTURE"
out="$(env "${env_fake_wt[@]}" CLEANCORE_SUITE_SLOTS=2 bash "$FAKE_RUN" some-agent 2>&1)"; rc=$?
expect_default=$(( $(nproc 2>/dev/null || echo 1) / 2 )); [ "$expect_default" -lt 1 ] && expect_default=1
if [[ $rc -eq 0 ]] && grep -qx -- "--maxWorkers=$expect_default" "$ARGV_CAPTURE"; then
  ok "no caller override -> vitest gets --maxWorkers=$expect_default (nproc/SLOTS, floor 1)"
else
  bad "default --maxWorkers not passed as expected ($expect_default)" "rc=$rc out=$out argv=$(cat "$ARGV_CAPTURE" 2>/dev/null)"
fi

: > "$ARGV_CAPTURE"
out="$(env "${env_fake_wt[@]}" CLEANCORE_SUITE_MAX_WORKERS=7 CLEANCORE_SUITE_SLOTS=2 \
       bash "$FAKE_RUN" some-agent 2>&1)"; rc=$?
if [[ $rc -eq 0 ]] && grep -qx -- "--maxWorkers=7" "$ARGV_CAPTURE"; then
  ok "CLEANCORE_SUITE_MAX_WORKERS overrides the computed default"
else
  bad "CLEANCORE_SUITE_MAX_WORKERS override was not honoured" "rc=$rc out=$out argv=$(cat "$ARGV_CAPTURE" 2>/dev/null)"
fi

# --- 12. a caller-supplied --maxWorkers is never clobbered by the default ------------------------
: > "$ARGV_CAPTURE"
out="$(env "${env_fake_wt[@]}" CLEANCORE_SUITE_SLOTS=2 \
       bash "$FAKE_RUN" some-agent -- --maxWorkers=3 2>&1)"; rc=$?
occurrences="$(grep -c -- '--maxWorkers' "$ARGV_CAPTURE" 2>/dev/null || echo 0)"
if [[ $rc -eq 0 ]] && [ "$occurrences" = "1" ] && grep -qx -- "--maxWorkers=3" "$ARGV_CAPTURE"; then
  ok "a caller-supplied --maxWorkers passes through untouched, exactly once"
else
  bad "caller override was duplicated or dropped" "rc=$rc occurrences=$occurrences argv=$(cat "$ARGV_CAPTURE" 2>/dev/null)"
fi

echo

# --- the api-e2e project runs in its OWN vitest process (card cae9fb67) -----------------------
# In one combined invocation its 66 files VANISH from the report and the run ends with a single
# "[vitest-worker]: Timeout calling onTaskUpdate" -- measured on api-e2e+packages (748 files) and
# on the full four-project run, twice, including on an idle box. Splitting it out is the fix, and
# these cases pin that the split actually happens and stays off the caller's own project choice.
reset_argv() { : > "$ARGV_CAPTURE"; rm -f "$ARGV_DIR"/run-*.txt; : > "$ARGV_COUNT"; }

reset_argv
out="$(env "${env_fake_wt[@]}" CLEANCORE_SUITE_SLOTS=2 bash "$RUN_WT/store/cleancore-suite-run.sh" fakewt 2>&1)"; rc=$?
runs="$(cat "$ARGV_COUNT" 2>/dev/null || echo 0)"
if [[ $rc -eq 0 && "$runs" == "2" ]] \
   && grep -qx -- '!api-e2e' "$ARGV_DIR/run-1.txt" && grep -qx -- '--project' "$ARGV_DIR/run-1.txt" \
   && grep -qx -- 'api-e2e' "$ARGV_DIR/run-2.txt" && grep -qx -- '--project' "$ARGV_DIR/run-2.txt"; then
  ok "no caller --project -> TWO runs: everything but api-e2e, then api-e2e alone"
else
  bad "the api-e2e split did not happen" "rc=$rc runs=$runs run1=$(cat "$ARGV_DIR/run-1.txt" 2>/dev/null | tr '\n' ' ') run2=$(cat "$ARGV_DIR/run-2.txt" 2>/dev/null | tr '\n' ' ')"
fi

# The negation, not a hand-listed project set: adding a project to vitest.config.ts must not
# silently start skipping it.
if grep -qx -- '!api-e2e' "$ARGV_DIR/run-1.txt" 2>/dev/null; then
  ok "the main run EXCLUDES by negation, so a new project is included without editing this script"
else
  bad "the main run does not use the !api-e2e negation" "run1=$(cat "$ARGV_DIR/run-1.txt" 2>/dev/null | tr '\n' ' ')"
fi

reset_argv
out="$(env "${env_fake_wt[@]}" CLEANCORE_SUITE_SLOTS=2 bash "$RUN_WT/store/cleancore-suite-run.sh" fakewt -- --project packages 2>&1)"; rc=$?
runs="$(cat "$ARGV_COUNT" 2>/dev/null || echo 0)"
if [[ $rc -eq 0 && "$runs" == "1" ]] && ! grep -qx -- '!api-e2e' "$ARGV_CAPTURE"; then
  ok "a caller that named its own --project gets ONE run, unsplit and untouched"
else
  bad "a caller-supplied --project was overridden by the split" "rc=$rc runs=$runs argv=$(cat "$ARGV_CAPTURE" 2>/dev/null | tr '\n' ' ')"
fi

# --- 13. THE MEMORY PRECONDITION (card 7e7ac40c) ------------------------------------------------
# backend3's finding: a full suite was OOM-killed BEFORE STARTING with 474 MB available of 24032 MB.
# The slot cap never looked at memory. Measured on one full run (806 samples at 5s): a suite peaks
# at 3153 MB of vitest RSS, so the precondition is an absolute floor, not a reservation scheme.
#
# /proc/meminfo is injected, so these cases assert the DECISION rather than the box's mood -- a test
# that waits for the real machine to be full would never run, and one that passes because the box
# happens to be empty proves nothing.
fake_meminfo() { # $1 = MemAvailable in kB
  local f="$TMP/meminfo-$1"
  printf 'MemTotal:       24609416 kB
MemFree:         1850872 kB
MemAvailable:   %s kB
' "$1" > "$f"
  echo "$f"
}

# A free slot AND enough memory -> acquired (proved by the no-worktree exit-3 message).
out="$(env "${env_common[@]}" CLEANCORE_SUITE_WAIT_MAX_S=5 \
       CLEANCORE_SUITE_MEMINFO="$(fake_meminfo 9000000)" CLEANCORE_SUITE_MIN_AVAIL_MB=4096 \
       bash "$RUN" no-such-agent-xyz 2>&1)"; rc=$?
if [[ $rc -eq 3 ]] && grep -q "no CleanCore worktree" <<<"$out"; then
  ok "enough memory -> the slot is taken and the run proceeds"
else
  bad "a run with 8789MB available was not allowed to start" "rc=$rc out=$out"
fi

# Below the floor -> queued out, and the message must say MEMORY, not slots. Naming the wrong
# reason here is not cosmetic: it points the reader at CLEANCORE_SUITE_SLOTS, and raising the slot
# cap makes a memory shortage worse.
out="$(env "${env_common[@]}" CLEANCORE_SUITE_WAIT_MAX_S=2 \
       CLEANCORE_SUITE_MEMINFO="$(fake_meminfo 500000)" CLEANCORE_SUITE_MIN_AVAIL_MB=4096 \
       bash "$RUN" no-such-agent-xyz 2>&1)"; rc=$?
if [[ $rc -eq 3 ]] && grep -q "not enough memory" <<<"$out" && ! grep -q "no slot after" <<<"$out"; then
  ok "below the floor -> refuses to start, and names MEMORY as the reason"
else
  bad "a memory shortage was not reported as one" "rc=$rc out=$out"
fi

# THE CONTROL that stops the case above from passing for the wrong reason: the same 488MB box with
# the precondition switched off must sail through. Without this, a script that refused everything
# would satisfy the test above.
out="$(env "${env_common[@]}" CLEANCORE_SUITE_WAIT_MAX_S=5 \
       CLEANCORE_SUITE_MEMINFO="$(fake_meminfo 500000)" CLEANCORE_SUITE_MIN_AVAIL_MB=0 \
       bash "$RUN" no-such-agent-xyz 2>&1)"; rc=$?
if [[ $rc -eq 3 ]] && grep -q "no CleanCore worktree" <<<"$out"; then
  ok "CONTROL: MIN_AVAIL_MB=0 disables the precondition on the very box that tripped it"
else
  bad "the memory precondition could not be switched off" "rc=$rc out=$out"
fi

# A WAITING RUN MUST NOT HOLD A SLOT. If it did, a memory shortage would become a slot shortage for
# every peer -- including one that has room. Both slots must still be free while a run queues on
# memory, which a plain flock -n can prove.
# ON ITS OWN PREFIX. Cases 3-5 above leave live flock holders on $PREFIX for the whole run (they
# sleep until cleanup), so probing the shared prefix here would measure THOSE and report a slot this
# case never touched -- measured: 1 of 2 free, with the waiter holding nothing.
MEMPREFIX="$TMP/memslot"
( env "CLEANCORE_SUITE_LOCK_PREFIX=$MEMPREFIX" "CLEANCORE_SUITE_API=http://127.0.0.1:9" \
    CLEANCORE_SUITE_POLL_S=1 CLEANCORE_SUITE_WAIT_MAX_S=8 CLEANCORE_SUITE_SLOTS=2 \
    CLEANCORE_SUITE_MEMINFO="$(fake_meminfo 500000)" CLEANCORE_SUITE_MIN_AVAIL_MB=4096 \
    bash "$RUN" no-such-agent-xyz >/dev/null 2>&1 ) &
mem_waiter=$!
HOLDERS+=("$mem_waiter")
sleep 2
free_slots=0
for i in 1 2; do
  ( exec 8>>"${MEMPREFIX}-${i}.lock"; flock -n 8 ) 2>/dev/null && free_slots=$((free_slots+1))
done
kill -9 "$mem_waiter" 2>/dev/null
if [[ $free_slots -eq 2 ]]; then
  ok "a run queueing on MEMORY holds no slot -- peers with room are not blocked"
else
  bad "a memory-blocked run was sitting on a slot" "free_slots=$free_slots of 2"
fi

# UNREADABLE MEMORY MUST FAIL OPEN, AND SAY SO. A guard that refused every run on a box whose
# /proc/meminfo it cannot parse would stop every gate on that machine -- worse than the OOM it
# prevents, which is at least loud. Silence would be the real defect, so the warning is asserted.
out="$(env "${env_common[@]}" CLEANCORE_SUITE_WAIT_MAX_S=5 \
       CLEANCORE_SUITE_MEMINFO="$TMP/no-such-meminfo" CLEANCORE_SUITE_MIN_AVAIL_MB=4096 \
       bash "$RUN" no-such-agent-xyz 2>&1)"; rc=$?
if [[ $rc -eq 3 ]] && grep -q "cannot read MemAvailable" <<<"$out" && grep -q "no CleanCore worktree" <<<"$out"; then
  ok "unreadable meminfo -> runs anyway, and warns that it did"
else
  bad "an unreadable meminfo was silent, or blocked the run" "rc=$rc out=$out"
fi

# MemFree IS NOT THE FIELD. Measured on the real box in one instant: MemFree 1807 MB, MemAvailable
# 15221 MB -- 14.7 GB of reclaimable page cache between them. A guard reading MemFree would refuse
# nearly every run that fits comfortably, so this fixture pins which line is read.
out="$(env "${env_common[@]}" CLEANCORE_SUITE_WAIT_MAX_S=5 \
       CLEANCORE_SUITE_MEMINFO="$(fake_meminfo 9000000)" CLEANCORE_SUITE_MIN_AVAIL_MB=4096 \
       bash "$RUN" no-such-agent-xyz 2>&1)"; rc=$?
if [[ $rc -eq 3 ]] && grep -q "no CleanCore worktree" <<<"$out"; then
  ok "reads MemAvailable, not MemFree (the fixture's MemFree is far below the floor)"
else
  bad "the guard appears to be reading MemFree" "rc=$rc out=$out"
fi

echo "cleancore-suite-run.selftest: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
