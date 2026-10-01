#!/bin/bash
# Card 251b1765: the upstream-review ledger (store/upstream-ported.json) is now anchored to
# MARVEEN_MAIN, never to the invoking checkout's own $ROOT -- before this, every agent worktree
# kept its own copy, so a decision made in one worktree was invisible to the next review,
# wherever it ran next, duplicating port/skip work across sessions.
#
# This proves the fix with a REAL repo copy acting as the shared "main clone", never the actual
# ~/marveen install -- a selftest must not touch live state. Two "worktree" invocations are
# simulated by simply calling the script twice (the fix makes the invoking checkout irrelevant to
# the ledger path), and a third case fires two marks concurrently to prove the flock actually
# serializes the read-modify-write instead of losing one write to a race.
set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$INSTALL_DIR/scripts/upstream-new.sh"

echo "upstream-new.sh ledger tests"
echo "============================"

FIXTURE_MAIN="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_MAIN"' EXIT
LEDGER="$FIXTURE_MAIN/store/upstream-ported.json"

# --- Case 1: two separate invocations ("two worktrees") land in the SAME ledger file ----------
OUT1="$(MARVEEN_MAIN="$FIXTURE_MAIN" bash "$SCRIPT" mark ported aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "worktree-one's port decision" 2>&1)"
OUT2="$(MARVEEN_MAIN="$FIXTURE_MAIN" bash "$SCRIPT" mark skipped bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb "worktree-two's skip decision" 2>&1)"

case "$OUT1" in
  *"ported: aaaaaaaa"*) pass "first invocation reports the ported decision" ;;
  *) fail "first invocation did not report ported: $OUT1" ;;
esac
case "$OUT2" in
  *"skipped: bbbbbbbb"*) pass "second invocation reports the skipped decision" ;;
  *) fail "second invocation did not report skipped: $OUT2" ;;
esac

if [ -f "$LEDGER" ]; then
  pass "the ledger file was created under the fixture MARVEEN_MAIN, not under either invoker's own \$ROOT"
else
  fail "no ledger file found at $LEDGER"
fi

BOTH="$(python3 -c "
import json
d = json.load(open('$LEDGER'))
a = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' in d.get('ported', {})
b = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' in d.get('skipped', {})
print('yes' if a and b else 'no')
")"
if [ "$BOTH" = "yes" ]; then
  pass "BOTH entries (from the two separate invocations) are present in the one shared ledger"
else
  fail "the ledger is missing one of the two entries -- the second invocation clobbered the first"
fi

# --- Case 2: concurrent marks do not race-clobber each other (flock) ---------------------------
rm -f "$LEDGER" "$LEDGER.lock"

( MARVEEN_MAIN="$FIXTURE_MAIN" bash "$SCRIPT" mark ported cccccccccccccccccccccccccccccccccccccccc "concurrent writer one" >/dev/null 2>&1 ) &
PID1=$!
( MARVEEN_MAIN="$FIXTURE_MAIN" bash "$SCRIPT" mark ported dddddddddddddddddddddddddddddddddddddddd "concurrent writer two" >/dev/null 2>&1 ) &
PID2=$!
wait "$PID1"
wait "$PID2"

BOTH_CONCURRENT="$(python3 -c "
import json
d = json.load(open('$LEDGER'))
c = 'cccccccccccccccccccccccccccccccccccccccc' in d.get('ported', {})
dd = 'dddddddddddddddddddddddddddddddddddddddd' in d.get('ported', {})
print('yes' if c and dd else 'no')
" 2>/dev/null)"
if [ "$BOTH_CONCURRENT" = "yes" ]; then
  pass "two CONCURRENT mark invocations both survive -- the flock serializes the read-modify-write"
else
  fail "a concurrent write was lost -- the flock did not serialize the two invocations"
fi

echo ""
echo "============================"
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
