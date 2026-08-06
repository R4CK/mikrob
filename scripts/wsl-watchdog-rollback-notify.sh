#!/bin/bash
# In-WSL auto-rollback + alert, called by the Windows-side WSL watchdog
# (mikrob-wsl-watchdog.ps1) when it has already restarted the WSL distro
# MAX_RESTARTS times in a row and MikroB is STILL wedged/unreachable each time.
#
# Peti 2026-08-05: "if you can't start on the first try, try at most 2 more
# times, then restore yourself to the last working backup -- I shouldn't have
# to start WSL myself." This is that restore step: it runs INSIDE WSL (the
# Windows watchdog can still reach wsl.exe even while the MikroB app itself is
# wedged -- see wsl-watchdog.log), rolls the repo back to the last
# update-history entry, and alerts Peti over Telegram independent of whatever
# is currently broken (own curl call, not the live channels session).
#
# Called as: wsl.exe -d <distro> -u <user> -e bash -lc "<this script>"
# Always exits 0 -- the Windows watchdog treats this as fire-and-forget.
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$INSTALL_DIR/store/wsl-watchdog-rollback.log"
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

echo "$(ts) rollback-notify invoked (sustained WSL-restart wedge)" >>"$LOG"
notify_peti "MikroB: a Windows-oldali WSL watchdog tobbszor egymas utan ujraindította a WSL-t, de MikroB minden alkalommal ujra wedge-elt. AUTOMATA VISSZAALLAS indul a legutobbi mukodo verziora (recovery-prev-version.sh). Ertesitelek, ha ujra el."

"$INSTALL_DIR/recovery-prev-version.sh" --yes >>"$LOG" 2>&1
rc=$?

if [ "$rc" -eq 0 ]; then
  echo "$(ts) recovery-prev-version.sh exit=0" >>"$LOG"
  notify_peti "MikroB: az automata visszaallas lefutott. Ha percen belul nem jelentkezem, kezi ellenorzes kell."
else
  echo "$(ts) recovery-prev-version.sh exit=$rc (FAILED)" >>"$LOG"
  notify_peti "MikroB: az automata visszaallas SIKERTELEN (exit=$rc). Kezi beavatkozas kell -- lasd store/wsl-watchdog-rollback.log."
fi

exit 0
