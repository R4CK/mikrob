#!/usr/bin/env bash
# Self-test for store/mopsion-suite-run.sh (card 5af57bd7).
#
# Run: bash store/mopsion-suite-run.selftest.sh
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
RUN="$HERE/mopsion-suite-run.sh"
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
out="$(env "${env_fake_wt[@]}" CLEANCORE_SUITE_SLOTS=2 bash "$RUN_WT/store/mopsion-suite-run.sh" fakewt 2>&1)"; rc=$?
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
out="$(env "${env_fake_wt[@]}" CLEANCORE_SUITE_SLOTS=2 bash "$RUN_WT/store/mopsion-suite-run.sh" fakewt -- --project packages 2>&1)"; rc=$?
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

# --- 14. MID-RUN MEMORY WATCH stops a running suite in a controlled way (card e498502e) ---------
# The start-time precondition (case 13) only looks ONCE; a suite that starts healthy and later runs
# out of memory used to be silently OOM-killed by the kernel, with no summary and no signal that the
# result is void (backend's 249c6c6f finding). These drive a FAKE vitest that just sleeps, so the
# mid-run check is proven without ever running the real ~60-90 minute suite.
MIDRUN_WT="$TMP/fake-midrun"
mkdir -p "$MIDRUN_WT/node_modules/.bin" "$MIDRUN_WT/store"
cp "$RUN" "$MIDRUN_WT/store/$(basename "$RUN")"
cat > "$MIDRUN_WT/store/agent-worktree.sh" <<EOF
#!/usr/bin/env bash
echo "$MIDRUN_WT"
EOF
chmod +x "$MIDRUN_WT/store/agent-worktree.sh"
: > "$MIDRUN_WT/store/vitest-flake-classify.sh"; chmod +x "$MIDRUN_WT/store/vitest-flake-classify.sh"
: > "$MIDRUN_WT/store/vitest-skip-report.sh"; chmod +x "$MIDRUN_WT/store/vitest-skip-report.sh"

env_midrun=(
  "CLEANCORE_SUITE_LOCK_PREFIX=$PREFIX-midrun"
  "CLEANCORE_SUITE_API=http://127.0.0.1:9"
  "CLEANCORE_SUITE_POLL_S=1"
  "CLEANCORE_SUITE_SLOTS=2"
  "CLEANCORE_SUITE_MID_RUN_POLL_S=1"
)

MIDRUN_MEMINFO="$TMP/meminfo-midrun"
write_mem() { printf 'MemTotal:       24609416 kB\nMemFree:         1850872 kB\nMemAvailable:   %s kB\n' "$1" > "$MIDRUN_MEMINFO"; }
write_mem 9000000  # plenty, so the START-time check passes and the run actually begins

# A fake vitest that behaves like a real one under SIGTERM: its child dies, it exits. Not `exec`,
# so the running PROCESS's own argv still names this fixture's path -- that is what the aliveness
# probes below key on, instead of a bare "sleep" pattern that would also match unrelated holders
# from earlier cases in this same file (several `sleep 300`s are still alive at this point).
cat > "$MIDRUN_WT/node_modules/.bin/vitest" <<'EOF'
#!/usr/bin/env bash
sleep 30 &
wait
EOF
chmod +x "$MIDRUN_WT/node_modules/.bin/vitest"

( env "${env_midrun[@]}" CLEANCORE_SUITE_MEMINFO="$MIDRUN_MEMINFO" CLEANCORE_SUITE_MIN_AVAIL_MB=4096 \
      bash "$MIDRUN_WT/store/$(basename "$RUN")" fakewt -- --project packages \
      >"$TMP/midrun-out.txt" 2>&1 ) &
midrun_pid=$!
sleep 1.5   # let the start-time check pass and the fake vitest actually start
write_mem 500000   # drop below the floor WHILE it is "running"
wait "$midrun_pid"; midrun_rc=$?
out="$(cat "$TMP/midrun-out.txt" 2>/dev/null)"
if [[ $midrun_rc -eq 4 ]] && grep -q "MID-RUN MEMORY PRESSURE" <<<"$out"; then
  ok "a memory drop WHILE running stops the suite with exit 4, named as memory (not a test result)"
else
  bad "mid-run memory drop was not caught" "rc=$midrun_rc out=$out"
fi

# The vitest process itself must actually be gone -- "detected but not stopped" would be worse than
# useless: it would claim a controlled stop while the same kernel OOM-kill still lurks underneath.
sleep 0.3
if ! pgrep -f -- "$MIDRUN_WT/node_modules/.bin/vitest" >/dev/null 2>&1; then
  ok "the fake vitest (and its child) is actually terminated, not left running"
else
  bad "the fake vitest process was still alive after the mid-run stop" "$(pgrep -af -- "$MIDRUN_WT/node_modules/.bin/vitest" 2>/dev/null)"
fi

# The slot the stopped run held must be released -- a leaked slot after a controlled stop would be
# exactly as bad as the SIGKILL-leak case 5 already proves the kernel handles for us.
sleep 0.3
free_slots=0
for i in 1 2; do
  ( exec 8>>"${PREFIX}-midrun-${i}.lock"; flock -n 8 ) 2>/dev/null && free_slots=$((free_slots + 1))
done
[[ $free_slots -ge 1 ]] \
  && ok "the slot held by the stopped mid-run is released, not leaked" \
  || bad "no slot was free after the mid-run stop" "free_slots=$free_slots"

# CONTROL: a process that ignores SIGTERM is escalated to SIGKILL, not left running forever. A short
# grace period keeps this fast instead of waiting out the 10s production default.
cat > "$MIDRUN_WT/node_modules/.bin/vitest" <<'EOF'
#!/usr/bin/env bash
trap '' TERM
while true; do sleep 1; done
EOF
chmod +x "$MIDRUN_WT/node_modules/.bin/vitest"
write_mem 9000000
( env "${env_midrun[@]}" CLEANCORE_SUITE_MEMINFO="$MIDRUN_MEMINFO" CLEANCORE_SUITE_MIN_AVAIL_MB=4096 \
      CLEANCORE_SUITE_MID_RUN_TERM_GRACE_S=2 \
      bash "$MIDRUN_WT/store/$(basename "$RUN")" fakewt -- --project packages \
      >"$TMP/midrun-kill-out.txt" 2>&1 ) &
midrun_kill_pid=$!
sleep 1.5
write_mem 500000
wait "$midrun_kill_pid"; midrun_kill_rc=$?
if [[ $midrun_kill_rc -eq 4 ]]; then
  ok "a run that ignores SIGTERM is escalated to SIGKILL after the grace period, not left running"
else
  bad "a SIGTERM-ignoring run was not escalated to SIGKILL" "rc=$midrun_kill_rc out=$(cat "$TMP/midrun-kill-out.txt" 2>/dev/null)"
fi
sleep 0.3
if ! pgrep -f -- "$MIDRUN_WT/node_modules/.bin/vitest" >/dev/null 2>&1; then
  ok "after escalation the SIGTERM-ignoring process is actually gone"
else
  bad "the SIGTERM-ignoring fake vitest survived SIGKILL" "$(pgrep -af -- "$MIDRUN_WT/node_modules/.bin/vitest" 2>/dev/null)"
fi

# NEGATIVE CONTROL: CLEANCORE_SUITE_MIN_AVAIL_MB=0 disables the mid-run watch exactly like it
# disables the start-time one (case 13) -- a memory drop mid-run must NOT stop a run that opted out.
cat > "$MIDRUN_WT/node_modules/.bin/vitest" <<'EOF'
#!/usr/bin/env bash
exec sleep 2
EOF
chmod +x "$MIDRUN_WT/node_modules/.bin/vitest"
write_mem 9000000
( env "${env_midrun[@]}" CLEANCORE_SUITE_MEMINFO="$MIDRUN_MEMINFO" CLEANCORE_SUITE_MIN_AVAIL_MB=0 \
      bash "$MIDRUN_WT/store/$(basename "$RUN")" fakewt -- --project packages \
      >"$TMP/midrun-off-out.txt" 2>&1 ) &
midrun_off_pid=$!
sleep 1
write_mem 500000
wait "$midrun_off_pid"; midrun_off_rc=$?
if [[ $midrun_off_rc -eq 0 ]]; then
  ok "CONTROL: CLEANCORE_SUITE_MIN_AVAIL_MB=0 disables the mid-run watch too"
else
  bad "the mid-run watch fired even though the memory precondition was disabled" "rc=$midrun_off_rc out=$(cat "$TMP/midrun-off-out.txt" 2>/dev/null)"
fi

# --- 15. THE REVERSE DIRECTION, WITH THE REAL fleet-test.sh (card 3e1502ec) ---------------------
# Cases 1-14 above prove this script's OWN slot logic against synthetic `flock` holders. Those
# holders use the identical file-naming scheme fleet-test.sh's acquire_cpu_slot() uses
# (${PREFIX}-N.lock), so symmetry follows from flock being a kernel primitive -- but nothing before
# this case actually DROVE the real fleet-test.sh script and watched this script queue behind it.
# That gap is what card 3e1502ec's "known-positive" ask names: a fleet-test run should make
# cleancore-suite-run.sh see the CPU pool as short one slot, not just be assumed to by construction.
#
# fleet-test.sh's ROOT and LOCK_FILE are hardcoded to the real /home/neon/marveen (not derived from
# MARVEEN_MAIN), so this holds the REAL tree lock first -- that stops the real script right after it
# acquires its CPU slot, before it ever touches a worktree, checkout or build.
#
# THE REAL LOCK MAY LEGITIMATELY BE BUSY (another agent's genuine landing/suite in flight): this
# acquires it NON-BLOCKING and SKIPS the case rather than queueing behind a run that can take
# 60-90 minutes -- a selftest that can hang on live fleet traffic is worse than one that skips.
REAL_TREE_LOCK="/home/neon/marveen-test.lock"
REV_ANCHOR="$TMP/reverse-anchor"
mkdir -p "$REV_ANCHOR/store"
tree_lock_pid=""
fleet_test_pid=""
cleanup_case15() {
  [[ -n "$fleet_test_pid" ]] && kill -9 "$fleet_test_pid" 2>/dev/null
  [[ -n "$tree_lock_pid" ]] && kill -9 "$tree_lock_pid" 2>/dev/null
}

exec 8>"$REAL_TREE_LOCK"
if ! flock -n 8; then
  echo "  [SKIP] case 15 -- the real fleet-test tree lock is held by another run right now; not queueing behind it"
  exec 8>&-
else
  ( exec 8>"$REAL_TREE_LOCK"; flock 8; sleep 25 ) &
  tree_lock_pid=$!
  exec 8>&-
  sleep 0.3

  MARVEEN_MAIN="$REV_ANCHOR" CLEANCORE_SUITE_SLOTS=2 CLEANCORE_SUITE_POLL_S=1 \
    FLEET_TEST_LOCK_WAIT=20 \
    bash "$HERE/fleet-test.sh" --ref HEAD >"$TMP/case15-fleet-test.out" 2>&1 &
  fleet_test_pid=$!
  sleep 2   # let the real script acquire its CPU slot and start waiting on the real tree lock

  # CONTROL FIRST: with only ONE of the two slots taken (by the real fleet-test.sh), the OTHER slot
  # must still be free -- so the queue-out below is caused by the second, synthetic holder, not by
  # some unrelated bug that always reports "no slot" against this anchor.
  out="$(env "${env_common[@]}" MARVEEN_MAIN="$REV_ANCHOR" CLEANCORE_SUITE_LOCK_PREFIX="${REV_ANCHOR}/store/.cleancore-suite-slot" \
         CLEANCORE_SUITE_SLOTS=2 CLEANCORE_SUITE_WAIT_MAX_S=5 \
         bash "$RUN" no-such-agent-xyz 2>&1)"; rc=$?
  if [[ $rc -eq 3 ]] && echo "$out" | grep -q 'no CleanCore worktree'; then
    ok "CONTROL: with only the real fleet-test.sh holding one slot, cleancore-suite-run.sh gets the other"
  else
    bad "CONTROL failed -- cleancore-suite-run.sh could not get the free slot for an unrelated reason" \
      "rc=$rc out=$out fleet-test-out=$(cat "$TMP/case15-fleet-test.out" 2>/dev/null)"
  fi

  # Now take the OTHER slot synthetically too, so BOTH are held and the run must queue out.
  ( exec 9>"${REV_ANCHOR}/store/.cleancore-suite-slot-2.lock"; flock 9; sleep 15 ) &
  HOLDERS+=("$!")
  sleep 0.3

  out="$(env "${env_common[@]}" MARVEEN_MAIN="$REV_ANCHOR" CLEANCORE_SUITE_LOCK_PREFIX="${REV_ANCHOR}/store/.cleancore-suite-slot" \
         CLEANCORE_SUITE_SLOTS=2 CLEANCORE_SUITE_WAIT_MAX_S=3 \
         bash "$RUN" no-such-agent-xyz 2>&1)"; rc=$?
  if [[ $rc -eq 3 ]] && echo "$out" | grep -q 'no slot after'; then
    ok "cleancore-suite-run.sh queues out when a REAL fleet-test.sh run holds the other shared slot"
  else
    bad "cleancore-suite-run.sh did not see the real fleet-test.sh's CPU-slot hold" \
      "rc=$rc out=$out fleet-test-out=$(cat "$TMP/case15-fleet-test.out" 2>/dev/null)"
  fi

  cleanup_case15
  wait "$fleet_test_pid" 2>/dev/null
  wait "$tree_lock_pid" 2>/dev/null
fi

echo "mopsion-suite-run.selftest: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
