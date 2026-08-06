#!/usr/bin/env bash
# token-health-guard.sh (card RELIA-B / 664a99d5) -- periodic bot-token validity probe.
#
# The channel-deafness / liveness watchdogs only ever see the SYMPTOM (silence).
# A REVOKED or EXPIRED Telegram bot token ALSO causes silence, but the fix is
# different (mint a new token in BotFather). This guard probes getMe -- the same
# check as src/channel-provider.ts validateToken -- and, on a 401 / ok:false,
# records the cause and sends ONE deduped alert naming it, so a dead token is
# DIAGNOSED, not mistaken for a generic deafness/crash.
#
# TRUST BOUNDARY (Cybersec): the token is NEVER logged, echoed, or placed on
# argv. It is read into a shell var and handed to curl through a stdin config
# (-K -); printf is a bash builtin (no fork), so the token never appears in any
# process's /proc/<pid>/cmdline. Only the CLASSIFICATION (ok/invalid/error) is
# ever written to logs/state.
#
# Chicken-and-egg: a revoked Telegram token cannot alert via that same bot, so
# the DURABLE signal is a status file (store/.token-health-status) the dashboard
# / a healthy channel / the operator can read. The Telegram alert is best-effort
# on top and prefers a separate MARVEEN_ALERT_BOT_TOKEN when configured.
#
# Safe by construction: read-only except its own state files; always exits 0.

set -uo pipefail

STATE_DIR="${MARVEEN_STORE:-$HOME/marveen/store}"
STATUS_FILE="$STATE_DIR/.token-health-status" # "STATE epoch"
ALERT_STAMP="$STATE_DIR/.token-health-alert"  # epoch of last INVALID alert (dedup)
ENV_FILE="${TELEGRAM_ENV:-$HOME/.claude/channels/telegram/.env}"
CHAT_ID="${MARVEEN_ALERT_CHAT_ID:-}"
ALERT_COOLDOWN="${TOKEN_HEALTH_COOLDOWN:-3600}" # seconds between repeat INVALID alerts
API_BASE="${TELEGRAM_API_BASE:-https://api.telegram.org}" # test/self-host hook

log() { echo "[token-health-guard] $*"; }

# Probe the Telegram bot token via getMe. Echoes EXACTLY one of: ok|invalid|error.
# Leak-safe: the token reaches curl via a stdin config (never argv/logs); only
# the classification is returned (never the response body verbatim).
probe_telegram_token() {
  local token="$1" resp code body
  resp="$(printf 'url = "%s/bot%s/getMe"\n' "$API_BASE" "$token" \
    | curl -sS --max-time 15 -K - -w $'\n%{http_code}' 2>/dev/null)" || resp=""
  [[ -z "$resp" ]] && { echo error; return 0; }
  code="$(tail -n1 <<<"$resp")"
  body="$(sed '$d' <<<"$resp")"
  if [[ "$code" == "401" ]] || grep -q '"ok"[[:space:]]*:[[:space:]]*false' <<<"$body"; then
    echo invalid
    return 0
  fi
  if [[ "$code" == "200" ]] && grep -q '"ok"[[:space:]]*:[[:space:]]*true' <<<"$body"; then
    echo ok
    return 0
  fi
  echo error # network/timeout/5xx/unexpected -> NOT a definitive "invalid"
}

# Best-effort deduped alert. The token goes in the URL via a stdin config (off
# argv); only the non-secret chat_id + text are argv. Prefers a separate alert
# bot token so a revoked MAIN token can still be reported.
send_invalid_alert() {
  local now="$1" prev=0 atoken
  [[ -f "$ALERT_STAMP" ]] && prev="$(tr -dc '0-9' <"$ALERT_STAMP" 2>/dev/null)"
  prev="${prev:-0}"
  if ((now - prev < ALERT_COOLDOWN)); then
    log "invalid-token alert suppressed (cooldown ${ALERT_COOLDOWN}s)"
    return 0
  fi
  echo "$now" >"$ALERT_STAMP" 2>/dev/null || true
  atoken="${MARVEEN_ALERT_BOT_TOKEN:-${MAIN_TOKEN:-}}"
  local msg="Marveen: a Telegram bot-TOKEN ÉRVÉNYTELEN / VISSZAVONT (getMe 401).
A bot elnémul, amíg új tokent nem állítasz be (BotFather -> /token), majd a channels .env-be.
(Ez NEM app-crash és NEM host-restart; maga a token rossz.)"
  if [[ -n "$CHAT_ID" && -n "$atoken" ]]; then
    printf 'url = "%s/bot%s/sendMessage"\n' "$API_BASE" "$atoken" \
      | curl -sS --max-time 15 -K - \
        --data-urlencode "chat_id=${CHAT_ID}" \
        --data-urlencode "text=${msg}" >/dev/null 2>&1 \
      && log "invalid-token alert sent (best-effort)" \
      || log "invalid-token alert send failed (token likely dead) -- status file is the durable signal"
  else
    log "no alert path (chat-id/alert-token) -- status file is the durable signal"
  fi
}

# --- read the token (NEVER logged) ---
MAIN_TOKEN=""
if [[ -f "$ENV_FILE" ]]; then
  MAIN_TOKEN="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r\n')"
fi
if [[ -z "$MAIN_TOKEN" ]]; then
  log "no TELEGRAM_BOT_TOKEN configured (TELEGRAM_ENV=$ENV_FILE); nothing to probe"
  exit 0
fi

mkdir -p "$STATE_DIR" 2>/dev/null || true
result="$(probe_telegram_token "$MAIN_TOKEN")"
ts="$(date +%s)"

case "$result" in
ok)
  echo "OK $ts" >"$STATUS_FILE" 2>/dev/null || true
  rm -f "$ALERT_STAMP" 2>/dev/null || true # clear so a future revoke re-alerts
  log "telegram bot-token healthy (getMe ok)"
  ;;
invalid)
  echo "INVALID $ts" >"$STATUS_FILE" 2>/dev/null || true
  log "WARNING: telegram bot-token INVALID/REVOKED (getMe 401 / ok:false)"
  send_invalid_alert "$ts"
  ;;
*)
  echo "ERROR $ts" >"$STATUS_FILE" 2>/dev/null || true
  log "getMe probe inconclusive (network/timeout) -- no alert (transient); retry next tick"
  ;;
esac

exit 0
