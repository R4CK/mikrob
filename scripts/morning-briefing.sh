#!/bin/bash
# Marveen - Reggeli napindító
# LaunchAgent hívja minden nap 7:27-kor

export PATH="$HOME/.local/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE="$(command -v claude)"
[ -z "$CLAUDE" ] && echo "ERROR: claude not found on PATH" >&2 && exit 1
LOG="$INSTALL_DIR/store/morning.log"

# Load config
if [ -f "$INSTALL_DIR/.env" ]; then
  export $(grep -v '^#' "$INSTALL_DIR/.env" | xargs)
fi

CHAT_ID="${ALLOWED_CHAT_ID:-0}"
CALENDAR_ID="${HEARTBEAT_CALENDAR_ID:-primary}"

# --- Idempotency / sanity guard ------------------------------------------------
# The systemd timer is Persistent=true and every WSL (re)boot can re-trigger the
# briefing, so without a guard a few reboots send the "morning" message several
# times a day (and at odd hours). Two checks, both skippable with --force so the
# manual /napindito command still works on demand:
#   1) Once per calendar day -- a dated stamp file in store/.
#   2) Morning window only (06:00-11:59) for the AUTOMATED path; a 13:00 reboot
#      should not fire a "morning" briefing.
if [ "${1:-}" != "--force" ]; then
  STAMP="$INSTALL_DIR/store/.morning-sent-$(date +%Y%m%d)"
  if [ -e "$STAMP" ]; then
    echo "=== Skipped: already sent today $(date) ===" >> "$LOG"
    exit 0
  fi
  HOUR=$(date +%H)
  if [ "$HOUR" -lt 6 ] || [ "$HOUR" -gt 11 ]; then
    echo "=== Skipped: outside morning window (${HOUR}h) $(date) ===" >> "$LOG"
    exit 0
  fi
  touch "$STAMP"
fi

echo "=== Reggeli napindító $(date) ===" >> "$LOG"

cd "$INSTALL_DIR"

$CLAUDE --dangerously-skip-permissions \
  --channels plugin:telegram@claude-plugins-official \
  -p "Reggeli napindító - készítsd el és küld el Telegramra (chat_id: $CHAT_ID).

1. Email check: search_emails az elmúlt 12 órából, szűrd ki a spam/promo emaileket
2. Naptár: list-events a mai napra a $CALENDAR_ID naptárból (Europe/Budapest timezone)
3. AI hírek: WebSearch \"AI news [tegnapi dátum]\"
4. Küld el Telegramra a reply tool-lal (chat_id: $CHAT_ID)

Tömör, lényegre törő. Ékezetesen írj magyarul." >> "$LOG" 2>&1

echo "=== Kész $(date) ===" >> "$LOG"
