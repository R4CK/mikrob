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

# Peti 2026-08-05: "if you can't start on the first try, try 2 more times,
# then restore yourself to the last working backup" -- FAIL_STREAK persists
# across restarts AND across WSL-VM reboots (plain file in store/, unaffected
# by the VM dying), so a boot-crash-loop (VM itself rebooting every ~5min,
# not just this process crashing) is caught too: each new boot's watchdog
# tick still reads the same counter. 3 consecutive unhealthy ticks (this one
# + 2 retries) => auto-rollback via recovery-prev-version.sh, non-interactive.
FAIL_STREAK_FILE="$INSTALL_DIR/store/.dashboard-fail-streak"
ROLLBACK_COOLDOWN_FILE="$INSTALL_DIR/store/.dashboard-autorollback-stamp"
ROLLBACK_COOLDOWN_SEC=3600 # don't auto-rollback more than once/hour
FAIL_THRESHOLD=3
ALERT_CHAT_ID="${MARVEEN_ALERT_CHAT_ID:-7929620734}" # Peti
ENV_FILE="${TELEGRAM_ENV:-$HOME/.claude/channels/telegram/.env}"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

probe() {
  # Prints the HTTP status code, or 000 on connect-fail / timeout (hung).
  curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$URL" 2>/dev/null
}

read_streak() {
  local n
  n="$(tr -dc '0-9' <"$FAIL_STREAK_FILE" 2>/dev/null)"
  echo "${n:-0}"
}

# Best-effort standalone Telegram alert (independent of the mikrob-channels
# session, which may itself be the thing that's down) -- same pattern as
# token-health-guard.sh: token only ever reaches curl via stdin config, never
# argv/logs.
notify_peti() {
  local msg="$1" token
  [[ -f "$ENV_FILE" ]] || return 0
  token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r\n')"
  [[ -n "$token" ]] || return 0
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" \
    | curl -sS --max-time 15 -K - \
      --data-urlencode "chat_id=${ALERT_CHAT_ID}" \
      --data-urlencode "text=${msg}" >/dev/null 2>&1 || true
}

trigger_autorollback() {
  local now prev=0
  now="$(date +%s)"
  [[ -f "$ROLLBACK_COOLDOWN_FILE" ]] && prev="$(tr -dc '0-9' <"$ROLLBACK_COOLDOWN_FILE" 2>/dev/null)"
  prev="${prev:-0}"
  if ((now - prev < ROLLBACK_COOLDOWN_SEC)); then
    echo "$(ts) auto-rollback SKIPPED (cooldown, last at epoch $prev)" >>"$LOG"
    return 0
  fi
  echo "$now" >"$ROLLBACK_COOLDOWN_FILE" 2>/dev/null || true
  echo "$(ts) auto-rollback TRIGGERED after $FAIL_THRESHOLD consecutive unhealthy ticks" >>"$LOG"
  notify_peti "MikroB: $FAIL_THRESHOLD egymást követő sikertelen indítási kísérlet után AUTOMATA VISSZAÁLLÁS indul a legutóbbi működő verzióra (recovery-prev-version.sh). Értesítelek, ha újra él."
  "$INSTALL_DIR/recovery-prev-version.sh" --yes >>"$LOG" 2>&1
  echo "0" >"$FAIL_STREAK_FILE" 2>/dev/null || true
  sleep "$TIMEOUT"
  code3="$(probe)"
  if [ "$code3" = "200" ]; then
    echo "$(ts) auto-rollback RECOVERED (http=200)" >>"$LOG"
    notify_peti "MikroB: az automata visszaállás sikeres, élek (dashboard 200)."
  else
    echo "$(ts) auto-rollback: still down after rollback (http='${code3:-000}') -- needs manual attention" >>"$LOG"
    notify_peti "MikroB: az automata visszaállás LEFUTOTT, de a dashboard még mindig nem válaszol. Kézi beavatkozás kell."
  fi
}

code="$(probe)"
if [ "$code" = "200" ]; then
  # healthy -> silent, no log spam; clear any accumulated failure streak
  [[ -f "$FAIL_STREAK_FILE" ]] && rm -f "$FAIL_STREAK_FILE" 2>/dev/null
  exit 0
fi

echo "$(ts) UNHEALTHY (http='${code:-000}') -> restart $UNIT" >>"$LOG"
systemctl --user restart "$UNIT" >>"$LOG" 2>&1

# Give the listener time to rebind, then confirm.
sleep "$TIMEOUT"
code2="$(probe)"
if [ "$code2" = "200" ]; then
  echo "$(ts) RECOVERED after restart (http=200)" >>"$LOG"
  rm -f "$FAIL_STREAK_FILE" 2>/dev/null
else
  streak=$(( $(read_streak) + 1 ))
  echo "$streak" >"$FAIL_STREAK_FILE" 2>/dev/null || true
  echo "$(ts) STILL DOWN after restart (http='${code2:-000}') -- fail streak $streak/$FAIL_THRESHOLD" >>"$LOG"
  if ((streak >= FAIL_THRESHOLD)); then
    trigger_autorollback
  fi
fi
exit 0
