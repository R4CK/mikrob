#!/bin/bash
# In-WSL liveness probe for the Windows-side WSL watchdog.
#
# Called from Windows as: wsl.exe -d <distro> -u <user> -- <this script>
# If the WSL VM / systemd is wedged, wsl.exe itself fails to run this and the
# Windows watchdog sees a non-zero exit -> that IS the total-wedge signal.
#
# Healthy (exit 0, prints OK) requires BOTH:
#   (a) the dashboard HTTP endpoint answers 200 (the app is up), and
#   (b) the channels keep-alive file is fresh (< 20 min) -- i.e. the Telegram
#       MCP pipe is still doing round-trips (not deaf).
# Anything else -> exit 1 with a short reason (the watchdog logs it).
#
# This is the OUTER net: the in-WSL systemd guards (channel-watchdog,
# stuck-modal-guard, disk-space-guard) recover component-level wedges; this
# probe only exists so Windows can catch a TOTAL VM/systemd wedge those guards
# cannot reach.
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="$(grep -E '^DASHBOARD_PORT=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
PORT="${PORT:-3420}"
KEEPALIVE="$INSTALL_DIR/store/.channel-keepalive"
STALE_SECONDS=$(( 20 * 60 ))

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://localhost:${PORT}/" 2>/dev/null || echo 000)"

now=$(date +%s)
ka=$(stat -c %Y "$KEEPALIVE" 2>/dev/null || echo 0)
age=$(( now - ka ))

if [ "$code" = "200" ] && [ "$age" -lt "$STALE_SECONDS" ]; then
  echo "OK"
  exit 0
fi

echo "UNHEALTHY dashboard_http=${code} keepalive_age=${age}s"
exit 1
