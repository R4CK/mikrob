#!/usr/bin/env bash
# test-tmp-sweep.selftest.sh -- pins the behaviour of store/test-tmp-sweep.sh (card a4a6a5e5)
# against a FAKE source tree and a FAKE target dir, so it never touches the real /tmp.
#
# Cases 6-10 were added after CYBERSEC NO-GO (comment 17088, B1-B4) and QA2 FAIL (comment 17090,
# reversed-base prefix leak) on Gate-SHA 877766dc -- each pins one of those findings red-then-green
# against the fixed script.
# Case 11 was added after CYBERED NO-GO (comment 17221, B5) on Gate-SHA 6e71b5f5: pins that
# 50 candidates complete in under 10 seconds (snapshot-based scan, not per-pid*fd fork loop).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWEEP="$HERE/test-tmp-sweep.sh"
fail=0

FAKE_ROOT="$(mktemp -d)"
trap 'rm -rf "$FAKE_ROOT"' EXIT

FAKE_SRC="$FAKE_ROOT/src"
FAKE_TARGET="$FAKE_ROOT/tmp"
mkdir -p "$FAKE_SRC" "$FAKE_TARGET"

# Fixture declares: two normal tmpdir()-based prefixes (single- and double-quoted); a prefix too
# short to qualify (ab-, QA2/B4); and a prefix whose join() base is NOT tmpdir() (wrongbase-, the
# QA2 17090 reversed-base leak) -- that one must NEVER be extracted.
cat > "$FAKE_SRC/fixture.test.ts" <<'EOF'
const dir = mkdtempSync(join(tmpdir(), 'known-leak-'))
const other = mkdtempSync(join(tmpdir(), "known-other-"))
const short = mkdtempSync(join(tmpdir(), 'ab-'))
const wrongBase = mkdtempSync(join(OTHER_SCRATCH_BASE, 'wrongbase-'))
const live = mkdtempSync(join(tmpdir(), 'known-live-'))
EOF

run_sweep() {
  env \
    "TEST_TMP_SWEEP_SRC=$FAKE_SRC" \
    "TEST_TMP_SWEEP_TARGET_DIR=$FAKE_TARGET" \
    "TEST_TMP_SWEEP_MIN_AGE_MIN=${TEST_TMP_SWEEP_MIN_AGE_MIN_OVERRIDE:-60}" \
    "TEST_TMP_SWEEP_LOCKFILE=$FAKE_ROOT/sweep.lock" \
    bash "$SWEEP" "$@"
}

reset_target() {
  rm -rf "$FAKE_TARGET"
  mkdir -p "$FAKE_TARGET"
}

touch_old() {
  mkdir -p "$1"
  touch -d '2 hours ago' "$1"
}

# --- case 1: a known-prefix, old entry IS removed -----------------------------------------
reset_target
touch_old "$FAKE_TARGET/known-leak-abc123"
run_sweep > /dev/null 2>&1
if [ ! -e "$FAKE_TARGET/known-leak-abc123" ]; then
  echo "  ok   a known-prefix, old entry is removed"
else
  echo "  FAIL a known-prefix, old entry survived the sweep"; fail=1
fi

# --- case 2: an UNKNOWN-prefix, old entry is NEVER touched (only declared prefixes qualify) -
reset_target
touch_old "$FAKE_TARGET/totally-unrelated-abc123"
run_sweep > /dev/null 2>&1
if [ -e "$FAKE_TARGET/totally-unrelated-abc123" ]; then
  echo "  ok   an entry with no matching declared prefix is left alone"
else
  echo "  FAIL an unrelated entry was removed -- prefix filter is not restrictive enough"; fail=1
fi

# --- case 3: a known-prefix, RECENT entry (an active run) is never touched -----------------
reset_target
mkdir -p "$FAKE_TARGET/known-leak-recent"
run_sweep > /dev/null 2>&1
if [ -e "$FAKE_TARGET/known-leak-recent" ]; then
  echo "  ok   a known-prefix entry younger than the age guard survives (never touches an active run)"
else
  echo "  FAIL a fresh entry was removed -- the age guard did not hold"; fail=1
fi

# --- case 4: --dry-run never deletes anything, even a qualifying entry --------------------
reset_target
touch_old "$FAKE_TARGET/known-other-xyzabc"
run_sweep --dry-run > /dev/null 2>&1
if [ -e "$FAKE_TARGET/known-other-xyzabc" ]; then
  echo "  ok   --dry-run reports without deleting"
else
  echo "  FAIL --dry-run deleted an entry"; fail=1
fi

# --- case 5: the double-quoted mkdtempSync declaration is picked up too -------------------
reset_target
touch_old "$FAKE_TARGET/known-other-xyz2ab"
run_sweep > /dev/null 2>&1
if [ ! -e "$FAKE_TARGET/known-other-xyz2ab" ]; then
  echo "  ok   a double-quoted mkdtempSync prefix is extracted and matched"
else
  echo "  FAIL the double-quoted-declared prefix was not removed"; fail=1
fi

# --- case 6 (QA2 17090): a prefix whose join() base is NOT tmpdir()/os.tmpdir() is never ----
# --- extracted, even though the text itself looks like a perfectly normal prefix -----------
reset_target
touch_old "$FAKE_TARGET/wrongbase-abc123"
run_sweep > /dev/null 2>&1
if [ -e "$FAKE_TARGET/wrongbase-abc123" ]; then
  echo "  ok   a prefix declared against a non-tmpdir() base is never extracted (reversed-base leak closed)"
else
  echo "  FAIL wrongbase- was extracted despite a non-tmpdir() join() base"; fail=1
fi

# --- case 7 (B4): a prefix shorter than the minimum length is never extracted ---------------
reset_target
touch_old "$FAKE_TARGET/ab-abc123"
run_sweep > /dev/null 2>&1
if [ -e "$FAKE_TARGET/ab-abc123" ]; then
  echo "  ok   a too-short declared prefix (ab-) is never extracted"
else
  echo "  FAIL ab- was extracted despite being under the minimum prefix length"; fail=1
fi

# --- case 8 (B1): a quote/shell-metacharacter-bearing name is left alone and never executes ---
# --- an injected command (the eval-based removal this pins against is gone). The payload is a
# BARE relative marker name, no slash -- a filename can never contain '/', so a realistic
# injection payload (like the real B1 repro) relies on the sweep's CWD at runtime, not an
# embedded absolute path. Run from a dedicated scratch cwd so the marker has an unambiguous home.
reset_target
SCRATCH_CWD="$FAKE_ROOT/scratch-cwd"
mkdir -p "$SCRATCH_CWD"
INJECT_NAME="known-leak-x';touch PWNED_MARKER;'"
touch_old "$FAKE_TARGET/$INJECT_NAME"
( cd "$SCRATCH_CWD" && run_sweep > /dev/null 2>&1 )
if [ ! -e "$SCRATCH_CWD/PWNED_MARKER" ]; then
  echo "  ok   a quote/metacharacter-bearing name never executes an injected command"
else
  echo "  FAIL an injected command ran -- eval-based removal is back"; fail=1
fi

# --- case 9 (B2): an entry whose FULL name contains an embedded newline is handled as ONE ---
# --- NUL-delimited record -- the second half never collides with a separate, live, --------
# --- genuinely-matching directory that happens to share that fragment's name ---------------
reset_target
WEIRD_NAME=$'zz-oldAAAAAA\nknown-live-BBBBBB'
mkdir -p -- "$FAKE_TARGET/$WEIRD_NAME"
touch -d '2 hours ago' -- "$FAKE_TARGET/$WEIRD_NAME"
mkdir -p "$FAKE_TARGET/known-live-BBBBBB"
run_sweep > /dev/null 2>&1
if [ -e "$FAKE_TARGET/known-live-BBBBBB" ]; then
  echo "  ok   a live directory is never deleted via a newline-split name fragment"
else
  echo "  FAIL the live directory was deleted -- newline-splitting is back"; fail=1
fi

# --- case 10 (B3): a deep, freshly-written file inside an old-looking top directory protects -
# --- the WHOLE tree, not just the top directory's own mtime ----------------------------------
reset_target
mkdir -p "$FAKE_TARGET/known-leak-deepok/sub"
touch -d '2 hours ago' "$FAKE_TARGET/known-leak-deepok"
touch "$FAKE_TARGET/known-leak-deepok/sub/freshfile"
run_sweep > /dev/null 2>&1
if [ -e "$FAKE_TARGET/known-leak-deepok" ]; then
  echo "  ok   a deep fresh file protects the whole tree even though the top dir looks old"
else
  echo "  FAIL the tree was removed despite a freshly-written file deep inside it"; fail=1
fi

# --- case 11 (B5): 50 old candidates swept in under 10 seconds ----------------------------
# pins that has_live_process() uses the O(snapshot) path, not the old O(pids*fds) fork loop.
PERF_SRC="$FAKE_ROOT/src_perf"
mkdir -p "$PERF_SRC"
{
  for i in $(seq 1 50); do
    printf "const d%d = mkdtempSync(join(tmpdir(), 'perf-t%02d-'))\n" "$i" "$i"
  done
} > "$PERF_SRC/perf.test.ts"
reset_target
for i in $(seq 1 50); do
  touch_old "$FAKE_TARGET/$(printf 'perf-t%02d-abcdef' "$i")"
done
START_T=$SECONDS
env \
  "TEST_TMP_SWEEP_SRC=$PERF_SRC" \
  "TEST_TMP_SWEEP_TARGET_DIR=$FAKE_TARGET" \
  "TEST_TMP_SWEEP_MIN_AGE_MIN=60" \
  "TEST_TMP_SWEEP_LOCKFILE=$FAKE_ROOT/perf-lock" \
  bash "$SWEEP" > /dev/null 2>&1
ELAPSED=$((SECONDS - START_T))
if [ "$ELAPSED" -lt 10 ]; then
  echo "  ok   50 old entries swept in ${ELAPSED}s (< 10s, live-process scan is O(snapshot))"
else
  echo "  FAIL 50-entry sweep took ${ELAPSED}s (>= 10s) -- has_live_process may still be O(pids*fds)"; fail=1
fi

# --- case 12 (B6): 60 open fds inside an old tree -- no SIGPIPE under pipefail ------------
# pins that has_live_process() uses awk exit status (no pipe) and fires correctly when a
# process holds many distinct fds inside the tree (old awk|grep -q silently failed at 25+).
reset_target
B6_ENTRY="$FAKE_TARGET/known-leak-b6fd"
touch_old "$B6_ENTRY"
for i in $(seq 1 60); do touch -d '2 hours ago' "$B6_ENTRY/f$i"; done
(
  for i in $(seq 1 60); do exec {_}<"$B6_ENTRY/f$i"; done
  sleep 30
) &
B6_PID=$!
sleep 0.3
run_sweep > /dev/null 2>&1
kill "$B6_PID" 2>/dev/null; wait "$B6_PID" 2>/dev/null || true
if [ -e "$B6_ENTRY" ]; then
  echo "  ok   60 open fds inside an old tree prevent removal (no SIGPIPE under pipefail)"
else
  echo "  FAIL tree removed despite 60 open fds -- has_live_process SIGPIPE bug"; fail=1
fi

# --- case 13 (B6 cwd): process cwd inside old tree -- has_live_process fires correctly ----
reset_target
CWD_ENTRY="$FAKE_TARGET/known-leak-cwdtest"
touch_old "$CWD_ENTRY"
(cd "$CWD_ENTRY" && sleep 30) &
CWD_PID=$!
sleep 0.3
run_sweep > /dev/null 2>&1
kill "$CWD_PID" 2>/dev/null; wait "$CWD_PID" 2>/dev/null || true
if [ -e "$CWD_ENTRY" ]; then
  echo "  ok   a process with cwd inside an old tree prevents removal"
else
  echo "  FAIL tree removed despite live cwd -- has_live_process failed"; fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "selftest: 13 passed, 0 failed"
  exit 0
else
  echo "selftest: FAILED"
  exit 1
fi
