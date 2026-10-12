#!/bin/bash
# In-WSL liveness probe for the Windows-side WSL watchdog.
#
# Called from Windows as: wsl.exe -d <distro> -u <user> -- <this script>
# If the WSL VM / systemd is wedged, wsl.exe itself fails to run this and the
# Windows watchdog sees a non-zero exit -> that IS the total-wedge signal.
#
# Healthy (exit 0, prints OK) requires:
#   (a) the dashboard HTTP endpoint answers 200 (the app is up), AND
#   (b) the channel is not deaf -- proven EITHER by (b1) a fresh (< 20 min)
#       store/.channel-keepalive file, OR (b2), if that file is stale, a
#       direct process-tree check (same technique as
#       scripts/channel-keepalive-probe.sh) that a telegram/discord poller is
#       alive under the channels tmux session right now.
# Anything else -> exit 1 with a short reason (the watchdog logs it).
#
# WHY (b2), card 58badae1 F2: on a host where the channel-keepalive-probe
# systemd timer is not installed (measured: unit not found), the keepalive
# file's ONLY producer is organic inbound traffic -- a quiet-but-healthy
# session goes stale past 20 min and this probe reported UNHEALTHY purely for
# lack of chatter, feeding the Windows watchdog's 3x-UNHEALTHY restart
# threshold. b2 lets a genuinely alive, just-quiet session prove itself
# directly instead of depending on a separate timer's cadence.
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

# Test seams (mirrors heartbeat-scriptfirst.sh's fixture-dir pattern): a
# selftest overrides these instead of touching the live dashboard/tmux.
CURL_BIN="${WSL_LIVENESS_PROBE_CURL_BIN:-curl}"
TMUX_BIN="${WSL_LIVENESS_PROBE_TMUX_BIN:-$(command -v tmux || true)}"
PS_BIN="${WSL_LIVENESS_PROBE_PS_BIN:-ps}"

MAIN_AGENT_ID="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
MAIN_AGENT_ID="${MAIN_AGENT_ID//[^a-zA-Z0-9_-]/}"
SESSION="${WSL_LIVENESS_PROBE_SESSION:-${MAIN_AGENT_ID}-channels}"

CHANNEL_PROVIDER="$(grep -E '^CHANNEL_PROVIDER=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
CHANNEL_PROVIDER="${CHANNEL_PROVIDER:-telegram}"
CHANNEL_PROVIDER="${CHANNEL_PROVIDER//[^a-zA-Z0-9_-]/}"

# ppid_of / descends_from_pane: identical logic to channel-keepalive-probe.sh
# (kept in sync deliberately -- both answer the same question: "is a poller
# for this provider alive under the channels session's pane").
ppid_of() { "$PS_BIN" -o ppid= -p "$1" 2>/dev/null | tr -d ' '; }

descends_from_pane() {
  local pid="$1" pane_pid="$2" hops=0
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null && [ "$hops" -lt 20 ]; do
    [ "$pid" = "$pane_pid" ] && return 0
    pid="$(ppid_of "$pid")"
    hops=$(( hops + 1 ))
  done
  return 1
}

channel_pipe_alive_by_process_tree() {
  [ -z "$TMUX_BIN" ] && return 1
  "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null || return 1
  local pane_pid
  pane_pid="$("$TMUX_BIN" list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | head -1)"
  [ -z "$pane_pid" ] && return 1
  local RUNTIME_TOKEN_RX='(^|[^A-Za-z0-9_])(bun|node)([^A-Za-z0-9_]|$)'
  local cand
  while read -r cand; do
    [ -z "$cand" ] && continue
    if descends_from_pane "$cand" "$pane_pid"; then
      return 0
    fi
  done < <("$PS_BIN" -axo pid,command 2>/dev/null | grep -E "$RUNTIME_TOKEN_RX" | grep -F "/${CHANNEL_PROVIDER}/" | grep -v grep | awk '{print $1}')
  return 1
}

code="$("$CURL_BIN" -s -o /dev/null -w '%{http_code}' --max-time 8 "http://localhost:${PORT}/" 2>/dev/null || echo 000)"

now=$(date +%s)
ka=$(stat -c %Y "$KEEPALIVE" 2>/dev/null || echo 0)
age=$(( now - ka ))
keepalive_fresh=0
[ "$age" -lt "$STALE_SECONDS" ] && keepalive_fresh=1

channel_ok=0
reason=""
if [ "$keepalive_fresh" = "1" ]; then
  channel_ok=1
elif channel_pipe_alive_by_process_tree; then
  channel_ok=1
  reason=" (keepalive stale, confirmed alive via process tree)"
fi

if [ "$code" = "200" ] && [ "$channel_ok" = "1" ]; then
  echo "OK${reason}"
  exit 0
fi

echo "UNHEALTHY dashboard_http=${code} keepalive_age=${age}s channel_ok=${channel_ok}"
exit 1
