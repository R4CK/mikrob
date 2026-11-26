#!/bin/bash
# In-WSL alert-only notify, called by the Windows-side WSL watchdog
# (mikrob-wsl-watchdog.ps1) when it detects the distro's own PID 1 uptime reset
# between two ticks WITHOUT this watchdog having issued the restart itself
# (card 3f6bb903: 2026-11-25 21:56 the distro idle-terminated because its
# keepalive holder died for an unknown reason, and nothing noticed for ~14 min
# until Peti opened Windows Terminal). This script only alerts -- it does not
# roll back or restart anything, unlike wsl-watchdog-rollback-notify.sh's
# sustained-wedge path.
#
# Called as: wsl.exe -d <distro> -u <user> -e bash -lc "<this script>"
# Always exits 0 -- the Windows watchdog treats this as fire-and-forget.
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$INSTALL_DIR/store/wsl-watchdog-unplanned-restart.log"
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

echo "$(ts) unplanned-restart-notify invoked (distro uptime reset without a watchdog-issued restart)" >>"$LOG"
notify_peti "MikroB: a WSL disztribucio ujraindult/idle-terminalodott ANELKUL, hogy a watchdog ezt sajat maga inditotta volna (ismeretlen okbol megszakadt a keepalive-tarto folyamat). A watchdog mar inditott egy uj keepalive-tarto folyamatot ezen a koron, de erdemes ellenorizni, mi okozta a megszakadast -- lasd store/wsl-watchdog-unplanned-restart.log."

exit 0
