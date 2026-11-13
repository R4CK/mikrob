#!/usr/bin/env bash
# kg-capture-worker.selftest.sh -- G2 (card c84a510a): proves kg-capture-worker.sh's flock is a
# real single-flight guard, not just a comment. Does not touch the real kg database, Ollama, or
# vram-guard-check.sh: kg-backfill.sh is replaced by a slow stub in a scratch copy of the worker,
# so the test only exercises the lock-acquire/skip logic itself.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

cp "$HERE/kg-capture-worker.sh" "$TMPDIR/kg-capture-worker.sh"
chmod +x "$TMPDIR/kg-capture-worker.sh"

RUN_MARKER="$TMPDIR/ran.count"
cat > "$TMPDIR/kg-backfill.sh" <<EOF
#!/usr/bin/env bash
echo 1 >> "$RUN_MARKER"
sleep 1
EOF
chmod +x "$TMPDIR/kg-backfill.sh"

PASS=0
FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    echo "FAIL: $desc"
    echo "  want: $want"
    echo "  got:  $got"
  fi
}

# --- case 1: two concurrent invocations -- exactly one proceeds into kg-backfill.sh, the other
# exits 0 immediately with the skip message, never touching the queue. -----------------------
LOCK_A="$TMPDIR/case1.lock"
out1="$TMPDIR/out1.log"
out2="$TMPDIR/out2.log"
KG_CAPTURE_WORKER_LOCK="$LOCK_A" bash "$TMPDIR/kg-capture-worker.sh" > "$out1" 2>&1 &
pid1=$!
sleep 0.2
KG_CAPTURE_WORKER_LOCK="$LOCK_A" bash "$TMPDIR/kg-capture-worker.sh" > "$out2" 2>&1
rc2=$?
wait "$pid1"
rc1=$?

check "case1: first run exits 0" "$rc1" "0"
check "case1: second (blocked) run also exits 0 (skip, not a failure)" "$rc2" "0"
check "case1: second run never entered kg-backfill.sh" "$(grep -c "skipping" "$out2")" "1"
check "case1: kg-backfill.sh ran exactly once, not twice" "$(cat "$RUN_MARKER" 2>/dev/null | wc -l | tr -d ' ')" "1"

# --- case 2: after the first run releases the lock (process exit), a later run can acquire it
# again -- the lock is per-run, not permanently stuck. -----------------------------------------
: > "$RUN_MARKER"
LOCK_B="$TMPDIR/case2.lock"
KG_CAPTURE_WORKER_LOCK="$LOCK_B" bash "$TMPDIR/kg-capture-worker.sh" > /dev/null 2>&1
KG_CAPTURE_WORKER_LOCK="$LOCK_B" bash "$TMPDIR/kg-capture-worker.sh" > /dev/null 2>&1
check "case2: two SEQUENTIAL runs (lock released between them) both proceed" \
  "$(cat "$RUN_MARKER" | wc -l | tr -d ' ')" "2"

# --- CONTROL: without the lock file override pointing at a shared scratch path, two concurrent
# runs with DIFFERENT lock files (no contention) both proceed -- proves case 1's skip is the lock
# doing its job, not some other reason kg-backfill.sh failed to run. ---------------------------
: > "$RUN_MARKER"
KG_CAPTURE_WORKER_LOCK="$TMPDIR/control-a.lock" bash "$TMPDIR/kg-capture-worker.sh" > "$TMPDIR/ctrl1.log" 2>&1 &
pidc1=$!
sleep 0.2
KG_CAPTURE_WORKER_LOCK="$TMPDIR/control-b.lock" bash "$TMPDIR/kg-capture-worker.sh" > "$TMPDIR/ctrl2.log" 2>&1
wait "$pidc1"
check "CONTROL: different lock files -> no contention -> kg-backfill.sh ran twice" \
  "$(cat "$RUN_MARKER" | wc -l | tr -d ' ')" "2"

echo "PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
