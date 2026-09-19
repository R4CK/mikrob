#!/usr/bin/env bash
# local-llm-installed.selftest.sh -- coverage for local-llm-installed.sh (card 3906d77b follow-up,
# Peti Telegram 8928, 2026-09-19).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/local-llm-installed.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
FAILED=()

# A fake PATH dir holding a fake `ollama` binary, so we control "binary present" without touching
# the real host's runtime.
FAKE_BIN_DIR="$TMP/bin"
mkdir -p "$FAKE_BIN_DIR"
cat > "$FAKE_BIN_DIR/ollama" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$FAKE_BIN_DIR/ollama"

# A PATH with the standard utilities (dirname/cd/mktemp -- the script needs those to resolve its
# own location) but deliberately WITHOUT `ollama`, which on a real dev host often lives in
# ~/.local/bin (itself frequently on PATH) -- a genuinely empty/nonexistent PATH would also break
# the script's own `dirname` call, which is not what these cases are testing.
NO_OLLAMA_PATH="/usr/bin:/bin"
NO_LOCAL_BIN_DIR="/nonexistent-local-bin-$$"
FAKE_LOCAL_BIN="$TMP/local-bin"
mkdir -p "$FAKE_LOCAL_BIN"

# The script itself is invoked via `bash <path>` below, and a case wants an EMPTY PATH to prove no
# `ollama` binary is reachable -- but an empty PATH would also make the shell unable to find `bash`
# to run the script with. Resolve bash's own absolute path FIRST, before any PATH override.
BASH_ABS="$(command -v bash)"

run() { # $1 = PATH to use, $2 = LOCAL_BIN_DIR, $3 = model-file content ("" = absent)
  local model_file="$TMP/model-$RANDOM"
  if [ -n "${3+x}" ] && [ -n "$3" ]; then
    printf '%s' "$3" > "$model_file"
  fi
  PATH="$1" LOCAL_LLM_INSTALLED_LOCAL_BIN_DIR="$2" LOCAL_LLM_INSTALLED_MODEL_FILE="$model_file" \
    "$BASH_ABS" "$SCRIPT"
}

echo "=== A. BOTH PRESENT -> installed ==="
out="$(run "$FAKE_BIN_DIR:/usr/bin:/bin" "$NO_LOCAL_BIN_DIR" "hf.co/some/model:Q4")"; rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = "installed" ]; then
  PASS=$((PASS+1)); echo "OK   exit 0, 'installed'          binary on PATH + model configured"
else
  FAIL=$((FAIL+1)); FAILED+=("A: binary+model"); echo "FAIL rc=$rc out='$out'"
fi

echo "=== B. NO BINARY ANYWHERE -> not-installed ==="
out="$(run "$NO_OLLAMA_PATH" "$NO_LOCAL_BIN_DIR" "hf.co/some/model:Q4")"; rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q "^not-installed: no 'ollama' binary"; then
  PASS=$((PASS+1)); echo "OK   exit 1, not-installed        no binary on PATH or ~/.local/bin"
else
  FAIL=$((FAIL+1)); FAILED+=("B: no binary"); echo "FAIL rc=$rc out='$out'"
fi

echo "=== C. BINARY ONLY IN ~/.local/bin (not PATH) -> installed ==="
cp "$FAKE_BIN_DIR/ollama" "$FAKE_LOCAL_BIN/ollama"
out="$(run "$NO_OLLAMA_PATH" "$FAKE_LOCAL_BIN" "hf.co/some/model:Q4")"; rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = "installed" ]; then
  PASS=$((PASS+1)); echo "OK   exit 0, 'installed'          binary found via ~/.local/bin fallback"
else
  FAIL=$((FAIL+1)); FAILED+=("C: local-bin fallback"); echo "FAIL rc=$rc out='$out'"
fi

echo "=== D. BINARY PRESENT, NO MODEL CONFIGURED -> not-installed (runtime alone is not enough) ==="
out="$(run "$FAKE_BIN_DIR:/usr/bin:/bin" "$NO_LOCAL_BIN_DIR" "")"; rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q "^not-installed: no coding model configured"; then
  PASS=$((PASS+1)); echo "OK   exit 1, not-installed        binary present but no model file"
else
  FAIL=$((FAIL+1)); FAILED+=("D: no model"); echo "FAIL rc=$rc out='$out'"
fi

echo "=== E. NEITHER -> not-installed, binary reason wins (checked first) ==="
out="$(run "$NO_OLLAMA_PATH" "$NO_LOCAL_BIN_DIR" "")"; rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q "^not-installed: no 'ollama' binary"; then
  PASS=$((PASS+1)); echo "OK   exit 1, not-installed        neither present, binary reason reported"
else
  FAIL=$((FAIL+1)); FAILED+=("E: neither"); echo "FAIL rc=$rc out='$out'"
fi

echo "-------------------------------------------------------------"
echo "passed: $PASS   failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "FAILED CASES:"
  for f in "${FAILED[@]}"; do echo "  - $f"; done
  exit 1
fi
echo "All cases passed."
