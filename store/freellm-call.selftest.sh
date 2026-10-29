#!/usr/bin/env bash
# freellm-call.selftest.sh -- unit tests for freellm-call.sh
#
# TESTS:
# 1. --dry-run works without config
# 2. missing switch file = exit 2
# 3. disabled switch = exit 2
# 4. content gate: mopsion prompt = exit 4
# 5. content gate: token in prompt = exit 4
# 6. normal prompt with valid config = exit 0 (but no network, so placeholder)
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/freellm-call.sh"
TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

PASS=0 FAIL=0

test_case() {
  local name="$1"
  local expected_exit="$2"
  shift 2
  local actual_exit=0
  "$@" >/dev/null 2>&1 || actual_exit=$?
  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "[PASS] $name (exit $actual_exit)"
    ((PASS++))
  else
    echo "[FAIL] $name (expected $expected_exit, got $actual_exit)"
    ((FAIL++))
  fi
}

# Test 1: --dry-run works without config
test_case "dry-run without config" 0 \
  bash "$SCRIPT" --dry-run "test prompt"

# Test 2: missing switch file = exit 2
export FREELLM_SWITCH="$TMPDIR_TEST/nonexistent.json"
test_case "missing switch file" 2 \
  bash "$SCRIPT" "test prompt"

# Test 3: disabled switch = exit 2
cat > "$TMPDIR_TEST/freellm-disabled.json" << 'EOF'
{"enabled": false, "setBy": "test", "reason": "testing", "since": 1234567890}
EOF
export FREELLM_SWITCH="$TMPDIR_TEST/freellm-disabled.json"
test_case "disabled switch" 2 \
  bash "$SCRIPT" "test prompt"

# Test 4: content gate - mopsion prompt = exit 4
cat > "$TMPDIR_TEST/freellm-enabled.json" << 'EOF'
{"enabled": true, "setBy": "test", "reason": "testing", "since": 1234567890}
EOF
export FREELLM_SWITCH="$TMPDIR_TEST/freellm-enabled.json"
test_case "content gate: mopsion in prompt" 4 \
  bash "$SCRIPT" "test mopsion feature"

# Test 5: content gate - sensitive token = exit 4
test_case "content gate: secret token in prompt" 4 \
  bash "$SCRIPT" "my password is SecureP@ss123"

test_case "content gate: API key mention" 4 \
  bash "$SCRIPT" "configure your api_key here"

# Test 6: --validate-key with enabled switch = exit 0
test_case "validate-key with enabled switch" 0 \
  bash "$SCRIPT" --validate-key

# Test 7: --validate-key with disabled switch = exit 2
export FREELLM_SWITCH="$TMPDIR_TEST/freellm-disabled.json"
test_case "validate-key with disabled switch" 2 \
  bash "$SCRIPT" --validate-key

# Summary
echo ""
echo "PASSED: $PASS"
echo "FAILED: $FAIL"
if [[ "$FAIL" -eq 0 ]]; then
  exit 0
else
  exit 1
fi
