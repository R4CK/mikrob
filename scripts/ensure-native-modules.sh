#!/usr/bin/env bash
# Startup guard: ensure the better-sqlite3 native binding loads for the current
# Node ABI before the dashboard/channels services start. If it is missing or
# ABI-mismatched (the recurring "Could not locate the bindings file" crash-loop,
# root-caused 2026-07-03), rebuild it in place. Idempotent, safe to run on every
# start. Wired in as ExecStartPre= on the *-dashboard and *-channels units.
#
# STRAY-PNPM ALERT (card d0126d79, 2026-08-24). This repo is npm-only (card
# 0b0e6e24 / scripts/assert-npm-package-manager.mjs): a stray `pnpm install`
# replaces node_modules with a pnpm layout and, by default, skips the native
# build script for better-sqlite3. 0b0e6e24's crash-loop made that LOUD. This
# time it wasn't: the rebuild below ran anyway and quietly fixed the one thing
# it checks, so there was ZERO visible symptom -- MikroB only noticed via a
# stray `git status` in the shared main clone. A silent fix for a foreign
# package manager taking over a live service's dependency tree is itself a
# problem worth surfacing, so this now checks for the tell-tale artifacts
# (pnpm-lock.yaml, node_modules/.pnpm) and alerts the owner directly over the
# Bot API (mirrors disk-space-guard.sh's alert_owner: direct API, delivery-
# confirmed cooldown stamp) instead of just rebuilding past it. It does NOT
# auto-delete the stray files -- that stays a human/MikroB decision.
#
# Test hooks (env, used only by scripts/__tests__/ensure-native-modules.test.sh):
#   NATIVE_GUARD_PROJECT_DIR    - project root to check instead of the real one
#   NATIVE_GUARD_STATE_DIR      - cooldown-stamp dir (default <project>/store)
#   NATIVE_GUARD_TG_ENV         - telegram .env path (default ~/.claude/channels/telegram/.env)
#   NATIVE_GUARD_ALERT_DRYRUN   - if 1, print "ALERT_DRYRUN: <msg>" not curl
#   NATIVE_GUARD_SKIP_SQLITE_CHECK - if 1, exit after the pnpm check (isolates
#                                    the new alert logic from the real npm/node
#                                    rebuild path, which needs a real project)
set -u

# Derive the project root from this script's location (scripts/ -> repo root),
# so the guard is portable across install dirs instead of hardcoding a path.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${NATIVE_GUARD_PROJECT_DIR:-$(dirname "$SCRIPT_DIR")}"
STATE_DIR="${NATIVE_GUARD_STATE_DIR:-$PROJECT_DIR/store}"
ALERT_STAMP="$STATE_DIR/.native-guard-pnpm-alerted"
ALERT_COOLDOWN=3600      # at most one stray-pnpm alert per hour
TG_ENV="${NATIVE_GUARD_TG_ENV:-$HOME/.claude/channels/telegram/.env}"
LOG_TAG="ensure-native-modules"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$LOG_TAG] $*" || true; }

# Tell-tale of a foreign pnpm install in an npm-only repo (card 0b0e6e24).
has_stray_pnpm_artifacts() {
  [ -f "$PROJECT_DIR/pnpm-lock.yaml" ] && return 0
  [ -d "$PROJECT_DIR/node_modules/.pnpm" ] && return 0
  return 1
}

# DIRECT-BOT-API alert (mirrors disk-space-guard.sh's alert_owner).
alert_owner() {
  local msg="$1" token chat
  if [ "${NATIVE_GUARD_ALERT_DRYRUN:-}" = "1" ]; then
    echo "ALERT_DRYRUN: $msg"; return 0
  fi
  token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$TG_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  chat="$(grep -E '^ALLOWED_CHAT_ID=' "$PROJECT_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  [ -z "$chat" ] && chat="$(grep -E '^TELEGRAM_CHAT_ID=' "$TG_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  if [ -z "$token" ] || [ -z "$chat" ]; then
    log "ALERT (no bot token or owner chat id configured, could not Telegram): $msg"; return 1
  fi
  # Honest send (NOTIFYVAKSWEEP826 pattern): curl exit 0 alone is not delivery.
  . "$SCRIPT_DIR/lib/send-telegram.sh"
  local send_err
  if send_err="$(send_telegram_message "$token" "$chat" "$msg" 2>&1)"; then
    log "owner alerted via direct Bot API (delivery confirmed)"
    return 0
  fi
  log "ALERT sendMessage FAILED: ${send_err}"
  return 1
}

check_stray_pnpm() {
  has_stray_pnpm_artifacts || return 0
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  local now last
  now="$(date +%s)"
  last=0; [ -f "$ALERT_STAMP" ] && last="$(cat "$ALERT_STAMP" 2>/dev/null || echo 0)"
  case "$last" in (''|*[!0-9]*) last=0;; esac
  if [ $(( now - last )) -lt "$ALERT_COOLDOWN" ]; then
    log "stray pnpm artifacts detected in $PROJECT_DIR, but within alert cooldown -- skip"
    return 0
  fi
  log "stray pnpm artifacts detected in $PROJECT_DIR (this is an npm-only repo, card 0b0e6e24) -- alerting"
  if alert_owner "🔴 ensure-native-modules: stray pnpm artifacts found in ${PROJECT_DIR} (pnpm-lock.yaml and/or node_modules/.pnpm). This repo is npm-only -- a foreign pnpm install can silently replace node_modules and skip native builds for services that keep running anyway. Fix: remove the stray file(s), run npm install, verify the affected service(s)."; then
    echo "$now" > "$ALERT_STAMP" 2>/dev/null || true
  else
    log "alert not delivered -- cooldown stamp NOT written, will retry next tick"
  fi
}

cd "$PROJECT_DIR" || exit 0   # never block startup on a cd failure

check_stray_pnpm

if [ "${NATIVE_GUARD_SKIP_SQLITE_CHECK:-}" = "1" ]; then
  exit 0
fi

# Health check must INSTANTIATE a Database -- better-sqlite3 loads its native
# binding lazily on `new Database()`, not on require(), so a bare require passes
# even when the .node file is missing (learned the hard way, 2026-07-03).
CHECK="const D=require('better-sqlite3'); new D(':memory:').close();"
if node -e "$CHECK" >/dev/null 2>&1; then
  exit 0
fi

echo "ensure-native-modules: better-sqlite3 binding not loadable, rebuilding for Node $(node -v)..." >&2
npm rebuild better-sqlite3 >&2 2>&1

# Verify the rebuild worked; log but do not hard-fail (systemd would just retry).
if node -e "$CHECK" >/dev/null 2>&1; then
  echo "ensure-native-modules: rebuild OK." >&2
else
  echo "ensure-native-modules: rebuild FAILED, dashboard will likely crash-loop." >&2
fi
exit 0
