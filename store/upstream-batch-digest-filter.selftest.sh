#!/usr/bin/env bash
# upstream-batch-digest-filter.selftest.sh -- coverage for upstream-batch-digest-filter.sh
# (card efe4aa40). Mutation-proof: case B/C/D assert the ABSENCE of unsafe markers in the
# output, not just the presence of safe ones -- a disabled/bypassed filter (e.g. `cat`) would
# pass case A but fail B/C/D, because the raw --stat/diff/filename text would still be present.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/upstream-batch-digest-filter.sh"

PASS=0
FAIL=0
FAILED=()

check() {
  local name="$1" expect_rc="$2" expect_out="$3" actual_rc="$4" actual_out="$5"
  if [[ "$actual_rc" == "$expect_rc" && "$actual_out" == "$expect_out" ]]; then
    PASS=$((PASS+1)); echo "OK   $name"
  else
    FAIL=$((FAIL+1)); FAILED+=("$name")
    echo "FAIL $name  rc=$actual_rc (expected $expect_rc)  out='$actual_out' (expected '$expect_out')"
  fi
}

echo "=== A. pure oneline commit list passes through unchanged ==="
input=$'abc1234 Fix the thing\ndef5678abc Second commit here'
out="$(printf '%s\n' "$input" | bash "$SCRIPT")"; rc=$?
check "A: oneline passthrough" 0 "$input" "$rc" "$out"

echo "=== B. --stat output: only the commit line(s) survive, no file/count lines ==="
input=$'abc1234 Fix the thing\n src/web/local-llm.ts | 12 +++++++------\n 1 file changed, 6 insertions(+), 6 deletions(-)\n'
out="$(printf '%s' "$input" | bash "$SCRIPT")"; rc=$?
if [[ "$rc" -eq 0 && "$out" == "abc1234 Fix the thing" && "$out" != *"local-llm.ts"* && "$out" != *"insertions"* ]]; then
  PASS=$((PASS+1)); echo "OK   B: --stat lines stripped, filename+counts absent from output"
else
  FAIL=$((FAIL+1)); FAILED+=("B: --stat stripped"); echo "FAIL rc=$rc out='$out'"
fi

echo "=== C. -p (diff) output: only the commit line survives, no diff hunk/path text ==="
input=$'def5678 Patch the handler\ndiff --git a/src/web/local-llm.ts b/src/web/local-llm.ts\nindex 1111111..2222222 100644\n--- a/src/web/local-llm.ts\n+++ b/src/web/local-llm.ts\n@@ -10,3 +10,3 @@\n-old line\n+new line\n'
out="$(printf '%s' "$input" | bash "$SCRIPT")"; rc=$?
if [[ "$rc" -eq 0 && "$out" == "def5678 Patch the handler" && "$out" != *"diff --git"* && "$out" != *"old line"* && "$out" != *"new line"* ]]; then
  PASS=$((PASS+1)); echo "OK   C: diff hunk/path text stripped, only the commit line survives"
else
  FAIL=$((FAIL+1)); FAILED+=("C: diff stripped"); echo "FAIL rc=$rc out='$out'"
fi

echo "=== D. nothing-but-unsafe input (no commit line at all) -> exit 1, no stdout ==="
input=$' src/web/local-llm.ts | 12 +++++++------\n 1 file changed, 6 insertions(+), 6 deletions(-)\n'
out="$(printf '%s' "$input" | bash "$SCRIPT" 2>/dev/null)"; rc=$?
check "D: all-unsafe -> exit 1, empty stdout" 1 "" "$rc" "$out"

echo "=== E. empty input -> exit 1, no stdout ==="
out="$(printf '' | bash "$SCRIPT" 2>/dev/null)"; rc=$?
check "E: empty input -> exit 1, empty stdout" 1 "" "$rc" "$out"

echo "=== F. CR (\\r) smuggles a --stat path + hunk header onto the commit's physical line (Cybersec F1, komment 23461) ==="
input=$'abc1234 fix: tweak\r src/auth/session-keys.ts | 14 ++\r@@ -10,3 +10,3 @@\n'
out="$(printf '%s' "$input" | bash "$SCRIPT")"; rc=$?
if [[ "$rc" -eq 0 && "$out" == "abc1234 fix: tweak" && "$out" != *"session-keys.ts"* && "$out" != *"@@"* ]]; then
  PASS=$((PASS+1)); echo "OK   F: CR-joined stat/hunk stripped, only the commit subject survives"
else
  FAIL=$((FAIL+1)); FAILED+=("F: CR boundary"); echo "FAIL rc=$rc out='$out'"
fi

echo "=== G. NEL (U+0085) smuggles a path onto the SAME logical unit as a bare hash (Cybersec F1) ==="
input=$'abc1234\xc2\x85/etc/shadow\n'
out="$(printf '%s' "$input" | bash "$SCRIPT" 2>/dev/null)"; rc=$?
check "G: NEL-joined bare-hash+path -> no commit shape, exit 1" 1 "" "$rc" "$out"

echo "=== H. U+2028 LINE SEPARATOR smuggles a --stat path onto the commit's physical line (Cybersec F1) ==="
input=$'abc1234 fix: tweak\xe2\x80\xa8 src/file.ts | 3 +\n'
out="$(printf '%s' "$input" | bash "$SCRIPT")"; rc=$?
if [[ "$rc" -eq 0 && "$out" == "abc1234 fix: tweak" && "$out" != *"src/file.ts"* ]]; then
  PASS=$((PASS+1)); echo "OK   H: U+2028-joined stat path stripped, only the commit subject survives"
else
  FAIL=$((FAIL+1)); FAILED+=("H: U+2028 boundary"); echo "FAIL rc=$rc out='$out'"
fi

echo "=== I. a planted re.py in the caller's cwd (RedHat K1, komment 23553) must NOT shadow the filter's regex ==="
ITD="$(mktemp -d)"
trap 'rm -rf "$ITD"' EXIT
cat > "$ITD/re.py" <<'PYEOF'
def compile(*_a, **_k):
    class _AlwaysMatch:
        def match(self, s):
            return True
    return _AlwaysMatch()
PYEOF
input=$'abc1234 fix: tweak\n src/auth/session-keys.ts | 14 ++\n 1 file changed, 6 insertions(+), 6 deletions(-)\n'
out="$(cd "$ITD" && printf '%s' "$input" | PYTHONPATH="$ITD" bash "$SCRIPT")"; rc=$?
if [[ "$rc" -eq 0 && "$out" != *"session-keys.ts"* && "$out" != *"insertions"* ]]; then
  PASS=$((PASS+1)); echo "OK   I: shadow re.py + PYTHONPATH cannot bypass the filter"
else
  FAIL=$((FAIL+1)); FAILED+=("I: shadow re.py"); echo "FAIL rc=$rc out='$out'"
fi

echo "-------------------------------------------------------------"
echo "passed: $PASS   failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "FAILED CASES:"
  for f in "${FAILED[@]}"; do echo "  - $f"; done
  exit 1
fi
echo "All cases passed."
