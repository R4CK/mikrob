#!/bin/bash
# Contract tests for scripts/build-freshness-guard.sh.
# Run: bash scripts/__tests__/build-freshness-guard.test.sh
#
# Exercises the fresh/stale/grace-period/cooldown/recovery logic through the real script via its
# BUILD_GUARD_* test hooks (no real git log, no real dist/ scan, no real Telegram send).

set -u

PASS=0; FAIL=0
TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
GUARD="$INSTALL_DIR/scripts/build-freshness-guard.sh"

SRC_TS=2000000

# Run the guard with an isolated state dir and forced src/dist timestamps.
# Args: src_ts dist_ts state_dir -> prints stdout (logs + any ALERT_DRYRUN).
run_guard() {
  BUILD_GUARD_SRC_TS_OVERRIDE="$1" BUILD_GUARD_DIST_TS_OVERRIDE="$2" \
    BUILD_GUARD_STATE_DIR="$3" BUILD_GUARD_ALERT_DRYRUN=1 bash "$GUARD" 2>&1
}

fresh_state() { local d; d="$TMPDIR_BASE/case-$1"; mkdir -p "$d"; echo "$d"; }

echo "build-freshness-guard tests"
echo "============================"

# ---------------------------------------------------------------------------
# (a) dist/ at least as new as src/ -> no alert, no-op
# ---------------------------------------------------------------------------
echo ""
echo "(a) Fresh (dist >= src)"
ST="$(fresh_state a)"
OUT="$(run_guard "$SRC_TS" "$SRC_TS" "$ST")"
if printf '%s' "$OUT" | grep -q "ALERT_DRYRUN"; then fail "fresh: must not alert"; else pass "fresh: no alert"; fi
[ -f "$ST/.build-freshness-guard-alerted" ] && fail "fresh: no stamp should exist" || pass "fresh: no stamp written"

# ---------------------------------------------------------------------------
# (b) Small drift, still inside the build-time grace period -> no alert
# ---------------------------------------------------------------------------
echo ""
echo "(b) Within grace period"
ST="$(fresh_state b)"
OUT="$(run_guard "$SRC_TS" "$((SRC_TS - 100))" "$ST")"   # 100s drift < 300s grace
if printf '%s' "$OUT" | grep -q "ALERT_DRYRUN"; then fail "grace: must not alert this early"; else pass "grace: no alert inside the grace window"; fi

# ---------------------------------------------------------------------------
# (c) Drift beyond the grace period -> alert + cooldown stamp written
# ---------------------------------------------------------------------------
echo ""
echo "(c) Stale beyond grace -> first alert"
ST="$(fresh_state c)"
OUT="$(run_guard "$SRC_TS" "$((SRC_TS - 400))" "$ST")"   # 400s drift > 300s grace
if printf '%s' "$OUT" | grep -q "ALERT_DRYRUN"; then pass "stale: alert emitted"; else fail "stale: no alert"; fi
[ -f "$ST/.build-freshness-guard-alerted" ] && pass "stale: cooldown stamp written" || fail "stale: cooldown stamp missing"

# ---------------------------------------------------------------------------
# (d) Still stale within the hour -> suppressed by cooldown
# ---------------------------------------------------------------------------
echo ""
echo "(d) Cooldown"
OUT2="$(run_guard "$SRC_TS" "$((SRC_TS - 400))" "$ST")"   # same state dir, stamp is fresh
if printf '%s' "$OUT2" | grep -q "ALERT_DRYRUN"; then fail "cooldown: re-alerted within cooldown"; else pass "cooldown: suppressed re-alert within cooldown"; fi

# ---------------------------------------------------------------------------
# (e) Recovery (a fresh build lands) -> stamp cleared, so a LATER stale land alerts again
# ---------------------------------------------------------------------------
echo ""
echo "(e) Recovery clears the stamp"
OUT3="$(run_guard "$SRC_TS" "$SRC_TS" "$ST")"
[ -f "$ST/.build-freshness-guard-alerted" ] && fail "recovery: stamp should be cleared" || pass "recovery: stamp cleared"
OUT4="$(run_guard "$((SRC_TS + 1000))" "$SRC_TS" "$ST")"   # a NEW src/ commit lands, dist/ unbuilt
if printf '%s' "$OUT4" | grep -q "ALERT_DRYRUN"; then pass "recovery: a fresh staleness after recovery alerts again immediately"; else fail "recovery: fresh staleness suppressed (stamp not really cleared)"; fi

# ---------------------------------------------------------------------------
# (f) Cooldown stamp persists even when STATE_DIR was missing (no alert-spam)
# ---------------------------------------------------------------------------
echo ""
echo "(f) Cooldown-stamp persistence despite missing STATE_DIR"
FBASE="$TMPDIR_BASE/f-missing"   # does not exist yet
OUTF1="$(run_guard "$SRC_TS" "$((SRC_TS - 400))" "$FBASE")"
if printf '%s' "$OUTF1" | grep -q "ALERT_DRYRUN"; then pass "missing-dir: alerts on first tick"; else fail "missing-dir: no alert"; fi
[ -f "$FBASE/.build-freshness-guard-alerted" ] && pass "missing-dir: stamp written despite missing STATE_DIR (mkdir at top)" || fail "missing-dir: stamp not written -> would re-alert every tick"
OUTF2="$(run_guard "$SRC_TS" "$((SRC_TS - 400))" "$FBASE")"
if printf '%s' "$OUTF2" | grep -q "ALERT_DRYRUN"; then fail "missing-dir: re-alerted within cooldown"; else pass "missing-dir: second tick suppressed by cooldown"; fi

# ---------------------------------------------------------------------------
# (g) Not a git repo (no src/-touching commit resolvable) -> no-op, never crashes
# ---------------------------------------------------------------------------
echo ""
echo "(g) No src/ commit found (not a git repo)"
ST="$(fresh_state g)"
NOTGIT="$TMPDIR_BASE/not-a-repo"; mkdir -p "$NOTGIT"
OUT="$(BUILD_GUARD_REPO_DIR="$NOTGIT" BUILD_GUARD_DIST_TS_OVERRIDE="$SRC_TS" \
  BUILD_GUARD_STATE_DIR="$ST" BUILD_GUARD_ALERT_DRYRUN=1 bash "$GUARD" 2>&1)"
if printf '%s' "$OUT" | grep -q "ALERT_DRYRUN"; then fail "no-src-commit: must not alert"; else pass "no-src-commit: no-op"; fi

# ---------------------------------------------------------------------------
echo ""
echo "============================"
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
