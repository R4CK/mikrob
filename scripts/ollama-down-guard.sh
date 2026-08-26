#!/bin/bash
# Ollama-down guard for the host (systemd --user timer, every 5 minutes).
#
# Incident it fixes (card 3e094b1e, audit item 6, 2026-08-26): the ollama.service stopped
# 00:07-04:52 CEST and NOBODY was told -- the dashboard tile showed it silently, and the fleet's
# local-LLM offload sweep just kept failing/routing online for hours with no alert. Mirrors
# scripts/disk-space-guard.sh's pattern: DIRECT Bot API alert (never relies on the in-session MCP
# plugin), confirmed-delivery-only cooldown stamp, best-effort/never-crashing.
#
# ollama_up() here mirrors store/local-llm.sh's own ollama_up() (same check, same endpoint) --
# not sourced from it, because that script is a straight-line CLI tool with no source-safe guard
# (sourcing it would execute an actual generation call).
#
# Test hooks (env, used only by scripts/__tests__/ollama-down-guard.test.sh):
#   OLLAMA_GUARD_UP_OVERRIDE   - "1" or "0" to force the up/down check result
#   OLLAMA_GUARD_STATE_DIR     - cooldown-stamp dir (default <install>/store)
#   OLLAMA_GUARD_ALERT_DRYRUN  - if 1, print "ALERT_DRYRUN: <msg>" not curl

set -u

OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
ALERT_COOLDOWN=3600      # at most one down-alert per hour while it stays down

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${OLLAMA_GUARD_STATE_DIR:-$INSTALL_DIR/store}"
ALERT_STAMP="$STATE_DIR/.ollama-guard-alerted"
TG_ENV="$HOME/.claude/channels/telegram/.env"
LOG_TAG="ollama-down-guard"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$LOG_TAG] $*" || true; }

# Echoes 1 (up) or 0 (down), or the test override.
ollama_up() {
  if [ -n "${OLLAMA_GUARD_UP_OVERRIDE:-}" ]; then
    echo "$OLLAMA_GUARD_UP_OVERRIDE"; return
  fi
  if curl -fsS -m 5 "$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then echo 1; else echo 0; fi
}

# DIRECT-BOT-API alert (mirrors scripts/disk-space-guard.sh alert_owner). Same reasoning: an
# Ollama outage is exactly the kind of thing that can coincide with other host trouble, so this
# does not depend on the in-session MCP plugin being alive.
alert_owner() {
  local msg="$1" token chat
  if [ "${OLLAMA_GUARD_ALERT_DRYRUN:-}" = "1" ]; then
    echo "ALERT_DRYRUN: $msg"; return 0
  fi
  token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$TG_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  chat="$(grep -E '^ALLOWED_CHAT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  [ -z "$chat" ] && chat="$(grep -E '^TELEGRAM_CHAT_ID=' "$TG_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  if [ -z "$token" ] || [ -z "$chat" ]; then
    log "ALERT (no bot token or owner chat id configured, could not Telegram): $msg"; return 1
  fi
  . "$(cd "$(dirname "$0")" && pwd)/lib/send-telegram.sh"
  local send_err
  if send_err="$(send_telegram_message "$token" "$chat" "$msg" 2>&1)"; then
    log "owner alerted via direct Bot API (delivery confirmed)"
    return 0
  fi
  log "ALERT sendMessage FAILED: ${send_err}"
  return 1
}

main() {
  local up now last
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  up="$(ollama_up)"

  if [ "$up" = "1" ]; then
    if [ -f "$ALERT_STAMP" ]; then
      log "ollama back up -- clearing alert cooldown stamp"
      rm -f "$ALERT_STAMP" 2>/dev/null || true
    fi
    return 0
  fi

  log "ollama DOWN at $OLLAMA_HOST"
  now="$(date +%s)"
  last=0; [ -f "$ALERT_STAMP" ] && last="$(cat "$ALERT_STAMP" 2>/dev/null || echo 0)"
  case "$last" in (''|*[!0-9]*) last=0;; esac
  if [ $(( now - last )) -ge "$ALERT_COOLDOWN" ]; then
    # Cooldown stamp ONLY on confirmed delivery (same rule as disk-space-guard.sh): a stamp
    # written after a failed send would suppress the retry for an hour while nobody was told.
    if alert_owner "🔴 Ollama (local-LLM) le van allva -- $OLLAMA_HOST nem valaszol. A helyi offload-sweep addig mindent online-ra rutol vagy kiesik. Ellenorizd: systemctl --user status ollama"; then
      echo "$now" > "$ALERT_STAMP" 2>/dev/null || true
    else
      log "alert not delivered -- cooldown stamp NOT written, will retry next tick"
    fi
  else
    log "ollama down but within alert cooldown ($(( now - last ))s) -- skip alert"
  fi
}

main "$@"
exit 0
