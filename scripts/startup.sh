#!/bin/bash
# MikroB boot launcher -- meant to be triggered by Windows Task Scheduler at
# logon (via wsl.exe). Boots the MikroB stack (dashboard on :3420 + the
# Telegram channels bridge) idempotently, so a double-fire of the logon trigger
# will not spawn a second dashboard.
#
# Task Scheduler action (see scripts/README or the Telegram notes):
#   Program:   C:\Windows\System32\wsl.exe
#   Arguments: -d Ubuntu -u neon -e bash -lc "/home/neon/marveen/scripts/startup.sh"
#
# Because /etc/wsl.conf has systemd=true, the distro stays alive after this
# script exits (systemd is PID 1), so the nohup'd processes keep running.

set -u

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$INSTALL_DIR/store/startup.log"
mkdir -p "$INSTALL_DIR/store"

# Make sure a login-shell PATH/TZ is present even when Task Scheduler launches
# us with a minimal environment.
export HOME="${HOME:-/home/neon}"
export TZ="${TZ:-Europe/Budapest}"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

ts() { date "+%Y-%m-%d %H:%M:%S %Z"; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

log "startup.sh begin (install=$INSTALL_DIR)"

# --- Idempotency guard: if the dashboard already answers, assume the stack is
#     up and do nothing. Prevents a second dashboard if logon fires twice. ---
if curl -fsS --max-time 3 -o /dev/null "http://localhost:3420/" 2>/dev/null; then
  log "dashboard already responding on :3420 -- nothing to do"
  exit 0
fi

# Delegate the actual launch to the canonical start.sh, which already handles
# real-node detection (bun cannot run better-sqlite3), build-if-missing, the
# systemd-vs-direct branch, and the channels bridge.
log "stack not up -- invoking scripts/start.sh"
bash "$INSTALL_DIR/scripts/start.sh" >> "$LOG" 2>&1
rc=$?
log "scripts/start.sh exited rc=$rc"

# Give the dashboard a moment, then record whether it came up.
for i in $(seq 1 15); do
  if curl -fsS --max-time 3 -o /dev/null "http://localhost:3420/" 2>/dev/null; then
    log "dashboard is up on :3420 (after ${i}s)"
    exit 0
  fi
  sleep 1
done

log "WARNING: dashboard did not answer on :3420 within 15s -- check store/dashboard.log"
exit "$rc"
