#!/bin/bash
# send-telegram.sh -- the fleet's ONE honest Telegram send primitive.
#
# NOTIFYVAKSWEEP826: 13 scripts sent to the Bot API; only notify.sh (after
# NOTIFYVAK826/#1081) and telegram_fallback_send.py checked the outcome. Every
# bash sender either swallowed the curl exit, ignored the response body, or
# both -- an HTTP 200 with {"ok":false} (bad chat_id, blocked bot, mangled
# .env) was invisible everywhere, and several loggers printed unconditional
# "sent" on failure. This library IS the proven notify.sh contract, extracted
# so there is exactly one truth:
#
#   send_telegram_message TOKEN CHAT_ID TEXT [extra curl args...]
#
#   returns 0  ONLY when curl exited 0 AND the Bot API answered "ok":true
#   returns 1  on transport failure, API rejection, or misuse (empty args),
#              with the reason on stderr and the bot token redacted (some curl
#              errors quote the request URL).
#
# The caller decides what a failure means for its own exit code (an OnFailure
# unit must still exit 0; notify.sh exits 1) -- but it can no longer NOT KNOW.
# State stamps (dedupe hashes, cooldowns, baselines) must be written only
# after this returns 0: a failed alert buried by its own suppression stamp is
# lost forever (the limit-monitor failure mode).
#
# Bash 3.2 compatible (macOS system bash). Source it, do not execute it:
#   . "$(dirname "$0")/lib/send-telegram.sh"

# telegram_api_call TOKEN METHOD [curl args...] -- the same contract for ANY
# Bot API method (setMyCommands, sendPhoto, ...): success only on curl exit 0
# AND "ok":true, loud stderr otherwise, token redacted.
telegram_api_call() {
  if [ "$#" -lt 2 ]; then
    echo "telegram_api_call: usage: telegram_api_call TOKEN METHOD [curl args...]" >&2
    return 1
  fi
  local token="$1" method="$2"
  shift 2
  if [ -z "$token" ] || [ -z "$method" ]; then
    echo "telegram_api_call: empty token/method -- refusing (nothing would be delivered)" >&2
    return 1
  fi

  local response curl_exit base
  # SECURITY (card 8418b098): the token never touches argv/ps -- fed to curl via a -K config file
  # over stdin (only the URL line carries it), matching store/roll-forward-oneshot.sh's notify() and
  # scripts/dashboard-watchdog.sh's notify_peti(). DEVIATION FROM ACKNOWLEDGED_CONFLICTS (card
  # 4f15966e, backend, 2026-09-07): the archived rule for this file said "adopt upstream wholesale",
  # which correctly brought in telegram_api_call's method-agnostic shape but, taken literally, also
  # discarded this -K/stdin pattern in favour of upstream's bare argv URL (caught by
  # send-honesty-sweep.test.ts's "bot token NOT in curl argv" case). Restored.
  # TELEGRAM_API_BASE: test seam only (a local Bot API stub), the same variable
  # telegram_fallback_send.py honours; unset in production. Kept from upstream's
  # merge (Koteg 16) alongside the -K/stdin security fix -- morning-briefing-slack-delivery.test.sh
  # already relies on this being honoured here.
  base="${TELEGRAM_API_BASE:-https://api.telegram.org}"
  # Koteg 24 (card 57044a66): upstream's own re-landing of this same -K/stdin pattern adds an
  # injection guard this fork's version never had -- the URL is a QUOTED config value, and a
  # quote, backslash or newline in the token/method/base would break out of it. Refuse rather
  # than build a config line that could be misread (or inject a second directive) by curl's
  # -K parser; such a call could not deliver anything correctly anyway.
  case "$token$method$base" in
    *\"*|*\\*|*$'\n'*)
      echo "telegram_api_call(${method}): the token, method or API base contains a quote, backslash or newline -- refusing (nothing would be delivered)" >&2
      return 1
      ;;
  esac
  response=$(printf 'url = "%s/bot%s/%s"\n' "$base" "$token" "$method" \
    | curl -sS -m 15 -K - "$@" 2>&1)
  # curl is the last command of the pipe, so $? is its exit code, not printf's.
  curl_exit=$?
  # Never let the token reach a log/journal: redact before any echo.
  response="${response//${token}/<token>}"

  if [ "$curl_exit" -ne 0 ]; then
    echo "telegram_api_call(${method}): transport failure (curl exit ${curl_exit}): ${response}" >&2
    return 1
  fi
  case "$response" in
    *'"ok":true'*)
      return 0
      ;;
    *)
      echo "telegram_api_call(${method}): Bot API rejected the call: ${response}" >&2
      return 1
      ;;
  esac
}

send_telegram_message() {
  if [ "$#" -lt 3 ]; then
    echo "send_telegram_message: usage: send_telegram_message TOKEN CHAT_ID TEXT [curl args...]" >&2
    return 1
  fi
  local token="$1" chat_id="$2" text="$3"
  shift 3
  if [ -z "$token" ] || [ -z "$chat_id" ] || [ -z "$text" ]; then
    echo "send_telegram_message: empty token/chat_id/text -- refusing (nothing would be delivered)" >&2
    return 1
  fi
  telegram_api_call "$token" "sendMessage" \
    --data-urlencode "chat_id=${chat_id}" \
    --data-urlencode "text=${text}" \
    "$@"
}
