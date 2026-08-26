#!/bin/bash
# Contract tests for scripts/ollama-down-guard.sh.
# Run: bash scripts/__tests__/ollama-down-guard.test.sh
#
# Exercises the up/down check, the down-alert + cooldown, and the recovery
# stamp-clear -- all through the real script via its OLLAMA_GUARD_* test hooks
# (no actual curl to Ollama, no real Telegram send).

set -u

PASS=0; FAIL=0
TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
GUARD="$INSTALL_DIR/scripts/ollama-down-guard.sh"

# Run the guard with an isolated state dir and a forced up/down result.
# Args: up_override(0|1) state_dir -> prints stdout (logs + any ALERT_DRYRUN).
run_guard() {
  OLLAMA_GUARD_UP_OVERRIDE="$1" OLLAMA_GUARD_STATE_DIR="$2" OLLAMA_GUARD_ALERT_DRYRUN=1 bash "$GUARD" 2>&1
}

fresh_state() { local d; d="$TMPDIR_BASE/case-$1"; mkdir -p "$d"; echo "$d"; }

echo "ollama-down-guard tests"
echo "========================"

# ---------------------------------------------------------------------------
# (a) Up -> no alert, no-op
# ---------------------------------------------------------------------------
echo ""
echo "(a) Up"
ST="$(fresh_state a)"
OUT="$(run_guard 1 "$ST")"
if printf '%s' "$OUT" | grep -q "ALERT_DRYRUN"; then fail "up: must not alert"; else pass "up: no alert"; fi
[ -f "$ST/.ollama-guard-alerted" ] && fail "up: no stamp should exist" || pass "up: no stamp written"

# ---------------------------------------------------------------------------
# (b) Down -> alert + cooldown stamp written
# ---------------------------------------------------------------------------
echo ""
echo "(b) Down -> first alert"
ST="$(fresh_state b)"
OUT="$(run_guard 0 "$ST")"
if printf '%s' "$OUT" | grep -q "ALERT_DRYRUN"; then pass "down: alert emitted"; else fail "down: no alert"; fi
[ -f "$ST/.ollama-guard-alerted" ] && pass "down: cooldown stamp written" || fail "down: cooldown stamp missing"

# ---------------------------------------------------------------------------
# (c) Down again within the hour -> suppressed by cooldown
# ---------------------------------------------------------------------------
echo ""
echo "(c) Cooldown"
OUT2="$(run_guard 0 "$ST")"   # same state dir, stamp is fresh
if printf '%s' "$OUT2" | grep -q "ALERT_DRYRUN"; then fail "cooldown: re-alerted within cooldown"; else pass "cooldown: suppressed re-alert within cooldown"; fi

# ---------------------------------------------------------------------------
# (d) Recovery -> stamp cleared, so a LATER outage alerts again immediately
# ---------------------------------------------------------------------------
echo ""
echo "(d) Recovery clears the stamp"
OUT3="$(run_guard 1 "$ST")"
[ -f "$ST/.ollama-guard-alerted" ] && fail "recovery: stamp should be cleared" || pass "recovery: stamp cleared"
OUT4="$(run_guard 0 "$ST")"
if printf '%s' "$OUT4" | grep -q "ALERT_DRYRUN"; then pass "recovery: a fresh outage after recovery alerts again immediately"; else fail "recovery: fresh outage suppressed (stamp not really cleared)"; fi

# ---------------------------------------------------------------------------
# (e) Cooldown stamp persists even when STATE_DIR was missing (no alert-spam)
# ---------------------------------------------------------------------------
echo ""
echo "(e) Cooldown-stamp persistence despite missing STATE_DIR"
EBASE="$TMPDIR_BASE/e-missing"   # does not exist yet
OUTE1="$(run_guard 0 "$EBASE")"
if printf '%s' "$OUTE1" | grep -q "ALERT_DRYRUN"; then pass "missing-dir: alerts on first tick"; else fail "missing-dir: no alert"; fi
[ -f "$EBASE/.ollama-guard-alerted" ] && pass "missing-dir: stamp written despite missing STATE_DIR (mkdir at top)" || fail "missing-dir: stamp not written -> would re-alert every tick"
OUTE2="$(run_guard 0 "$EBASE")"
if printf '%s' "$OUTE2" | grep -q "ALERT_DRYRUN"; then fail "missing-dir: re-alerted within cooldown"; else pass "missing-dir: second tick suppressed by cooldown"; fi

# ---------------------------------------------------------------------------
echo ""
echo "========================"
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
