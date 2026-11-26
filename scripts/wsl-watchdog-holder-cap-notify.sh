#!/bin/bash
# In-WSL alert-only notify, called by the Windows-side WSL watchdog
# (mikrob-wsl-watchdog.ps1) when the per-window keepalive-holder relaunch cap
# is reached (card 3f6bb903, CYBERSEC NO-GO F-2 / QA FAIL / MikroB dispatch
# msg 24741+24754: an unbounded relaunch loop -- e.g. a holder that is
# launched but immediately dies again, or a persistently misfiring check --
# would otherwise pile up hidden wsl.exe+sleep processes with nothing ever
# noticing). This is a zero-argument, fixed-message script (same shape as
# wsl-watchdog-rollback-notify.sh and wsl-watchdog-unplanned-restart-notify.sh)
# deliberately: passing a free-text message as an extra wsl.exe CLI argument
# would cross the same win32->Linux argument boundary whose quoting loss is
# exactly what this card's fix for the holder check itself had to avoid.
#
# Called as: wsl.exe -d <distro> -u <user> -e bash -lc "<this script>"
# Always exits 0 -- the Windows watchdog treats this as fire-and-forget.
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$INSTALL_DIR/store/wsl-watchdog-holder-cap.log"
ENV_FILE="$HOME/.claude/channels/telegram/.env"
CHAT_ID="${MARVEEN_ALERT_CHAT_ID:-7929620734}" # Peti

ts() { date '+%Y-%m-%d %H:%M:%S'; }

notify_peti() {
  local msg="$1" token
  [[ -f "$ENV_FILE" ]] || return 0
  token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r\n')"
  [[ -n "$token" ]] || return 0
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" \
    | curl -sS --max-time 15 -K - \
      --data-urlencode "chat_id=${CHAT_ID}" \
      --data-urlencode "text=${msg}" >/dev/null 2>&1 || true
}

echo "$(ts) holder-cap-notify invoked (relaunch cap reached in the current window)" >>"$LOG"
notify_peti "MikroB: a WSL keepalive-tarto folyamat ujrainditasi korlatja elerve ebben az idoablakban -- a watchdog TOVABB NEM inditja ujra automatikusan, hogy ne halmozodjanak fel rejtett wsl.exe/sleep folyamatok. Kezi ellenorzes kell -- lasd store/wsl-watchdog-holder-cap.log."

exit 0
