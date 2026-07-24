#!/bin/bash
# Marveen / MikroB -- Post-update health watchdog with auto-rollback (Peti 2026-07-24)
#
# PURPOSE: make `update.sh` self-healing. update.sh pulls + rebuilds + restarts
# the services (including the dashboard that MikroB itself runs on). If the NEW
# version fails to come up, MikroB cannot roll itself back (a rollback restarts
# the mikrob-channels session, killing the very process that would run it). This
# watchdog solves that: it runs DETACHED (survives the service restart), watches
# for ~2 minutes whether the freshly-updated system actually came up healthy, and
# if NOT, automatically rolls back to the pre-update version via
# recovery-prev-version.sh, then notifies the operator on Telegram.
#
# HEALTH = dashboard (127.0.0.1:3420) returns HTTP 200  AND  the mikrob-channels
# tmux session is alive, held stable for two consecutive checks.
#
# ROLLBACK TARGET = the version we were on BEFORE the most recent update, which
# update.sh records in store/.update-history (recovery-prev-version.sh reads it
# by default). We also parse it here for logging / the Telegram message.
#
# WIRING: update.sh launches this DETACHED after its rebuild+restart:
#     setsid bash "$INSTALL_DIR/store/update-health-watchdog.sh" >/dev/null 2>&1 &
#
# MODES:
#   (default)     monitor; roll back + notify on failure.
#   --dry-run     monitor + report what it WOULD do; never rolls back (for tests).
#   --check       one health probe, print HEALTHY/UNHEALTHY, exit 0/1, no rollback.
#
# No secrets embedded: the Telegram bot token + chat id are read at call time
# from the gitignored .env. Runtime data (store/, DB, tokens) is untouched.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(cd "$HERE/.." && pwd)"
PORT="${MIKROB_DASH_PORT:-3420}"
SESSION="${MIKROB_SESSION:-mikrob-channels}"
WINDOW_S="${WATCHDOG_WINDOW_S:-120}"   # total wait before declaring failure
INTERVAL_S="${WATCHDOG_INTERVAL_S:-10}"
LOG="$INSTALL_DIR/store/update-health-watchdog.log"
RESULT="$INSTALL_DIR/store/update-watchdog-result.json"
HISTORY="$INSTALL_DIR/store/.update-history"
RECOVERY="$INSTALL_DIR/recovery-prev-version.sh"

MODE="run"
case "${1:-}" in
  --dry-run) MODE="dry" ;;
  --check)   MODE="check" ;;
  "" )       MODE="run" ;;
  *) echo "usage: $0 [--dry-run|--check]" >&2; exit 4 ;;
esac

log() { printf '%s  %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" | tee -a "$LOG" >&2; }

# --- health probe: dashboard 200 AND channels session alive ---
dashboard_up() { [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$PORT/" 2>/dev/null)" = "200" ]; }
session_up()   { tmux has-session -t "$SESSION" 2>/dev/null; }
health_ok()    { dashboard_up && session_up; }

# --- pre-update SHA from the last `update` line of .update-history (col 4 = FROM_SHA) ---
pre_update_sha() {
  [ -f "$HISTORY" ] || { echo ""; return; }
  awk -F'\t' '$2=="update"{sha=$4} END{print sha}' "$HISTORY" 2>/dev/null
}

telegram_notify() {
  local text="$1" token chat
  token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r\n')"
  chat="$(grep -E '^ALLOWED_CHAT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r\n')"
  [ -n "$token" ] && [ -n "$chat" ] || { log "telegram: no token/chat, skipping notify"; return; }
  curl -s -m 10 -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${chat}" --data-urlencode "text=${text}" >/dev/null 2>&1 \
    && log "telegram: notified" || log "telegram: notify failed"
}

write_result() { printf '{"ts":"%s","outcome":"%s","pre_update_sha":"%s","mode":"%s"}\n' \
  "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$1" "${2:-}" "$MODE" > "$RESULT" 2>/dev/null || true; }

# --- --check: single probe ---
if [ "$MODE" = "check" ]; then
  if health_ok; then echo "HEALTHY (dashboard:$PORT 200 + session:$SESSION up)"; exit 0
  else echo "UNHEALTHY (dashboard_up=$(dashboard_up && echo y || echo n) session_up=$(session_up && echo y || echo n))"; exit 1; fi
fi

# --- monitor loop ---
PRE_SHA="$(pre_update_sha)"
log "watchdog start (mode=$MODE, window=${WINDOW_S}s, pre_update_sha=${PRE_SHA:-<none>})"
deadline=$(( $(date +%s) + WINDOW_S ))
ok_streak=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  if health_ok; then
    ok_streak=$((ok_streak+1))
    log "health OK (streak=$ok_streak)"
    [ "$ok_streak" -ge 2 ] && { log "HEALTHY -- update came up cleanly, no rollback needed"; write_result healthy "$PRE_SHA"; exit 0; }
  else
    ok_streak=0
    log "health FAIL (dashboard_up=$(dashboard_up && echo y || echo n) session_up=$(session_up && echo y || echo n))"
  fi
  sleep "$INTERVAL_S"
done

# --- window expired without stable health -> failure ---
log "UNHEALTHY after ${WINDOW_S}s -- the updated system did not come up"
if [ "$MODE" = "dry" ]; then
  log "[dry-run] WOULD run: $RECOVERY ${PRE_SHA:+--to $PRE_SHA }--yes  ; then notify Telegram"
  write_result would-rollback "$PRE_SHA"
  exit 1
fi

if [ ! -x "$RECOVERY" ]; then
  log "ERROR: recovery script not executable at $RECOVERY -- cannot auto-rollback"
  telegram_notify "MikroB: a frissites NEM jott fel ${WINDOW_S}s alatt, DE a recovery script hianyzik ($RECOVERY). Kezi beavatkozas kell!"
  write_result rollback-unavailable "$PRE_SHA"
  exit 2
fi

log "AUTO-ROLLBACK -> ${PRE_SHA:-<pre-update from history>}"
if [ -n "$PRE_SHA" ]; then "$RECOVERY" --to "$PRE_SHA" --yes >>"$LOG" 2>&1; rc=$?
else "$RECOVERY" --yes >>"$LOG" 2>&1; rc=$?; fi

sleep 8
if health_ok; then
  log "rollback OK -- system healthy again on the previous version"
  telegram_notify "MikroB: a frissites megbukott (nem jott fel ${WINDOW_S}s alatt), automatikusan VISSZAALLTAM az elozo verziora (${PRE_SHA:-pre-update}). A rendszer ujra egeszseges. Nezd meg mi tortent a store/update-health-watchdog.log-ban."
  write_result rolled-back "$PRE_SHA"
  exit 0
else
  log "rollback ran (rc=$rc) but system STILL unhealthy -- manual intervention required"
  telegram_notify "MikroB: a frissites megbukott ES az auto-rollback utan is DOGLOTT a rendszer (recovery rc=$rc). SURGOS kezi beavatkozas kell! Log: store/update-health-watchdog.log"
  write_result rollback-failed "$PRE_SHA"
  exit 3
fi
