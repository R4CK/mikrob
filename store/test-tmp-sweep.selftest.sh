#!/usr/bin/env bash
# test-tmp-sweep.selftest.sh -- pins the behaviour of store/test-tmp-sweep.sh (card a4a6a5e5)
# against a FAKE source tree and a FAKE target dir, so it never touches the real /tmp.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWEEP="$HERE/test-tmp-sweep.sh"
fail=0

FAKE_ROOT="$(mktemp -d)"
trap 'rm -rf "$FAKE_ROOT"' EXIT

FAKE_SRC="$FAKE_ROOT/src"
FAKE_TARGET="$FAKE_ROOT/tmp"
mkdir -p "$FAKE_SRC" "$FAKE_TARGET"

# A fake test file declaring one known prefix, single- and double-quoted, so the extractor is
# proven on both quote styles in the same run.
cat > "$FAKE_SRC/fixture.test.ts" <<'EOF'
const dir = mkdtempSync(join(tmpdir(), 'known-leak-'))
const other = mkdtempSync(join(tmpdir(), "known-other-"))
EOF

run_sweep() {
  env \
    "TEST_TMP_SWEEP_SRC=$FAKE_SRC" \
    "TEST_TMP_SWEEP_TARGET_DIR=$FAKE_TARGET" \
    "TEST_TMP_SWEEP_MIN_AGE_MIN=${TEST_TMP_SWEEP_MIN_AGE_MIN_OVERRIDE:-60}" \
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
touch_old "$FAKE_TARGET/known-other-xyz"
run_sweep --dry-run > /dev/null 2>&1
if [ -e "$FAKE_TARGET/known-other-xyz" ]; then
  echo "  ok   --dry-run reports without deleting"
else
  echo "  FAIL --dry-run deleted an entry"; fail=1
fi

# --- case 5: the double-quoted mkdtempSync declaration is picked up too -------------------
reset_target
touch_old "$FAKE_TARGET/known-other-xyz2"
run_sweep > /dev/null 2>&1
if [ ! -e "$FAKE_TARGET/known-other-xyz2" ]; then
  echo "  ok   a double-quoted mkdtempSync prefix is extracted and matched"
else
  echo "  FAIL the double-quoted-declared prefix was not removed"; fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "selftest: 5 passed, 0 failed"
  exit 0
else
  echo "selftest: FAILED"
  exit 1
fi
