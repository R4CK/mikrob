#!/bin/bash
# Claude usage-limit monitor (token-free, systemd --user timer).
#
# WHY bash and not a Claude scheduled-task: a Claude agent invocation itself
# consumes the very quota we're guarding. This runs as a plain shell script,
# greps for limit signals, and alerts the owner via the Telegram Bot API.
# Zero Claude tokens.
#
# Signals: rate-limit / usage-limit / 429 / "resets at" in the channels+dashboard
# logs AND in the live tmux panes of the WHOLE fleet (where Claude Code prints
# the limit banner). Dedupes via a state hash so the same event isn't re-alerted.
#
# Two things measured on 2026-08-18 shaped this:
#   - The plan quota is shared by every agent on the subscription, but the
#     banner is printed in whichever pane made the request that hit it. Watching
#     only the main channels pane means a sub-agent can hit the wall silently.
#   - The wordings closest to what the owner actually asks about ("5-hour limit
#     reached", "Approaching Opus weekly limit", "Session limit reached") did
#     NOT match the old pattern. A missed limit is silent; that is the failure
#     that matters here, so the pattern errs wide and the pane match is confined
#     to the bottom region instead.

set -u
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$INSTALL_DIR/store"
STATE="$STORE/.limit-monitor-state"
LOG="$STORE/limit-monitor.log"

log(){ echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# Install-specific values come from .env, never hardcoded: a renamed install
# (BOT_NAME/MAIN_AGENT_ID) has a differently named tmux session, and every
# install has its own owner chat. Resolved the same way as
# channel-keepalive-probe.sh so a rename moves both together.
env_val() { grep -E "^$1=" "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' '; }

MAIN_AGENT_ID="$(env_val MAIN_AGENT_ID)"
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
MAIN_AGENT_ID="${MAIN_AGENT_ID//[^a-zA-Z0-9_-]/}"
SESSION="${MAIN_AGENT_ID}-channels"

BOT_NAME="$(env_val BOT_NAME)"
BOT_NAME="${BOT_NAME:-$MAIN_AGENT_ID}"

CHAT_ID="$(env_val ALLOWED_CHAT_ID)"
if [ -z "$CHAT_ID" ]; then
  # No owner chat configured: there is nobody to alert, and guessing one would
  # send a quota warning to a stranger. Stay silent rather than misdeliver.
  log "no ALLOWED_CHAT_ID in .env, monitor cannot alert -- exiting"
  exit 0
fi

# Canonical CORE phrase source, shared with src/model-fallback.ts and 5 other scripts (card
# 115c21e7), PLUS this monitor's own wider net of extra alert-only signals -- rate_limit_error/429/
# quota-exceeded/out-of-credits genuinely must NOT reach the core (those are transient-blip signals
# that must never trigger a MODEL FALLBACK or a fleet dispatch HOLD, only this human-facing heads-up
# alert), and "reached your (usage|plan|weekly) limit" / "your limit will reset" are wider variants
# of the core phrasing this monitor keeps on purpose for earlier/broader warning coverage.
# The mid-phrase word-wildcard ("approaching X weekly/usage limit", e.g. "Approaching Opus weekly
# limit") is the SAME upstream term session-limit-pattern.json's own comment deliberately excluded
# from the SHARED canonical pattern (an unbounded wildcard risks a false model-downgrade for the 5
# OTHER consumers of that file) -- but this monitor is alert-only, never a model-fallback trigger, so
# the wildcard is safe HERE and belongs in this script's own EXTRA set (card 4f15966e).
. "$STORE/session-limit-pattern.sh"
LIMIT_MONITOR_EXTRA_RX='reached your (usage|plan|weekly) limit|your limit will reset|approaching [a-z0-9]+ (weekly|usage) limit|rate_limit_error|429 too many requests|quota exceeded|out of (usage|credits)'
CANDIDATE_RX="${SESSION_LIMIT_RX}|${LIMIT_MONITOR_EXTRA_RX}"

# ---------------------------------------------------------------------------
# Owner alert, Bot API only. No Claude invocation anywhere in this path -- the
# whole point is that it still works when the quota is gone. GRAFTED from
# upstream (round 3, 2026-09-02): both alert paths in this file now go through
# this one honest-send contract (curl exit 0 AND "ok":true), never a bare curl
# exit. Callers MUST stamp their dedupe state only when this returns 0. The
# upstream measured-quota path and fleet-wide pane_text() scan that arrived in
# the same upstream diff are DELIBERATELY NOT grafted -- the fork already
# alerts from its own quota monitor (store/quota-check.sh + quota-bridge), so
# a second measured alerter would double-notify Peti; only the honest-send
# wrapper is adopted.
# ---------------------------------------------------------------------------
. "$INSTALL_DIR/scripts/lib/send-telegram.sh"

send_alert() {
  local msg="$1" tag="$2" token
  token="$(grep -oE '[0-9]+:[A-Za-z0-9_-]+' "$HOME/.claude/channels/telegram/.env" 2>/dev/null | head -1)"
  if [ -z "$token" ]; then
    log "ALERT wanted but no bot token found: $tag"
    return 1
  fi
  if send_telegram_message "$token" "$CHAT_ID" "$msg" \
       --data-urlencode "disable_web_page_preview=true" 2>>"$LOG"; then
    log "ALERT sent to $CHAT_ID: $tag"
    return 0
  fi
  log "ALERT send FAILED (nothing was delivered): $tag"
  return 1
}

# Collect candidate text: recent log lines + live tmux pane
CANDIDATE="$(
  { tail -n 200 "$STORE/channels.log" "$STORE/channels.error.log" "$STORE/dashboard.log" 2>/dev/null;
    tmux capture-pane -t "$SESSION" -p 2>/dev/null;
  } | grep -iE "$CANDIDATE_RX" \
    | grep -viE "rate.?limit.?error class|no rate|within limit|limit-monitor|LIMIT-FIGYELMEZT|email/nap|req/nap|/nap free|kérés/hó|/hó\b|approaching\.\*limit"
)"

if [ -z "$CANDIDATE" ]; then
  # healthy: no signal. Touch a heartbeat so we know the monitor ran.
  echo "ok $(date +%s)" > "$STORE/.limit-monitor-heartbeat"
  exit 0
fi

# Dedupe: hash the signal; only alert if new. The stamp is written ONLY after
# a confirmed send (below): stamping up front buried every failed alert under
# its own dedupe -- the send failed, the hash said "already alerted", and the
# warning was lost forever, precisely during quota/network degradation
# (NOTIFYVAKSWEEP826, the worst row of the sweep).
#
# The hash comes from the shared existence-checked helper (MD5SUMHIANY826):
# the old bare `md5sum` pipeline yielded an EMPTY hash on macOS (no md5sum),
# empty == empty compared "unchanged", and every alert was silently swallowed
# on the flagship host. If NO hashing tool exists at all, this path fails
# OPEN: a duplicate alert on every tick is recoverable, a swallowed limit
# warning is not.
. "$INSTALL_DIR/scripts/lib/content-hash.sh"
HASH="$(printf '%s' "$CANDIDATE" | dedupe_check "$STATE")"
case $? in
  0) : ;; # new signal -> alert below
  1)
    log "signal unchanged, already alerted ($HASH)"
    exit 0
    ;;
  *)
    HASH=""
    log "content_hash UNAVAILABLE -- dedupe disabled for this tick, alerting anyway (fail-open)"
    ;;
esac

# (2) Fallback path: text signals in the logs and the live panes.
SNIP="$(printf '%s' "$CANDIDATE" | head -3)"
MSG="⚠️ LIMIT-FIGYELMEZTETÉS ($BOT_NAME monitor)
A logokban/sessionben limit-jel jelent meg:

$SNIP

Lehet hogy közeledünk vagy elértük a Claude előfizetés keretét. Ha kell, ritkítom a heartbeatet vagy szünetet tartok. Nézd meg a sessiont ha tudod."
# Both alert paths now share ONE contract via send_alert(): honest send, and the
# dedupe stamp written ONLY after a confirmed delivery, so a failed alert retries
# on the next timer tick instead of vanishing behind its own suppression stamp.
if send_alert "$MSG" "${HASH:-nohash}"; then
  # No stamp on an empty hash (fail-open tick): an empty state file is the exact
  # shape the MD5SUMHIANY826 bug hid behind.
  [ -n "$HASH" ] && echo "$HASH" > "$STATE"
else
  log "ALERT send FAILED (will retry next tick, stamp NOT written): ${HASH:-nohash}"
fi
