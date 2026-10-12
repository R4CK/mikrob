#!/usr/bin/env bash
# agent-boot-reconcile.sh -- boot-time fleet restoration (card 43d98136).
#
# Incident: 2026-10-12 17:38 the WSL VM rebooted. mikrob-channels/mikrob-dashboard came back via
# their own systemd units, but the role-agent tmux sessions (backend, backend2, backend3, fullstack,
# the gate agents) did NOT auto-start -- nothing starts them except the dashboard's own
# POST /api/agents/<agent>/start, which nobody called after this boot. Result: ~1.5h with 8
# in_progress cards and no agent working them, and no heartbeat noticed because heartbeat itself
# runs inside MikroB's own channels session, which only came up at 19:15.
#
# This script is the fix: for every agent that provably HAS real work (an in_progress card, or a
# waiting card carrying a REVIEW comment that a gate hasn't verdicted yet -- i.e. the agent will be
# needed again soon), start it if not already running and send it a resume message naming its
# card id(s). Parking rule (7.) stays intact: an agent with NO qualifying work is never started.
# Idempotent -- safe to run repeatedly (an already-running agent is left alone, not re-messaged).
#
# Usage: agent-boot-reconcile.sh   (prints one summary line; exits 0 unless the kanban/agents
# fetch itself fails, exit 1 fail-closed so a wiring/cron failure is visible, not silent).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DASH="${DASH:-http://localhost:3420}"
TOKEN_FILE="$ROOT/store/.dashboard-token"

# Test seam: the selftest serves fixed JSON and records start/message calls instead of touching the
# live dashboard, same intent as heartbeat-scriptfirst.sh's HEARTBEAT_SCRIPTFIRST_FIXTURE_DIR.
FIXTURE_DIR="${AGENT_BOOT_RECONCILE_FIXTURE_DIR:-}"
START_RECORDER="${AGENT_BOOT_RECONCILE_START_BIN:-}"
MESSAGE_RECORDER="${AGENT_BOOT_RECONCILE_MESSAGE_BIN:-}"

hf="$(mktemp)"; chmod 600 "$hf"
trap 'rm -f "$hf"' EXIT
printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE" 2>/dev/null)" > "$hf"

_get() {
  if [ -n "$FIXTURE_DIR" ]; then
    case "$1" in
      /api/kanban) cat "$FIXTURE_DIR/kanban.json" 2>/dev/null ;;
      /api/agents) cat "$FIXTURE_DIR/agents.json" 2>/dev/null ;;
      /api/kanban/*/comments)
        local cid="${1#/api/kanban/}"; cid="${cid%/comments}"
        cat "$FIXTURE_DIR/comments-$cid.json" 2>/dev/null ;;
      *) echo "" ;;
    esac
    return
  fi
  curl -s --max-time 15 -H @"$hf" "${DASH}$1" 2>/dev/null
}

# $1 = agent name
_start_agent() {
  if [ -n "$START_RECORDER" ]; then
    bash "$START_RECORDER" "$1"
    return
  fi
  curl -s --max-time 15 -H @"$hf" -X POST "${DASH}/api/agents/$1/start" >/dev/null 2>&1
}

# $1 = agent name, $2 = message text
_send_resume() {
  if [ -n "$MESSAGE_RECORDER" ]; then
    bash "$MESSAGE_RECORDER" "$1" "$2"
    return
  fi
  # "from" is mikrob, not fullstack: this script runs as a boot-time guard-timer (same convention
  # as offload-dispatch.sh's NUDGE_FROM=mikrob), not as the fullstack agent -- which may itself be
  # one of the agents this script is starting, i.e. not yet running when this fires.
  payload="$(AGENT="$1" TEXT="$2" python3 -c 'import json,os; print(json.dumps({"from":"mikrob","to":os.environ["AGENT"],"content":os.environ["TEXT"]}))')"
  curl -s --max-time 15 -H @"$hf" -X POST "${DASH}/api/messages" -H 'Content-Type: application/json' --data-binary "$payload" >/dev/null 2>&1
}

KANBAN_JSON="$(_get /api/kanban)"
AGENTS_JSON="$(_get /api/agents)"
if [ -z "$KANBAN_JSON" ] || [ -z "$AGENTS_JSON" ]; then
  echo "agent-boot-reconcile: FAILED to fetch kanban/agents -- nothing done"
  exit 1
fi

cards_f="$(mktemp)"; agents_f="$(mktemp)"
printf '%s' "$KANBAN_JSON" > "$cards_f"
printf '%s' "$AGENTS_JSON" > "$agents_f"

# Selector logic (acceptance criteria: in_progress / waiting+REVIEW / empty case). Prints
# "<agent>|<in_progress ids>|<waiting ids>" per agent with any such card. Whether a waiting id
# actually qualifies (carries an unverdicted REVIEW) is resolved precisely per-card in bash below --
# a card list alone can't say that, it needs the card's comments.
WORK="$(python3 -c "
import json

try:
    cards = json.load(open('$cards_f'))
except Exception:
    raise SystemExit(0)

by_agent = {}
for c in cards:
    assignee = c.get('assignee')
    if not assignee or assignee == 'mikrob':
        continue
    status = c.get('status')
    if status in ('in_progress', 'waiting'):
        by_agent.setdefault(assignee, []).append((c['id'], status))

for agent, entries in by_agent.items():
    ids = [cid for cid, status in entries if status == 'in_progress']
    waiting_ids = [cid for cid, status in entries if status == 'waiting']
    print(agent + '|' + ','.join(ids) + '|' + ','.join(waiting_ids))
" 2>/dev/null)"

STARTED=""
NOTHING_TO_DO=1
while IFS='|' read -r agent in_progress_ids waiting_ids; do
  [ -z "$agent" ] && continue
  # A waiting card only counts as real upcoming work if it carries a REVIEW comment (the card's
  # builder may still be needed for a gate FAIL / re-dispatch) -- matches root CLAUDE.md rule 7's
  # own "waiting+REVIEW kártya amit egy gate épp felvesz" parking exception.
  qualifying_waiting=""
  for cid in ${waiting_ids//,/ }; do
    comments_json="$(_get "/api/kanban/$cid/comments")"
    has_review="$(printf '%s' "$comments_json" | python3 -c '
import json, sys, re
try: comments = json.load(sys.stdin)
except Exception: sys.exit(0)
comments = comments if isinstance(comments, list) else (comments or {}).get("comments") or []
print("1" if any(re.match(r"\s*REVIEW", (c.get("content") or ""), re.I) for c in comments) else "0")
' 2>/dev/null)"
    [ "$has_review" = "1" ] && qualifying_waiting="$qualifying_waiting $cid"
  done
  all_ids="$in_progress_ids"
  [ -n "$qualifying_waiting" ] && all_ids="$all_ids ${qualifying_waiting# }"
  all_ids="$(echo "$all_ids" | tr -s ' ' | sed 's/^ *//;s/ *$//' | tr ' ' ',' | sed 's/,,*/,/g;s/^,//;s/,$//')"
  [ -z "$all_ids" ] && continue

  is_running="$(AGENT="$agent" python3 -c '
import json, os
agents = json.load(open("'"$agents_f"'"))
a = os.environ["AGENT"]
print("1" if any((x.get("name") or x.get("agent_id")) == a and x.get("running") for x in agents) else "0")
')"
  NOTHING_TO_DO=0
  if [ "$is_running" = "1" ]; then
    continue
  fi
  _start_agent "$agent"
  _send_resume "$agent" "[BOOT-RECONCILE] A gep ujraindult, visszaallitottalak. Folytasd a kartyaidat: $all_ids -- ELSO LEPES minden kartyan a friss statusz ujraolvasasa."
  STARTED="$STARTED $agent($all_ids)"
done <<<"$WORK"

rm -f "$cards_f" "$agents_f"

if [ -n "$STARTED" ]; then
  echo "agent-boot-reconcile: started:$STARTED"
else
  if [ "$NOTHING_TO_DO" = "1" ]; then
    echo "agent-boot-reconcile: no agent had qualifying work -- nothing to do"
  else
    echo "agent-boot-reconcile: all agents with work already running -- nothing to do"
  fi
fi
exit 0
