#!/usr/bin/env bash
# context-compact-monitor.sh -- keep the big agents' context off the ceiling (card 9f74a0da).
#
# WHY, with the measurement behind it (card bb7276e7 PART3 + this card):
#   * The fleet's prompt-cache hit rate is 98.4%. Cache-busting is NOT the quota problem.
#   * The cost is the VOLUME of context re-read: 49.3B cache-read tokens. backend/fullstack/cybered
#     average 450-480k per call and run to the ~1M ceiling; qa sits at 119k doing comparable work.
#   * Two tempting fixes were measured and REJECTED before this one:
#       - "sessions are too long" -> false: qa runs 4x more calls per session at 1/4 the context.
#       - "trim big tool outputs"  -> false: median tool result is 269 chars, and everything over
#         20k chars is 4% of volume. There are no whales to harpoon.
#     What remains is periodic /compact: it does not shave individual results, it resets the
#     CARRIED context -- which is the accumulation the measurement actually found.
#
# WHAT IT DOES: reads each agent's most recent context size from the token_usage table (already
# populated from the Claude Code transcripts by src/web/token-usage.ts), and sends `/compact` to the
# tmux session of any TARGET agent above the threshold.
#
# ANTI-BURN. A /compact is not free -- it costs a summarisation pass -- so spamming it would trade
# one waste for another. Guards, in order:
#   1. only TARGET_AGENTS (the ceiling-runners), never the whole fleet;
#   2. only above THRESHOLD_K;
#   3. a per-agent COOLDOWN, so a still-large context right after a compact does not re-trigger;
#   4. --dry-run, which is what a scheduled task should use first.
# NOTE: this deliberately does NOT go through store/redispatch-guard.sh -- that guard is keyed by
# cardId and exists to stop an agent being made to REDO work. A /compact is agent-keyed and adds no
# work. The cooldown below is the equivalent control for this shape. Flagged for review.
#
# Usage:
#   context-compact-monitor.sh --dry-run     # report what it WOULD do (safe, no side effects)
#   context-compact-monitor.sh               # act
#   context-compact-monitor.sh --selftest    # verify the decision logic, no DB/tmux needed
#
# Exit: 0 ok | 2 bad usage | 3 environment problem
set -uo pipefail

ROOT="/home/neon/marveen"
DB="$ROOT/store/claudeclaw.db"
STATE="$ROOT/store/context-compact-state.json"
LOG="$ROOT/store/context-compact-monitor.log"

# Ceiling-runners only (measured 2026-08-06). qa/fron-teddy are already at target and must not be
# touched -- compacting an agent that is not the problem is pure cost.
#
# mikrob is EXCLUDED by default despite carrying the largest context (632k measured). It is the
# orchestrator: it dispatches, gates and answers Peti, and a mid-flight compact there disturbs the
# whole fleet rather than one worker. Opt it in deliberately via COMPACT_TARGET_AGENTS if wanted.
TARGET_AGENTS="${COMPACT_TARGET_AGENTS:-backend backend2 fullstack cybered cybersec}"
THRESHOLD_K="${COMPACT_THRESHOLD_K:-350}"
COOLDOWN_MIN="${COMPACT_COOLDOWN_MIN:-45}"
# Only trust a reading this fresh; a stale row means the agent is parked, and compacting a parked
# session wakes it up for nothing.
MAX_AGE_MIN="${COMPACT_MAX_AGE_MIN:-20}"

DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  --selftest) ;;
  "") ;;
  -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
  *) echo "context-compact-monitor.sh: unknown argument '$1'" >&2; exit 2 ;;
esac

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# --- decision logic, isolated so the selftest can exercise it without a DB or tmux -------------
# should_compact <ctx_k> <threshold_k> <age_min> <max_age_min> <mins_since_last> <cooldown_min>
should_compact() {
  local ctx="$1" thr="$2" age="$3" maxage="$4" since="$5" cool="$6"
  [ "$ctx" -ge "$thr" ] || { echo "below-threshold"; return 1; }
  [ "$age" -le "$maxage" ] || { echo "stale-reading"; return 1; }
  [ "$since" -ge "$cool" ] || { echo "cooldown"; return 1; }
  echo "compact"; return 0
}

if [ "${1:-}" = "--selftest" ]; then
  fails=0
  t() { # t <expect> <args...>
    local want="$1"; shift
    local got; got="$(should_compact "$@")"
    if [ "$got" != "$want" ]; then echo "FAIL: want=$want got=$got args=$*"; fails=$((fails+1)); fi
  }
  t compact          400 350 5 20 60 45   # over threshold, fresh, cooled down
  t below-threshold  300 350 5 20 60 45   # under threshold
  t below-threshold  349 350 5 20 60 45   # boundary: strictly below stays put
  t compact          350 350 5 20 60 45   # boundary: at threshold acts
  t stale-reading    400 350 99 20 60 45  # agent parked -> do not wake it
  t cooldown         400 350 5 20 10 45   # compacted recently
  t compact          400 350 5 20 45 45   # boundary: cooldown exactly elapsed
  [ "$fails" -eq 0 ] && { echo "selftest OK (7 cases)"; exit 0; } || { echo "selftest FAILED: $fails"; exit 1; }
fi

[ -r "$DB" ] || { echo "context-compact-monitor.sh: cannot read $DB" >&2; exit 3; }
[ -f "$STATE" ] || echo '{}' > "$STATE"

# Refresh token_usage BEFORE deciding. The dashboard only auto-collects hourly (web.ts), so without
# this the monitor would read context sizes up to an hour old -- and an hour-old number is not a
# safe basis for compacting a live session (the agent may already have compacted, or grown far past
# it). Best-effort: if the refresh fails we still run, and the staleness check below is what stops
# us acting on an old reading. Token from a 0600 header file, never argv.
TOKEN_FILE="$ROOT/store/.dashboard-token"
if [ -r "$TOKEN_FILE" ]; then
  HDR_FILE="$(mktemp)"; trap 'rm -f "$HDR_FILE"' EXIT; chmod 600 "$HDR_FILE"
  printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" > "$HDR_FILE"
  curl -fsS -m 60 -X POST "http://127.0.0.1:${WEB_PORT:-3420}/api/token-usage/collect" \
    -H "@$HDR_FILE" >/dev/null 2>&1 || log "WARN: token-usage refresh failed; using stored rows"
fi

NOW=$(date +%s)
ACTED=0

for agent in $TARGET_AGENTS; do
  row=$(sqlite3 "$DB" "SELECT CAST(MAX(cache_read_tokens)/1000 AS INT) || ' ' || MAX(timestamp)
                       FROM token_usage WHERE agent='$agent' AND timestamp > $((NOW - 7200));" 2>/dev/null)
  ctx_k=$(echo "$row" | awk '{print $1}')
  ts=$(echo "$row" | awk '{print $2}')
  [ -n "$ctx_k" ] && [ "$ctx_k" != "" ] || continue
  case "$ctx_k" in (*[!0-9]*) continue ;; esac

  age_min=$(( (NOW - ts) / 60 ))
  last=$(python3 -c "
import json,sys
try: print(json.load(open('$STATE')).get('$agent', 0))
except Exception: print(0)" 2>/dev/null || echo 0)
  since_min=$(( (NOW - last) / 60 ))

  reason=$(should_compact "$ctx_k" "$THRESHOLD_K" "$age_min" "$MAX_AGE_MIN" "$since_min" "$COOLDOWN_MIN")
  if [ "$reason" != "compact" ]; then
    [ "$DRY" = "1" ] && echo "SKIP $agent ctx=${ctx_k}k age=${age_min}m since=${since_min}m -> $reason"
    continue
  fi

  if [ "$DRY" = "1" ]; then
    echo "WOULD COMPACT $agent ctx=${ctx_k}k age=${age_min}m since=${since_min}m"
    continue
  fi

  # Session names are NOT the agent id: role agents run as `agent-<name>` and the orchestrator as
  # `mikrob-channels`. Assuming sess=="$agent" made this a silent no-op -- it logged "no tmux
  # session" for every agent and never compacted anything. Resolve properly, and if no session
  # matches, say so rather than pretending we acted.
  sess=""
  for cand in "agent-$agent" "$agent" "$agent-channels"; do
    if tmux has-session -t "$cand" 2>/dev/null; then sess="$cand"; break; fi
  done
  if [ -z "$sess" ]; then
    log "SKIP $agent: no tmux session (tried agent-$agent, $agent, $agent-channels)"
    continue
  fi
  tmux send-keys -t "$sess" -l "/compact" && sleep 1 && tmux send-keys -t "$sess" Enter
  python3 -c "
import json
try: d = json.load(open('$STATE'))
except Exception: d = {}
d['$agent'] = $NOW
json.dump(d, open('$STATE','w'))"
  log "COMPACT $agent (session $sess) ctx=${ctx_k}k (threshold ${THRESHOLD_K}k)"
  ACTED=$((ACTED + 1))
done

[ "$DRY" = "1" ] || log "run complete, compacted=$ACTED"
exit 0
