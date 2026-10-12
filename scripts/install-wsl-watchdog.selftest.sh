#!/usr/bin/env bash
# install-wsl-watchdog.selftest.sh -- controls for install-wsl-watchdog.sh (card 58badae1).
#
# INCIDENT (2026-10-12 20:17, MikroB komment 17738): an earlier version of this
# selftest faked powershell.exe on PATH but left TASK_NAME and the schtasks.exe
# path as the real production values -- install-wsl-watchdog.sh calls
# schtasks.exe by its HARDCODED ABSOLUTE PATH, which a PATH-based stub can never
# intercept. The "fake" run registered a REAL Windows Scheduled Task named
# MikroB-WSL-Watchdog, overwriting a deliberate Disable, and the task restarted
# the real WSL distro ~15 minutes later.
#
# This selftest now uses ONLY the script's own INSTALL_WSL_WATCHDOG_DRY_RUN=1
# seam, which the installer script itself guarantees never calls powershell.exe
# or schtasks.exe at all (see install-wsl-watchdog.sh's own DRY_RUN branches) --
# there is no PATH stub to bypass, because the real-binary call sites are
# skipped in the script's own source, not shadowed from outside.
#
# The generated unit is Windows PowerShell -- this host cannot execute it, so
# the controls assert on the GENERATED TEXT, pinning the exact regression the
# card's NO-GO measured: the restart command must never be an immediately-
# exiting wsl.exe call again, and the fresh-boot grace window must be present.
# Needles use declaration/call-site keywords, not bare substrings (CLAUDE.md
# kódminőségi elv 12) so a comment mentioning the old command can't fake a pass.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HERE/install-wsl-watchdog.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

check() { case "$3" in *"$2"*) echo "  ok   $1" ;; *) echo "  FAIL $1 -> needle '$2' not in '$3'"; fail=1 ;; esac; }
check_absent() { case "$3" in *"$2"*) echo "  FAIL $1 -> needle '$2' unexpectedly present"; fail=1 ;; *) echo "  ok   $1" ;; esac; }

run_dry() { # $1 = scratch WSL_DIR, remaining args = extra env already exported by caller
  INSTALL_WSL_WATCHDOG_DRY_RUN=1 \
  INSTALL_WSL_WATCHDOG_DRYRUN_WSL_DIR="$1" \
  WSL_DISTRO_NAME="Ubuntu" \
  bash "$BIN" 2>&1
}

echo "install-wsl-watchdog controls"

# --- 0. safety: dry-run must require the scratch-dir seam, not silently
#        fall through to a real-looking default -------------------------------
OUT0="$(INSTALL_WSL_WATCHDOG_DRY_RUN=1 WSL_DISTRO_NAME=Ubuntu bash "$BIN" 2>&1)"; RC0=$?
if [ "$RC0" -ne 0 ]; then
  echo "  ok   dry-run without scratch dir refuses (exit $RC0)"
else
  echo "  FAIL dry-run without INSTALL_WSL_WATCHDOG_DRYRUN_WSL_DIR did not refuse"
  fail=1
fi

# --- 1. basic dry-run render ---------------------------------------------
mkdir -p "$TMP/run1"
OUT="$(run_dry "$TMP/run1")"
RC=$?
PS1_PATH="$TMP/run1/MikroB/mikrob-wsl-watchdog.ps1"

if [ "$RC" -ne 0 ]; then
  echo "  FAIL install-wsl-watchdog.sh exited $RC (output: $OUT)"
  fail=1
elif [ ! -f "$PS1_PATH" ]; then
  echo "  FAIL rendered PS1 not found at $PS1_PATH (output: $OUT)"
  fail=1
else
  check "dry-run never calls the real scheduler" "DRY-RUN: would register" "$OUT"
  check_absent "dry-run never claims real registration" "registered (every 5 min" "$OUT"

  PS1_CONTENT="$(cat "$PS1_PATH")"

  # --- F1 regression pin: the old fail mode must never reappear ------------
  check_absent "F1: '--exec /bin/true' restart command is gone" '--exec /bin/true' "$PS1_CONTENT"

  # --- F1 fix present: a detached holding process relaunches the distro ----
  check "F1: Start-Process used to relaunch (detached from this run)" "Start-Process" "$PS1_CONTENT"
  check "F1: holding process runs 'sleep infinity' inside the distro" "sleep infinity" "$PS1_CONTENT"
  check "F1: relaunch is hidden (no console flash)" "WindowStyle Hidden" "$PS1_CONTENT"

  # --- fresh-boot grace (original requirement + F follow-up) ---------------
  check "fresh-boot grace: variable declared" "\$FreshBootGraceSec" "$PS1_CONTENT"
  check "fresh-boot grace: uptime read inside wsl" "/proc/uptime" "$PS1_CONTENT"
  check "fresh-boot grace: skip marker logged distinctly" "SKIPPED, fresh boot" "$PS1_CONTENT"

  # --- unaffected behavior: MaxFails/MaxRestarts bound still intact --------
  check "MaxFails bound intact" "\$MaxFails    = 3" "$PS1_CONTENT"
  check "MaxRestarts bound intact" "\$MaxRestarts = 3" "$PS1_CONTENT"
fi

# --- configurability: default vs overridden grace window -------------------
mkdir -p "$TMP/run2"
INSTALL_WSL_WATCHDOG_DRY_RUN=1 INSTALL_WSL_WATCHDOG_DRYRUN_WSL_DIR="$TMP/run2" \
  WSL_DISTRO_NAME="Ubuntu" WSL_WATCHDOG_FRESH_BOOT_GRACE_SEC=777 bash "$BIN" >/dev/null 2>&1
PS1_PATH2="$TMP/run2/MikroB/mikrob-wsl-watchdog.ps1"
if [ -f "$PS1_PATH2" ]; then
  check "fresh-boot grace: custom value honored" '$FreshBootGraceSec = 777' "$(cat "$PS1_PATH2")"
else
  echo "  FAIL custom-grace run did not render a PS1"
  fail=1
fi

# --- idempotency: a second dry-run on the same scratch dir re-renders, does
#     not error (mirrors the script's documented idempotent re-run contract) -
OUT3="$(run_dry "$TMP/run1" 2>&1)"; RC3=$?
[ "$RC3" -eq 0 ] && echo "  ok   dry-run is idempotent (second run exit 0)" || { echo "  FAIL second dry-run exited $RC3"; fail=1; }

if [ "$fail" -eq 0 ]; then
  echo "PASS"
  exit 0
else
  echo "FAIL"
  exit 1
fi
