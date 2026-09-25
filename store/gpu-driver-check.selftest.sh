#!/usr/bin/env bash
# gpu-driver-check.selftest.sh -- controls for gpu-driver-check.sh (card f268629c).
#
# Every case runs against fakes so the run is reproducible off this specific host (whose real
# numbers -- 616.92 host / 615.71.08 WSL-package -- change under us the next time Peti updates the
# driver, and would silently make this suite describe a host that no longer exists).
#
# Usage: store/gpu-driver-check.selftest.sh   (exit 0 = PASS, 1 = FAIL)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HERE/gpu-driver-check.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

field() { python3 -c 'import json,sys; d=json.load(sys.stdin); v=d.get(sys.argv[1]); print("null" if v is None else v)' "$1"; }

check() { # $1 = label, $2 = expected, $3 = actual
  if [ "$3" = "$2" ]; then echo "  ok   $1 -> $3"
  else echo "  FAIL $1 -> got '$3', expected '$2'"; fail=1; fi
}

mkfake_smi() { # $1 = version string to print (CRLF-terminated, like the real .exe)
  local p="$TMP/fake-nvidia-smi.exe"
  { printf '#!/usr/bin/env bash\n'
    printf "printf '%s\\\\r\\\\n'\n" "$1"
  } > "$p"
  chmod +x "$p"
  echo "$p"
}

mklib() { # $1 = wsl-lib dir, $2 = version suffix, $3 = mtime (touch -d arg)
  local f="$1/libnvidia-gpucomp.so.$2"
  : > "$f"
  touch -d "$3" "$f"
}

echo "gpu-driver-check controls"

# --- 1. POSITIVE: both sides read, and they legitimately DIFFER (the exact real-host shape). ------
LIBDIR1="$TMP/wsl-lib-1"; mkdir -p "$LIBDIR1"
mklib "$LIBDIR1" "610.10.00" "2026-08-25"
mklib "$LIBDIR1" "615.71.08" "2026-09-19"
SMI_GOOD="$(mkfake_smi 616.92)"
STATE1="$TMP/state1.json"
out="$(GPU_DRIVER_CHECK_HOST_SMI="$SMI_GOOD" GPU_DRIVER_CHECK_WSL_LIB_DIR="$LIBDIR1" GPU_DRIVER_CHECK_STATE="$STATE1" bash "$BIN")"
check "host version parsed (CRLF stripped)"   "616.92"    "$(echo "$out" | field installedHost)"
check "wsl version = NEWEST symlink by mtime, not first-glob-order" "615.71.08" "$(echo "$out" | field installedWsl)"
check "available starts null"                 "null"      "$(echo "$out" | field available)"

# --- 2. FAIL-SOFT: neither source exists -> nulls, exit 0, no crash. --------------------------
STATE2="$TMP/state2.json"
out="$(GPU_DRIVER_CHECK_HOST_SMI="$TMP/absent.exe" GPU_DRIVER_CHECK_WSL_LIB_DIR="$TMP/absent-lib" GPU_DRIVER_CHECK_STATE="$STATE2" bash "$BIN")"
rc=$?
check "missing sources: exit 0, not a crash" "0"    "$rc"
check "missing sources: installedHost null"  "null" "$(echo "$out" | field installedHost)"
check "missing sources: installedWsl null"   "null" "$(echo "$out" | field installedWsl)"

# --- 3. FAIL-SOFT: host smi exists but exits nonzero (driver momentarily unreadable). ----------
BADSMI="$TMP/bad-smi.exe"
printf '#!/usr/bin/env bash\nexit 1\n' > "$BADSMI"; chmod +x "$BADSMI"
STATE3="$TMP/state3.json"
out="$(GPU_DRIVER_CHECK_HOST_SMI="$BADSMI" GPU_DRIVER_CHECK_WSL_LIB_DIR="$TMP/absent-lib" GPU_DRIVER_CHECK_STATE="$STATE3" bash "$BIN")"
check "failing smi binary: installedHost null, no crash" "null" "$(echo "$out" | field installedHost)"

# --- 4. THE SEAM: --set-available patches ONLY available, carries installed*/lastAlertedAvailable.
STATE4="$TMP/state4.json"
GPU_DRIVER_CHECK_HOST_SMI="$SMI_GOOD" GPU_DRIVER_CHECK_WSL_LIB_DIR="$LIBDIR1" GPU_DRIVER_CHECK_STATE="$STATE4" bash "$BIN" >/dev/null
out="$(GPU_DRIVER_CHECK_STATE="$STATE4" bash "$BIN" --set-available 620.00)"
check "set-available: available updated"      "620.00" "$(echo "$out" | field available)"
check "set-available: installedHost carried"  "616.92" "$(echo "$out" | field installedHost)"
check "set-available: installedWsl carried"   "615.71.08" "$(echo "$out" | field installedWsl)"
check "set-available: lastAlerted still null" "null"   "$(echo "$out" | field lastAlertedAvailable)"

out="$(GPU_DRIVER_CHECK_STATE="$STATE4" bash "$BIN" --mark-alerted 620.00)"
check "mark-alerted: lastAlerted set"         "620.00" "$(echo "$out" | field lastAlertedAvailable)"
check "mark-alerted: available carried"       "620.00" "$(echo "$out" | field available)"

# A later plain detection run must NOT wipe available/lastAlertedAvailable set by the two commands
# above -- this is the exact bug a naive "always write a fresh object" implementation would have.
out="$(GPU_DRIVER_CHECK_HOST_SMI="$SMI_GOOD" GPU_DRIVER_CHECK_WSL_LIB_DIR="$LIBDIR1" GPU_DRIVER_CHECK_STATE="$STATE4" bash "$BIN")"
check "re-detect: available survives"         "620.00" "$(echo "$out" | field available)"
check "re-detect: lastAlerted survives"       "620.00" "$(echo "$out" | field lastAlertedAvailable)"

# --- 5. --compare: dotted numeric, uneven segment counts, garbage input. -----------------------
check "compare: 616.92 gt 615.71.08"   "gt" "$(bash "$BIN" --compare 616.92 615.71.08)"
check "compare: 615.71.08 lt 616.92"   "lt" "$(bash "$BIN" --compare 615.71.08 616.92)"
check "compare: equal"                 "eq" "$(bash "$BIN" --compare 616.92 616.92)"
check "compare: 616.92 eq 616.92.0 (zero-pad, not shorter-wins)" "eq" "$(bash "$BIN" --compare 616.92 616.92.0)"
check "compare: garbage input never crashes, answers eq" "eq" "$(bash "$BIN" --compare "" 616.92)"

# --- 6. write_state creates a missing parent directory rather than crashing (real deploy path may
#     not have store/ pre-created for a custom GPU_DRIVER_CHECK_STATE override). ------------------
STATE6="$TMP/nested/deeper/state.json"
GPU_DRIVER_CHECK_HOST_SMI="$SMI_GOOD" GPU_DRIVER_CHECK_WSL_LIB_DIR="$LIBDIR1" GPU_DRIVER_CHECK_STATE="$STATE6" bash "$BIN" >/dev/null
check "write_state creates missing parent dirs" "1" "$([ -f "$STATE6" ] && echo 1 || echo 0)"

# --- 7. FORMAT VALIDATION (card e3846ccc, Cybersec LOW): a version string that is not
#     dotted-numeric must not enter state, from EITHER source. Placed AFTER every other section
#     that still relies on $SMI_GOOD (sections 1, 4, 6) -- mkfake_smi always (re)writes the SAME
#     file path, so an earlier call here would silently overwrite the fixture those sections read. ---
STATE7A="$TMP/state7a.json"
SMI_GARBAGE="$(mkfake_smi 'unknown (VBIOS mismatch)')"
out="$(GPU_DRIVER_CHECK_HOST_SMI="$SMI_GARBAGE" GPU_DRIVER_CHECK_WSL_LIB_DIR="$TMP/absent-lib" GPU_DRIVER_CHECK_STATE="$STATE7A" bash "$BIN")"
check "non-numeric host smi output -> installedHost null, not the raw string" "null" "$(echo "$out" | field installedHost)"

LIBDIR7B="$TMP/wsl-lib-7b"; mkdir -p "$LIBDIR7B"
mklib "$LIBDIR7B" "beta-corrupt" "2026-09-19"
STATE7B="$TMP/state7b.json"
out="$(GPU_DRIVER_CHECK_HOST_SMI="$TMP/absent.exe" GPU_DRIVER_CHECK_WSL_LIB_DIR="$LIBDIR7B" GPU_DRIVER_CHECK_STATE="$STATE7B" bash "$BIN")"
check "non-numeric wsl symlink suffix -> installedWsl null, not the raw string" "null" "$(echo "$out" | field installedWsl)"

# --- 8. PIN THE 'head -1' TRUNCATION (card e3846ccc, Cybersec LOW): removing it was measured to
#     leave all existing cases green while a two-line fake smi output got into the state file.
#     A two-line output must resolve to ONLY the first line -- not null, not the whole blob. ------
STATE8="$TMP/state8.json"
SMI_TWOLINE="$(mkfake_smi $'616.92\r\n999.99')"
out="$(GPU_DRIVER_CHECK_HOST_SMI="$SMI_TWOLINE" GPU_DRIVER_CHECK_WSL_LIB_DIR="$TMP/absent-lib" GPU_DRIVER_CHECK_STATE="$STATE8" bash "$BIN")"
check "two-line smi output -> only the first line is kept (head -1 pin)" "616.92" "$(echo "$out" | field installedHost)"

echo
if [ "$fail" -eq 0 ]; then
  # "selftest: PASS" (no count of its own) matches the OK_SHAPES entry shared by
  # sync-agent-templates/gate-dispatch-check/etc in store-selftests-all-run.test.ts -- the
  # non-vacuous guarantee comes from the "ok   <label>" lines already printed above it.
  echo "selftest: PASS"
  exit 0
else
  echo "selftest: FAIL"
  exit 1
fi
