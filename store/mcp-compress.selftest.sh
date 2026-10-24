#!/usr/bin/env bash
# Selftest for store/mcp-compress.sh doctor (card 1bb57483, WhiteHat LOW-ok on 0f55f01e):
#   L1: doctor must exit non-zero on ANY FAIL line, not just print one and exit 0.
#   L2: the PATH-check must survive a trailing-slash or a `../bin`-style relative form that
#       resolves to the same directory as the audited bin dir (a literal `grep -qx` missed both).
#   L3: the integrity check must catch a LOCALLY modified installed tree, not just compare the
#       registry's published (and therefore immutable) tarball hash.
#
# NOT fully hermetic for L3/baseline: the script hardcodes PINNED_TREE_SHA256 against the real,
# already-audited ~/.npm-tools install (card 0f55f01e; QA2/Cybersec confirmed byte-identical to the
# audited 0.36.0 release via `diff -rq`), so there is no seam to swap in a synthetic pinned hash.
# Cases that need a real installed tree SKIP (not FAIL) when it is absent, so this still runs clean
# on a box that never ran the mcp-compressor adoption.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/mcp-compress.sh"
REAL_PKG="$HOME/.npm-tools/lib/node_modules/@atlassian/mcp-compressor"
REAL_BIN="$HOME/.npm-tools/bin"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

passed=0
failed=0
skipped=0

# Checks exit code AND output substring, same discipline as vram-guard-check.selftest.sh: a doctor
# that prints FAIL while exiting 0 is exactly L1, so both must be asserted together.
check() {
  local name="$1" want_exit="$2" want_substr="$3"; shift 3
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  if [ "$rc" != "$want_exit" ]; then
    echo "FAIL $name: expected exit $want_exit, got $rc (output: $out)"; failed=$((failed+1)); return
  fi
  case "$out" in
    *"$want_substr"*) passed=$((passed+1)) ;;
    *) echo "FAIL $name: expected output to contain '$want_substr', got: $out"; failed=$((failed+1)) ;;
  esac
}

skip() {
  echo "SKIP $1"
  skipped=$((skipped+1))
}

if [ ! -d "$REAL_PKG/dist" ]; then
  skip "no real @atlassian/mcp-compressor install at $REAL_PKG -- all doctor cases skipped"
else
  # ---- baseline: the real, already-audited install must still report clean ----
  check "clean install: doctor exits 0" 0 "tree:    OK" \
    env MCP_COMPRESSOR_PKG="$REAL_PKG" MCP_COMPRESSOR_BIN_DIR="$REAL_BIN" "$SCRIPT" doctor

  # ---- L1 + L2: PATH bypass shapes (all three measured by WhiteHat on 0f55f01e) ----
  check "exact literal PATH on: FAIL + non-zero exit" 1 "PATH:    FAIL" \
    env MCP_COMPRESSOR_PKG="$REAL_PKG" MCP_COMPRESSOR_BIN_DIR="$REAL_BIN" PATH="$REAL_BIN:$PATH" "$SCRIPT" doctor

  check "trailing-slash PATH bypass: FAIL + non-zero exit" 1 "PATH:    FAIL" \
    env MCP_COMPRESSOR_PKG="$REAL_PKG" MCP_COMPRESSOR_BIN_DIR="$REAL_BIN" PATH="$REAL_BIN/:$PATH" "$SCRIPT" doctor

  check "../bin relative PATH bypass: FAIL + non-zero exit" 1 "PATH:    FAIL" \
    env MCP_COMPRESSOR_PKG="$REAL_PKG" MCP_COMPRESSOR_BIN_DIR="$REAL_BIN" PATH="$REAL_BIN/../bin:$PATH" "$SCRIPT" doctor

  # CONTROL: an unrelated directory on PATH must not false-positive the check.
  check "unrelated PATH entry: still OK" 0 "PATH:    OK" \
    env MCP_COMPRESSOR_PKG="$REAL_PKG" MCP_COMPRESSOR_BIN_DIR="$REAL_BIN" PATH="$tmpdir/unrelated:$PATH" "$SCRIPT" doctor

  # ---- L3: installed-tree tamper detection ----
  cp -r "$REAL_PKG" "$tmpdir/pkg-untouched"
  check "untouched copy of the real tree: still OK (copy-safe hash)" 0 "tree:    OK" \
    env MCP_COMPRESSOR_PKG="$tmpdir/pkg-untouched" MCP_COMPRESSOR_BIN_DIR="$REAL_BIN" "$SCRIPT" doctor

  cp -r "$REAL_PKG" "$tmpdir/pkg-tampered"
  printf '\n// tampered by selftest\n' >> "$tmpdir/pkg-tampered/dist/index.js"
  check "locally tampered dist/: FAIL + non-zero exit" 1 "tree:    FAIL" \
    env MCP_COMPRESSOR_PKG="$tmpdir/pkg-tampered" MCP_COMPRESSOR_BIN_DIR="$REAL_BIN" "$SCRIPT" doctor
fi

# ---- hermetic: missing-package case needs no real install ----
check "nonexistent package: refuses before any doctor output" 4 "package not found" \
  env MCP_COMPRESSOR_PKG="$tmpdir/does-not-exist" MCP_COMPRESSOR_BIN_DIR="$REAL_BIN" "$SCRIPT" doctor

if [ "$failed" -eq 0 ]; then
  echo "selftest: $passed passed, 0 failed, $skipped skipped"
  exit 0
fi
echo "selftest: $passed passed, $failed failed, $skipped skipped"
exit 1
