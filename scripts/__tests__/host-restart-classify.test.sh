#!/bin/bash
# Contract tests for host-restart-watchdog.sh prior-shutdown classifier (card RELIA-A).
# Run: bash scripts/__tests__/host-restart-classify.test.sh
#
# Hermetic: sources the watchdog with HOST_RESTART_WATCHDOG_LIB=1 so ONLY the
# helper functions load (the watchdog body never runs), and feeds the pure
# classifier real-format kernel/systemd log lines -- no journald/host state.
set -u

HERE="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1090
HOST_RESTART_WATCHDOG_LIB=1 source "$HERE/host-restart-watchdog.sh"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
ck() {
  local name="$1" exp="$2" got
  got="$(classify_shutdown_from_log "$3")"
  if [ "$got" = "$exp" ]; then pass "$name"; else fail "$name (expected '$exp', got '$got')"; fi
}

# --- OOM-kill: real kernel oom-killer signatures ---
ck "oom: Out of memory Killed process" oom "kernel: Out of memory: Killed process 1234 (node) total-vm:7000000kB"
ck "oom: invoked oom-killer" oom "kernel: bun invoked oom-killer: gfp_mask=0x100cca(GFP_HIGHUSER_MOVABLE), order=0"
ck "oom: cgroup Killed process" oom "kernel: Memory cgroup out of memory: Killed process 42 (bun) score 900"

# --- clean poweroff/reboot: systemd shutdown markers ---
ck "poweroff: Reached target Power-Off" poweroff "systemd[1]: Reached target Power-Off."
ck "poweroff: systemd-shutdown powering off" poweroff "systemd-shutdown[1]: Powering off."
ck "poweroff: Reached target Reboot" poweroff "systemd[1]: Reached target Reboot."

# --- crash: retained prior-boot log with NEITHER oom NOR a clean shutdown marker ---
ck "crash: markerless tail" crash "app: serving request
db: query ok
channels: idle -- (VM vanished here, no shutdown line)"

# --- unknown: no prior-boot log retained (WSL volatile journald) ---
ck "unknown: empty log" unknown ""

# --- precedence: OOM wins even when a shutdown marker also appears ---
ck "oom precedence over poweroff" oom "kernel: Out of memory: Killed process 9 (x)
systemd[1]: Reached target Power-Off."

echo "----"
echo "host-restart-classify: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
