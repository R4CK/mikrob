#!/bin/bash
# Contract tests for scripts/ensure-native-modules.sh's stray-pnpm alert (card d0126d79).
# Run: bash scripts/__tests__/ensure-native-modules.test.sh
#
# Exercises the pnpm-artifact detection, the alert + cooldown, and the clean-repo
# no-op -- all through the real script via its NATIVE_GUARD_* test hooks (no real
# Telegram send, no real npm rebuild).

set -u

PASS=0; FAIL=0
TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
GUARD="$INSTALL_DIR/scripts/ensure-native-modules.sh"

# Run the guard against an isolated fake project dir, skipping the real
# npm/node sqlite rebuild path (that's the pre-existing, unchanged behavior;
# this suite is scoped to the new stray-pnpm alert).
run_guard() {
  NATIVE_GUARD_PROJECT_DIR="$1" NATIVE_GUARD_STATE_DIR="$2" \
    NATIVE_GUARD_ALERT_DRYRUN=1 NATIVE_GUARD_SKIP_SQLITE_CHECK=1 \
    bash "$GUARD" 2>&1
}

fresh_case() { # -> echoes "project state" for a clean case dir
  local p s; p="$TMPDIR_BASE/proj-$1"; s="$TMPDIR_BASE/state-$1"; mkdir -p "$p" "$s"
  echo "$p $s"
}

echo "ensure-native-modules stray-pnpm tests"
echo "======================================="

# ---------------------------------------------------------------------------
# (a) Clean repo (no pnpm artifacts) -> total no-op, no alert
# ---------------------------------------------------------------------------
echo ""
echo "(a) Clean repo"
read -r PROJ ST <<<"$(fresh_case a)"
OUT="$(run_guard "$PROJ" "$ST")"
if printf '%s' "$OUT" | grep -q "ALERT_DRYRUN"; then fail "clean: alerted with no pnpm artifacts present"; else pass "clean: no alert"; fi
[ -f "$ST/.native-guard-pnpm-alerted" ] && fail "clean: cooldown stamp written with nothing to alert on" || pass "clean: no cooldown stamp written"

# ---------------------------------------------------------------------------
# (b) pnpm-lock.yaml present -> alert, cooldown stamp written
# ---------------------------------------------------------------------------
echo ""
echo "(b) Stray pnpm-lock.yaml"
read -r PROJ ST <<<"$(fresh_case b)"
touch "$PROJ/pnpm-lock.yaml"
OUT="$(run_guard "$PROJ" "$ST")"
if printf '%s' "$OUT" | grep -q "ALERT_DRYRUN"; then pass "lockfile: alert emitted"; else fail "lockfile: no alert emitted: $OUT"; fi
[ -f "$ST/.native-guard-pnpm-alerted" ] && pass "lockfile: cooldown stamp written" || fail "lockfile: cooldown stamp missing"

# ---------------------------------------------------------------------------
# (c) node_modules/.pnpm present (no lockfile) -> alert too
# ---------------------------------------------------------------------------
echo ""
echo "(c) Stray node_modules/.pnpm"
read -r PROJ ST <<<"$(fresh_case c)"
mkdir -p "$PROJ/node_modules/.pnpm"
OUT="$(run_guard "$PROJ" "$ST")"
if printf '%s' "$OUT" | grep -q "ALERT_DRYRUN"; then pass "pnpm-dir: alert emitted"; else fail "pnpm-dir: no alert emitted: $OUT"; fi

# ---------------------------------------------------------------------------
# (d) Alert cooldown -> a second run within the hour does NOT re-alert
# ---------------------------------------------------------------------------
echo ""
echo "(d) Alert cooldown"
read -r PROJ ST <<<"$(fresh_case d)"
touch "$PROJ/pnpm-lock.yaml"
run_guard "$PROJ" "$ST" >/dev/null 2>&1   # first tick: alerts, writes the stamp
OUT2="$(run_guard "$PROJ" "$ST")"          # same state dir, stamp is fresh
if printf '%s' "$OUT2" | grep -q "ALERT_DRYRUN"; then fail "cooldown: re-alerted within the hour"; else pass "cooldown: suppressed re-alert within cooldown"; fi

# ---------------------------------------------------------------------------
# (e) Stray artifact removed between ticks -> next tick is a clean no-op again
# ---------------------------------------------------------------------------
echo ""
echo "(e) Cleared after fix"
read -r PROJ ST <<<"$(fresh_case e)"
touch "$PROJ/pnpm-lock.yaml"
run_guard "$PROJ" "$ST" >/dev/null 2>&1
rm -f "$PROJ/pnpm-lock.yaml"
OUT="$(run_guard "$PROJ" "$ST")"
if printf '%s' "$OUT" | grep -q "ALERT_DRYRUN"; then fail "cleared: alerted again after the stray file was removed"; else pass "cleared: no alert once the artifact is gone"; fi

# ---------------------------------------------------------------------------
# (f) Missing STATE_DIR -> guard still alerts and persists the stamp (mkdir -p)
# ---------------------------------------------------------------------------
echo ""
echo "(f) Missing state dir"
PROJ="$TMPDIR_BASE/proj-f"; mkdir -p "$PROJ"; touch "$PROJ/pnpm-lock.yaml"
ST="$TMPDIR_BASE/state-f-missing"   # does not exist yet
OUT="$(run_guard "$PROJ" "$ST")"
if printf '%s' "$OUT" | grep -q "ALERT_DRYRUN"; then pass "missing-state: alerts on first tick"; else fail "missing-state: no alert: $OUT"; fi
[ -f "$ST/.native-guard-pnpm-alerted" ] && pass "missing-state: cooldown stamp written despite missing STATE_DIR" || fail "missing-state: stamp not written -> would re-alert every tick"

# ---------------------------------------------------------------------------
echo ""
echo "======================================="
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
