#!/bin/bash
# Build-freshness guard for the host (systemd --user timer, every 5 minutes).
#
# Incident it fixes (card 77075367): f0389e81 (a gated security fix) landed on marveen develop, but
# marveen-land.sh deliberately does NOT rebuild dist/ or restart mikrob-channels/mikrob-dashboard --
# that stays a separate, confirmed gate (./update.sh + Peti), see marveen-land.sh's own header
# comment. Nothing else watched for the gap, so the landed fix sat inactive for ~1h until Cybersec's
# own live retest happened to catch it. This guard does not rebuild or restart anything either -- it
# only makes the staleness VISIBLE the same way store/marveen-land.sh's own "WARNING -- this land
# touches src/" line does at land time, as the backstop for when nobody is watching that output.
#
# Staleness test: the newest commit touching src/ on the live install's own git history vs the
# newest file mtime under dist/. dist/*.js mtimes reflect the last real `tsc` build; git commit
# timestamps (not file mtimes) drive the src/ side, so a checkout that changes file mtimes without
# a new commit (e.g. a fresh clone) does not falsely look stale.
#
# Test hooks (env, used only by scripts/__tests__/build-freshness-guard.test.sh):
#   BUILD_GUARD_REPO_DIR        - repo to check instead of INSTALL_DIR (a throwaway git repo in tests)
#   BUILD_GUARD_SRC_TS_OVERRIDE - force the "newest src/ commit" unix timestamp
#   BUILD_GUARD_DIST_TS_OVERRIDE - force the "newest dist/ file" unix timestamp
#   BUILD_GUARD_STATE_DIR       - cooldown-stamp dir (default <install>/store)
#   BUILD_GUARD_ALERT_DRYRUN    - if 1, print "ALERT_DRYRUN: <msg>" not curl

set -u

STALE_GRACE_SEC=300     # a build takes real time; do not alert on the first few minutes of drift
ALERT_COOLDOWN=3600     # at most one stale-build alert per hour while it stays stale

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="${BUILD_GUARD_REPO_DIR:-$INSTALL_DIR}"
STATE_DIR="${BUILD_GUARD_STATE_DIR:-$INSTALL_DIR/store}"
ALERT_STAMP="$STATE_DIR/.build-freshness-guard-alerted"
TG_ENV="$HOME/.claude/channels/telegram/.env"
LOG_TAG="build-freshness-guard"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$LOG_TAG] $*" || true; }

# Newest commit's unix timestamp among commits touching src/, on REPO_DIR's checked-out branch. On
# a repo with no src/-touching commit (or not a git repo at all), returns "" -- no-op, not stale.
latest_src_commit_ts() {
  if [ -n "${BUILD_GUARD_SRC_TS_OVERRIDE:-}" ]; then echo "$BUILD_GUARD_SRC_TS_OVERRIDE"; return; fi
  git -C "$REPO_DIR" log -1 --format=%ct -- src/ 2>/dev/null
}

# Newest mtime among dist/*.js, or "" if dist/ does not exist / is empty (nothing built yet).
newest_dist_mtime() {
  if [ -n "${BUILD_GUARD_DIST_TS_OVERRIDE:-}" ]; then echo "$BUILD_GUARD_DIST_TS_OVERRIDE"; return; fi
  find "$REPO_DIR/dist" -type f -name '*.js' -printf '%T@\n' 2>/dev/null | sort -rn | head -1 | cut -d. -f1
}

# DIRECT-BOT-API alert (mirrors scripts/disk-space-guard.sh / scripts/ollama-down-guard.sh
# alert_owner). Same reasoning: do not depend on the in-session MCP plugin being alive or fresh.
alert_owner() {
  local msg="$1" token chat
  if [ "${BUILD_GUARD_ALERT_DRYRUN:-}" = "1" ]; then
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
  local src_ts dist_ts now last drift_min
  mkdir -p "$STATE_DIR" 2>/dev/null || true

  src_ts="$(latest_src_commit_ts)"
  case "$src_ts" in (''|*[!0-9]*) log "no src/-touching commit found (or not a git repo) -- no-op"; return 0;; esac

  dist_ts="$(newest_dist_mtime)"
  case "$dist_ts" in
    (''|*[!0-9]*)
      # dist/ missing or empty while src/ has commits: never built at all. Still respect the grace
      # period + cooldown below rather than alerting on tick one of a fresh checkout.
      dist_ts=0
      ;;
  esac

  if [ "$dist_ts" -ge "$src_ts" ]; then
    if [ -f "$ALERT_STAMP" ]; then
      log "dist/ is fresh again -- clearing alert cooldown stamp"
      rm -f "$ALERT_STAMP" 2>/dev/null || true
    fi
    return 0
  fi

  drift_min=$(( (src_ts - dist_ts) / 60 ))
  if [ $(( src_ts - dist_ts )) -lt "$STALE_GRACE_SEC" ]; then
    log "dist/ ${drift_min}m behind src/ -- within the ${STALE_GRACE_SEC}s build-time grace period, no-op"
    return 0
  fi

  log "dist/ is STALE: newest src/ commit is ${drift_min}m newer than the newest built file"
  now="$(date +%s)"
  last=0; [ -f "$ALERT_STAMP" ] && last="$(cat "$ALERT_STAMP" 2>/dev/null || echo 0)"
  case "$last" in (''|*[!0-9]*) last=0;; esac
  if [ $(( now - last )) -ge "$ALERT_COOLDOWN" ]; then
    # Cooldown stamp ONLY on confirmed delivery (same rule as the other guards): a stamp written
    # after a failed send would suppress the retry for an hour while nobody was told.
    if alert_owner "🟡 MikroB dist/ elavult: egy src/-t erinto commit kb ${drift_min} perce landolt, de a futo mikrob-channels/mikrob-dashboard meg a REGI buildet szolgalja ki. Futtasd: ./update.sh"; then
      echo "$now" > "$ALERT_STAMP" 2>/dev/null || true
    else
      log "alert not delivered -- cooldown stamp NOT written, will retry next tick"
    fi
  else
    log "dist/ stale but within alert cooldown ($(( now - last ))s) -- skip alert"
  fi
}

main "$@"
exit 0
