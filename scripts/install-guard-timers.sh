#!/bin/bash
# Install the independent resilience guard timers as systemd --user units.
#
# WHY: the dashboard has an in-process channel-monitor that respawns a wedged
# channels session, but it dies WITH the dashboard. These three timers are
# INDEPENDENT of the dashboard process, so a wedged/deaf/disk-full box still
# self-recovers. They exist as templates in scripts/systemd/ but were never
# installed on this host (only mikrob-dashboard-watchdog was). This script
# renders them with real host values and enables them. Idempotent: re-running
# just rewrites + re-enables.
#
#   mikrob-channel-watchdog  (5 min) : stale keepalive => respawn ONLY the
#                                      channels pane (never the fleet / WSL).
#   mikrob-stuck-modal-guard (1 min) : close a wedged /mcp modal that silently
#                                      swallows inbound Telegram.
#   mikrob-disk-space-guard  (1 min) : reap scratch + alert before root fs fills
#                                      (a full disk wedges the whole session).
#   mikrob-load-guard        (7 sec) : PSI/loadavg admission-brake tick (card
#                                      edd8b398) -- NOT dashboard-independence
#                                      motivated like the three above, just
#                                      needs a much faster cadence than a
#                                      heartbeat cron tick can give it.
#
# Surgical by design: recovery respawns only the affected component. Restarting
# the WSL VM is deliberately NOT done here -- it would SIGKILL all fleet agents
# + the dashboard, turning a one-session hiccup into a full outage.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
STORE="$INSTALL_DIR/store"

# Prefer an already-exported MAIN_AGENT_ID (install-linux.sh passes it), else
# read it from .env, else the brand-unaware default.
MAIN_AGENT_ID="${MAIN_AGENT_ID:-$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)}"
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
MAIN_AGENT_ID="${MAIN_AGENT_ID//[^a-zA-Z0-9_-]/}"

PATH_ENV="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
mkdir -p "$UNIT_DIR"

# args: <name> <desc> <script> <output-mode: log|journal>
write_service() {
  local name="$1" desc="$2" script="$3" outmode="$4"
  local out
  if [ "$outmode" = "log" ]; then
    out="StandardOutput=append:$STORE/$name.log
StandardError=append:$STORE/$name.log"
  else
    out="StandardOutput=journal
StandardError=journal"
  fi
  cat > "$UNIT_DIR/${MAIN_AGENT_ID}-${name}.service" <<EOF
[Unit]
Description=$desc
After=${MAIN_AGENT_ID}-channels.service ${MAIN_AGENT_ID}-dashboard.service

[Service]
Type=oneshot
ExecStart=$INSTALL_DIR/scripts/$script
Environment=PATH=$PATH_ENV
Environment=HOME=$HOME
Environment=TZ=Europe/Budapest
$out
EOF
}

# args: <name> <desc> <onboot-sec> <interval-sec>
write_timer() {
  local name="$1" desc="$2" onboot="$3" interval="$4"
  cat > "$UNIT_DIR/${MAIN_AGENT_ID}-${name}.timer" <<EOF
[Unit]
Description=$desc

[Timer]
OnBootSec=$onboot
OnUnitActiveSec=$interval
AccuracySec=15s
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

write_service channel-watchdog  "MikroB channels watchdog (independent net for a wedged channels session)" channel-watchdog.sh  log
write_timer   channel-watchdog  "Run the MikroB channels watchdog every 5 minutes"                            2min 5min

write_service stuck-modal-guard "MikroB stuck-modal guard (close a wedged /mcp modal in the channels session)" stuck-modal-guard.sh journal
write_timer   stuck-modal-guard "Run the MikroB stuck-modal guard every minute"                                150s 60s

write_service disk-space-guard  "MikroB disk-space guard (reap scratch + alert before root fs fills)"          disk-space-guard.sh  journal
write_timer   disk-space-guard  "Run the MikroB disk-space guard every minute"                                 90s  60s

write_service token-health-guard "MikroB bot-token health guard (getMe probe -> alert on a revoked/expired token)" token-health-guard.sh log
write_timer   token-health-guard "Run the MikroB bot-token health guard every 15 minutes"                          5min 15min

# Card edd8b398 (load-brake phase 19f3bbb5, Feladat 1's systemd wiring): a load spike needs a much
# faster cadence than the other guards above, so it gets its own tighter timer. The script lives in
# store/ (with the rest of the load-guard family), not scripts/ like the others -- write_service
# hardcodes an scripts/$script ExecStart, so the "../store/..." relative hop reaches it without
# changing that shared helper's assumption for every other entry in this file. journal, not log
# mode: the script does its own selective append to store/load-guard.log (only on a state CHANGE,
# card's own request), so mirroring every 7s tick's stdout into a second file would defeat that.
write_service load-guard "MikroB load-guard tick (PSI/loadavg admission-brake state machine)" ../store/load-guard-daemon.sh journal
write_timer   load-guard "Run the MikroB load-guard tick every 7 seconds"                      15s  7s

echo "Rendered guard-timer units for MAIN_AGENT_ID=$MAIN_AGENT_ID into $UNIT_DIR"

# Enable only if a working user systemd is present. During a fresh headless /
# WSL install systemctl --user may be unavailable; the unit files are already
# on disk, so startup.sh (which re-invokes this script) enables them once the
# user session exists. Never hard-fail the caller (install-linux.sh) over this.
if pidof systemd >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
  systemctl --user daemon-reload || true
  for t in channel-watchdog stuck-modal-guard disk-space-guard token-health-guard load-guard; do
    systemctl --user enable --now "${MAIN_AGENT_ID}-${t}.timer" || echo "  warn: could not enable ${MAIN_AGENT_ID}-${t}.timer"
  done
  echo "Enabled guard timers:"
  systemctl --user list-timers "${MAIN_AGENT_ID}-*" --all --no-pager || true
else
  echo "user systemd not available now -- units rendered; startup.sh will enable them on next start."
fi
