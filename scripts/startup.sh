#!/bin/bash
# WSL logon / boot ensure script.
#
# Called by the Windows Task Scheduler "MikroB Autostart" task at logon
# (wsl.exe -d Ubuntu -u neon -e bash -lc ".../scripts/startup.sh"). Its job is
# to make the stack self-consistent whenever the VM comes up: enable linger,
# and ensure the dashboard + health-watchdog are running. It is fully idempotent
# and NEVER restarts an already-healthy service (so logging in does not disrupt a
# running dashboard or the channels tmux session).
#
# Note: mikrob-channels is intentionally NOT touched here. It auto-starts at boot
# via its own enabled unit and runs in a shared tmux session; a `start`/`restart`
# from the logon path could recycle that session and drop the live channel. Boot
# already brought it up before this logon script runs.
set -u

INSTALL_DIR="/home/neon/marveen"
LOG="$INSTALL_DIR/store/startup.log"
ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "$(ts) $*" >>"$LOG"; }

log "startup.sh: logon/boot ensure begin"

# systemctl --user needs these when invoked from a non-interactive wsl -lc shell.
[ -z "${XDG_RUNTIME_DIR:-}" ] && export XDG_RUNTIME_DIR="/run/user/$(id -u)"
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "${XDG_RUNTIME_DIR}/bus" ]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
fi

# 1. Linger: keep user services alive after logout and start them at boot.
if ! loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
  loginctl enable-linger "$USER" 2>>"$LOG" && log "linger enabled" || log "linger enable failed (needs sudo)"
fi

if ! (pidof systemd >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1); then
  log "systemd --user unavailable -- nothing to ensure"
  exit 0
fi

# 2. Dashboard: start only if not already active (idempotent, non-disruptive).
if systemctl --user is-active --quiet mikrob-dashboard.service; then
  log "dashboard already active"
else
  systemctl --user start mikrob-dashboard.service 2>>"$LOG" && log "dashboard started" || log "dashboard start FAILED"
fi

# 3. Health watchdog timer: ensure it is enabled + running so 3420 self-heals.
if systemctl --user list-unit-files 2>/dev/null | grep -q '^mikrob-dashboard-watchdog.timer'; then
  systemctl --user enable --now mikrob-dashboard-watchdog.timer 2>>"$LOG" \
    && log "watchdog timer ensured" || log "watchdog timer ensure FAILED"
else
  log "watchdog timer unit not installed (run install-linux.sh)"
fi

log "startup.sh: done"
exit 0
