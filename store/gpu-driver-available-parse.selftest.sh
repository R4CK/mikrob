#!/usr/bin/env bash
# gpu-driver-available-parse.selftest.sh -- controls for gpu-driver-available-parse.sh (card 9482a764).
#
# Every case runs against a FAKE AjaxDriverService response and a fake check-bin recording its own
# invocation, so the run never touches the real NVIDIA API or the real gpu-driver-state.json.
#
# Usage: store/gpu-driver-available-parse.selftest.sh   (exit 0 = PASS, 1 = FAIL)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HERE/gpu-driver-available-parse.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

check() { # $1 = label, $2 = expected, $3 = actual
  if [ "$3" = "$2" ]; then echo "  ok   $1 -> $3"
  else echo "  FAIL $1 -> got '$3', expected '$2'"; fail=1; fi
}

# Fake --set-available recorder, standing in for gpu-driver-check.sh.
FAKE_CHECK="$TMP/fake-gpu-driver-check.sh"
cat > "$FAKE_CHECK" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$FAKE_CHECK_CALLS"
EOF
chmod +x "$FAKE_CHECK"

run() { # $1 = driver-type, $2 = json string, sets RC and CALLS
  : > "$TMP/calls.txt"
  RC=0
  printf '%s' "$2" | GPU_DRIVER_AVAILABLE_CHECK_BIN="$FAKE_CHECK" FAKE_CHECK_CALLS="$TMP/calls.txt" \
    bash "$BIN" --driver-type "$1" >/dev/null 2>"$TMP/stderr.txt" || RC=$?
  CALLS="$(cat "$TMP/calls.txt" 2>/dev/null)"
}

echo "gpu-driver-available-parse controls"

# --- 1. POSITIVE: grd entry present and matched, set-available called with its version. --------
run grd '{"Success":1,"IDS":[{"downloadInfo":{"Version":"572.74","IsCRD":0}}]}'
check "positive grd: exit 0"             "0"                    "$RC"
check "positive grd: --set-available call" "--set-available 572.74" "$CALLS"

# --- 2. POSITIVE: crd requested, IsCRD=1 entry picked over an earlier IsCRD=0 one. ---------------
run crd '{"Success":1,"IDS":[{"downloadInfo":{"Version":"572.70","IsCRD":0}},{"downloadInfo":{"Version":"572.74","IsCRD":1}}]}'
check "positive crd: picks matching IsCRD entry" "--set-available 572.74" "$CALLS"

# --- 3. NEGATIVE: driver type not present in results -> no call, exit 1. -------------------------
run grd '{"Success":1,"IDS":[{"downloadInfo":{"Version":"572.74","IsCRD":1}}]}'
check "no matching IsCRD: exit 1" "1" "$RC"
check "no matching IsCRD: no set-available call" "" "$CALLS"

# --- 4. NEGATIVE: Success=0 -> no call, exit 1. ---------------------------------------------------
run grd '{"Success":0,"IDS":[]}'
check "Success=0: exit 1" "1" "$RC"
check "Success=0: no set-available call" "" "$CALLS"

# --- 5. NEGATIVE: malformed JSON -> no call, exit 1, no crash. -----------------------------------
run grd 'not json at all'
check "malformed json: exit 1" "1" "$RC"
check "malformed json: no set-available call" "" "$CALLS"

# --- 6. NEGATIVE: version string not dotted-numeric -> rejected even though Success/IDS are fine. -
run grd '{"Success":1,"IDS":[{"downloadInfo":{"Version":"N/A","IsCRD":0}}]}'
check "non-numeric version: exit 1" "1" "$RC"
check "non-numeric version: no set-available call" "" "$CALLS"

# --- 7. Bad CLI usage -> exit 2 (not 1, so a usage error is never confused with a parse failure). -
RC=0
: | bash "$BIN" --driver-type bogus >/dev/null 2>&1 || RC=$?
check "bad --driver-type: exit 2" "2" "$RC"

# --- 8. WhiteHat2 N2 regression: Success arrives as the STRING "0", not the int 0 -- Python
# truthiness of a non-empty string would let this through as success (card 8b588834 precondition).
run grd '{"Success":"0","IDS":[{"downloadInfo":{"Version":"572.74","IsCRD":0}}]}'
check "N2 Success string \"0\": exit 1" "1" "$RC"
check "N2 Success string \"0\": no set-available call" "" "$CALLS"

# --- 9. WhiteHat2 N3 regression: two matching IsCRD=0 entries, the LARGER version is NOT first. --
run grd '{"Success":1,"IDS":[{"downloadInfo":{"Version":"572.74","IsCRD":0}},{"downloadInfo":{"Version":"581.29","IsCRD":0}}]}'
check "N3 largest-wins, not first-wins" "--set-available 581.29" "$CALLS"

# --- 10. WhiteHat2 N1 regression: an absurdly large version segment is rejected (upper bound). ----
run grd '{"Success":1,"IDS":[{"downloadInfo":{"Version":"99999999999.1","IsCRD":0}}]}'
check "N1 oversized segment: exit 1" "1" "$RC"
check "N1 oversized segment: no set-available call" "" "$CALLS"

# --- 11. WhiteHat2 N1 regression: an all-zero version is rejected (never a real driver release). -
run grd '{"Success":1,"IDS":[{"downloadInfo":{"Version":"0.0.0","IsCRD":0}}]}'
check "N1 all-zero version: exit 1" "1" "$RC"
check "N1 all-zero version: no set-available call" "" "$CALLS"

if [ "$fail" -eq 0 ]; then
  echo "selftest: PASS"
  exit 0
else
  echo "selftest: FAIL"
  exit 1
fi
