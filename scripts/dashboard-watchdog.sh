#!/bin/bash
# Dashboard health watchdog.
#
# Purpose: systemd's Restart=on-failure only catches a CRASHED process. It does
# NOT catch a dashboard whose Node process is alive but whose HTTP listener is
# hung/flapped (EMFILE, event-loop stall, wedged SSE) -- the socket accepts but
# never responds. This watchdog probes the real HTTP endpoint and restarts the
# unit when it is unreachable or unresponsive, so localhost:3420 self-heals.
#
# Dependency-free (bash + curl + systemctl only). No secret is embedded: it
# probes an UNauthenticated route (/) so no token is needed. Runs from a systemd
# user timer under linger, so it works after boot with no login. The restart
# respects the unit's KillMode=process -> running sub-agents are NOT killed.
set -u

# Portable: derive the install dir from this script's location so the same file
# works under any checkout path (fork installs, worktrees). The target unit and
# port can be overridden by the systemd unit (arg 1 / env) for rebranded installs.
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
UNIT="${1:-${MIKROB_DASH_UNIT:-mikrob-dashboard}}"
PORT="${MIKROB_DASH_PORT:-3420}"
URL="http://localhost:${PORT}/"
LOG="$INSTALL_DIR/store/dashboard-watchdog.log"
TIMEOUT=8

ts() { date '+%Y-%m-%d %H:%M:%S'; }

probe() {
  # Prints the HTTP status code, or 000 on connect-fail / timeout (hung).
  curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$URL" 2>/dev/null
}

code="$(probe)"
[ "$code" = "200" ] && exit 0   # healthy -> silent, no log spam

echo "$(ts) UNHEALTHY (http='${code:-000}') -> restart $UNIT" >>"$LOG"
systemctl --user restart "$UNIT" >>"$LOG" 2>&1

# Give the listener time to rebind, then confirm.
sleep "$TIMEOUT"
code2="$(probe)"
if [ "$code2" = "200" ]; then
  echo "$(ts) RECOVERED after restart (http=200)" >>"$LOG"
else
  echo "$(ts) STILL DOWN after restart (http='${code2:-000}') -- needs attention" >>"$LOG"
fi
exit 0
