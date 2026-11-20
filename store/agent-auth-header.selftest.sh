#!/usr/bin/env bash
# Regression test for store/agent-auth-header.sh (card 52114c2f).
set -euo pipefail

SELF_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SELF_DIR/agent-auth-header.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAIL=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; FAIL=1; }

AGENTS_ROOT="$WORK/agents"
MAIN_DIR="$WORK/main"
mkdir -p "$AGENTS_ROOT/backend" "$MAIN_DIR/store"
echo "shared-token-value" > "$MAIN_DIR/store/.dashboard-token"

export MARVEEN_AGENTS_ROOT="$AGENTS_ROOT"
export MARVEEN_MAIN="$MAIN_DIR"

# Case 1: no key file at all -> falls back to the shared token, warns on stderr.
OUT="$(bash "$SCRIPT" backend 2>"$WORK/stderr1")"
if [ "$OUT" = "Authorization: Bearer shared-token-value" ]; then
  pass "missing key file falls back to shared token"
else
  fail "missing key file falls back to shared token (got: $OUT)"
fi
if grep -q "falling back to the shared token" "$WORK/stderr1"; then
  pass "missing key file logs a fallback warning"
else
  fail "missing key file logs a fallback warning"
fi

# Case 2: empty key file -> treated the same as missing (fallback + warning), not as a real key.
: > "$AGENTS_ROOT/backend/.dashboard-agent-key"
OUT="$(bash "$SCRIPT" backend 2>"$WORK/stderr2")"
if [ "$OUT" = "Authorization: Bearer shared-token-value" ]; then
  pass "empty key file falls back to shared token"
else
  fail "empty key file falls back to shared token (got: $OUT)"
fi
grep -q "falling back to the shared token" "$WORK/stderr2" && pass "empty key file logs a fallback warning" \
  || fail "empty key file logs a fallback warning"

# Case 3: real key file present -> uses the agent's own key, no warning, no shared-token read.
echo -n "own-agent-key-value" > "$AGENTS_ROOT/backend/.dashboard-agent-key"
OUT="$(bash "$SCRIPT" backend 2>"$WORK/stderr3")"
if [ "$OUT" = "Authorization: Bearer own-agent-key-value" ]; then
  pass "own key file is used when present"
else
  fail "own key file is used when present (got: $OUT)"
fi
if [ ! -s "$WORK/stderr3" ]; then
  pass "own key file present logs no fallback warning"
else
  fail "own key file present logs no fallback warning (stderr: $(cat "$WORK/stderr3"))"
fi

# Case 4 (mutation check): if the "own key file is used" branch is bypassed, case 3 goes red --
# prove it by removing the key file again and re-checking we're back to the fallback value.
rm -f "$AGENTS_ROOT/backend/.dashboard-agent-key"
OUT="$(bash "$SCRIPT" backend 2>/dev/null)"
if [ "$OUT" = "Authorization: Bearer shared-token-value" ]; then
  pass "removing the key file again reverts to the shared token (fallback path really is conditional)"
else
  fail "removing the key file again reverts to the shared token (got: $OUT)"
fi

# Case 5: missing agent arg -> usage error, exit 2.
set +e
bash "$SCRIPT" >/dev/null 2>"$WORK/stderr5"
RC=$?
set -e
if [ "$RC" -eq 2 ] && grep -q "usage:" "$WORK/stderr5"; then
  pass "missing agent argument exits 2 with a usage message"
else
  fail "missing agent argument exits 2 with a usage message (rc=$RC)"
fi

# Case 6: neither a key nor a shared token -> fails closed (exit 4), never prints "Bearer ".
rm -f "$MAIN_DIR/store/.dashboard-token"
set +e
bash "$SCRIPT" backend >"$WORK/stdout6" 2>"$WORK/stderr6"
RC=$?
set -e
if [ "$RC" -eq 4 ] && [ ! -s "$WORK/stdout6" ]; then
  pass "no token anywhere fails closed (exit 4, nothing printed to stdout)"
else
  fail "no token anywhere fails closed (rc=$RC, stdout: $(cat "$WORK/stdout6"))"
fi

if [ "$FAIL" -eq 0 ]; then
  echo "selftest: PASS"
  exit 0
else
  echo "selftest: FAIL"
  exit 1
fi
