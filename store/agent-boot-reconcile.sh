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
# WhiteHat NO-GO (comment 17673) + WhiteHat2 delta NO-GO (comment 17871) + QA FAIL (17873) on a
# prior round (Gate-SHA 2e4c9bd1, then dbbd8a15) found this script OVERRIDES parking, not respects
# it. Fixed here:
#   F1 (HIGH, blocking): the 5-min backstop would restart agents the fleet deliberately parked --
#   during a weekly hard-stop, on a [BLOKKOLT-*]-titled card, or on a card outside the currently
#   active project-dispatch-priority project. Fixed: (a) weekly-hard-stop.json active=true ->
#   nothing started, log only; (b) a BLOKKOLT-titled card never counts as qualifying work; (c) when
#   project-dispatch-priority.json names a non-empty priority list, a card outside it never counts
#   as qualifying work either (same exclusivity the self-advance rule already enforces for new pickup).
#   F2 (MEDIUM, blocking): the assignee field was free text, passed straight into the start/message
#   URL and body. Fixed: assignee must both match ^[a-z][a-z0-9-]{0,31}$ AND be an exact, known name
#   from the SAME /api/agents fetch this run already has -- anything else is skipped, not guessed.
#   Also: a non-array/error response from either fetch now fails closed (not just an empty string).
#   F3 (MEDIUM, blocking-ish): start/message results were discarded (>/dev/null); a failed start
#   could still be reported as "started". Fixed: both calls' HTTP status is checked; failures are
#   listed separately, and a stopped message recipient (targetRunning:false) is flagged. A Telegram
#   summary (via the same from:mikrob to:mikrob bridge quota-shutdown-guard.sh uses) is sent whenever
#   this run actually started or failed to start someone.
#   LOW: the waiting+REVIEW detector only matched REVIEW at the very start of the comment, missing
#   the CLAUDE.md-4b Gate-SHA-first convention -- now a multiline, per-line match. The two scratch
#   files (cards/agents snapshot) are now under the same EXIT trap as the auth header file, so a
#   SIGTERM mid-run does not leave them in /tmp.
#
# Usage: agent-boot-reconcile.sh   (prints one summary line; exits 0 unless the kanban/agents
# fetch itself fails, exit 1 fail-closed so a wiring/cron failure is visible, not silent).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DASH="${DASH:-http://localhost:3420}"
TOKEN_FILE="$ROOT/store/.dashboard-token"

# Test seams: the selftest serves fixed JSON / fixed flag files and records start/message/telegram
# calls instead of touching the live dashboard, same intent as heartbeat-scriptfirst.sh's
# HEARTBEAT_SCRIPTFIRST_FIXTURE_DIR.
FIXTURE_DIR="${AGENT_BOOT_RECONCILE_FIXTURE_DIR:-}"
START_RECORDER="${AGENT_BOOT_RECONCILE_START_BIN:-}"
MESSAGE_RECORDER="${AGENT_BOOT_RECONCILE_MESSAGE_BIN:-}"
TELEGRAM_RECORDER="${AGENT_BOOT_RECONCILE_TELEGRAM_BIN:-}"
HARDSTOP_FILE="${AGENT_BOOT_RECONCILE_HARDSTOP_FILE:-$ROOT/store/weekly-hard-stop.json}"
PRIORITY_CONFIG="${AGENT_BOOT_RECONCILE_PRIORITY_CONFIG:-$ROOT/store/project-dispatch-priority.json}"

hf="$(mktemp)"; chmod 600 "$hf"
cards_f="$(mktemp)"; agents_f="$(mktemp)"
trap 'rm -f "$hf" "$cards_f" "$agents_f"' EXIT
printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE" 2>/dev/null)" > "$hf"

# --- F1a: weekly hard-stop short-circuit. Parking rule (7.) takes precedence over this script. ---
if [ -f "$HARDSTOP_FILE" ]; then
  HS_ACTIVE="$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    d = {}
print("1" if d.get("active") else "0")
' "$HARDSTOP_FILE" 2>/dev/null)"
  if [ "$HS_ACTIVE" = "1" ]; then
    echo "agent-boot-reconcile: weekly-hard-stop active -- not starting anyone (parking rule 7 takes precedence)"
    exit 0
  fi
fi

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

# $1 = json string -> prints "1" if it parses as a JSON array, else "0" (never raises). F2: a
# non-array response (missing token, error object, empty body) now fails closed, not just empty.
_is_json_array() {
  printf '%s' "$1" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("0"); sys.exit(0)
print("1" if isinstance(d, list) else "0")
' 2>/dev/null
}

# $1 = agent name; echoes the resulting HTTP status code (or whatever the recorder prints for tests).
_start_agent() {
  if [ -n "$START_RECORDER" ]; then
    bash "$START_RECORDER" "$1"
    return
  fi
  curl -s -o /dev/null -w '%{http_code}' --max-time 15 -H @"$hf" -X POST "${DASH}/api/agents/$1/start" 2>/dev/null
}

# $1 = agent name, $2 = message text; echoes "<http_code>|<targetRunning 0|1>" (1 = recipient was
# NOT running when the message landed, i.e. the resume text itself may be lost -- F3).
_send_resume() {
  if [ -n "$MESSAGE_RECORDER" ]; then
    bash "$MESSAGE_RECORDER" "$1" "$2"
    return
  fi
  # "from" is mikrob, not fullstack: this script runs as a boot-time guard-timer (same convention
  # as offload-dispatch.sh's NUDGE_FROM=mikrob), not as the fullstack agent -- which may itself be
  # one of the agents this script is starting, i.e. not yet running when this fires.
  payload="$(AGENT="$1" TEXT="$2" python3 -c 'import json,os; print(json.dumps({"from":"mikrob","to":os.environ["AGENT"],"content":os.environ["TEXT"]}))')"
  resp_body="$(mktemp)"
  code="$(curl -s -o "$resp_body" -w '%{http_code}' --max-time 15 -H @"$hf" -X POST "${DASH}/api/messages" -H 'Content-Type: application/json' --data-binary "$payload" 2>/dev/null)"
  recipient_stopped="$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    d = {}
print("1" if d.get("targetRunning") is False else "0")
' "$resp_body" 2>/dev/null)"
  rm -f "$resp_body"
  echo "${code}|${recipient_stopped}"
}

# $1 = summary text. Boot-reconcile has no Telegram channel of its own (only mikrob-channels does),
# so it reaches Telegram the same way quota-shutdown-guard.sh's send_telegram() does: an inter-agent
# message mikrob sends to itself, which its own channels session relays.
_send_telegram_summary() {
  if [ -n "$TELEGRAM_RECORDER" ]; then
    bash "$TELEGRAM_RECORDER" "$1"
    return
  fi
  payload="$(TEXT="$1" python3 -c 'import json,os; print(json.dumps({"from":"mikrob","to":"mikrob","content":os.environ["TEXT"]}))')"
  curl -s --max-time 15 -H @"$hf" -X POST "${DASH}/api/messages" -H 'Content-Type: application/json' --data-binary "$payload" >/dev/null 2>&1
}

KANBAN_JSON="$(_get /api/kanban)"
AGENTS_JSON="$(_get /api/agents)"
if [ "$(_is_json_array "$KANBAN_JSON")" != "1" ] || [ "$(_is_json_array "$AGENTS_JSON")" != "1" ]; then
  echo "agent-boot-reconcile: FAILED to fetch kanban/agents (not a JSON array) -- nothing done"
  exit 1
fi

printf '%s' "$KANBAN_JSON" > "$cards_f"
printf '%s' "$AGENTS_JSON" > "$agents_f"

# F2: the allowlist of agent names this run may ever start/message -- EXACTLY the names this same
# /api/agents fetch returned, nothing guessed and nothing from the card's own assignee text alone.
VALID_AGENTS_LIST="$(python3 -c '
import json
agents = json.load(open("'"$agents_f"'"))
names = sorted(set((a.get("name") or a.get("agent_id") or "") for a in agents))
print(",".join(n for n in names if n))
' 2>/dev/null)"

# F1c: project-dispatch-priority.json exclusivity (same file + semantics the self-advance pickup
# rule already uses) -- while a priority project list is set, a card outside it is not "work" for
# this script either.
PRIORITY_PROJECTS="$(python3 -c "
import json
try:
    d = json.load(open('$PRIORITY_CONFIG'))
    p = d.get('priority') or []
    print(','.join(x for x in p if isinstance(x, str)))
except Exception:
    print('')
" 2>/dev/null)"

# Selector logic (acceptance criteria: in_progress / waiting+REVIEW / empty case), now filtering
# out BLOKKOLT-*, outside-priority-project and non-allowlisted/malshaped assignees (F1b, F1c, F2)
# BEFORE a card is ever counted as work. Prints "<agent>|<in_progress ids>|<waiting ids>" per agent.
WORK="$(CARDS_FILE="$cards_f" VALID_AGENTS="$VALID_AGENTS_LIST" PRIORITY_PROJECTS="$PRIORITY_PROJECTS" python3 -c '
import json, os, re

VALID = set(x for x in os.environ.get("VALID_AGENTS", "").split(",") if x)
PRIORITY = [p for p in os.environ.get("PRIORITY_PROJECTS", "").split(",") if p]
NAME_RX = re.compile(r"^[a-z][a-z0-9-]{0,31}$")

try:
    cards = json.load(open(os.environ["CARDS_FILE"]))
except Exception:
    raise SystemExit(0)

by_agent = {}
for c in cards:
    assignee = c.get("assignee")
    if not assignee or assignee == "mikrob":
        continue
    if not NAME_RX.match(assignee) or assignee not in VALID:
        continue
    title = c.get("title") or ""
    if "BLOKKOLT" in title:
        continue
    if PRIORITY and c.get("project") not in PRIORITY:
        continue
    status = c.get("status")
    if status in ("in_progress", "waiting"):
        by_agent.setdefault(assignee, []).append((c["id"], status))

for agent, entries in by_agent.items():
    ids = [cid for cid, status in entries if status == "in_progress"]
    waiting_ids = [cid for cid, status in entries if status == "waiting"]
    print(agent + "|" + ",".join(ids) + "|" + ",".join(waiting_ids))
' 2>/dev/null)"

STARTED=""
FAILED=""
STOPPED_RECIPIENTS=""
NOTHING_TO_DO=1
while IFS='|' read -r agent in_progress_ids waiting_ids; do
  [ -z "$agent" ] && continue
  # A waiting card only counts as real upcoming work if it carries a REVIEW comment (the card's
  # builder may still be needed for a gate FAIL / re-dispatch) -- matches root CLAUDE.md rule 7's
  # own "waiting+REVIEW kártya amit egy gate épp felvesz" parking exception. Multiline match (LOW
  # fix): a Gate-SHA-first REVIEW comment (CLAUDE.md 4b/4c) does not start with "REVIEW".
  qualifying_waiting=""
  for cid in ${waiting_ids//,/ }; do
    comments_json="$(_get "/api/kanban/$cid/comments")"
    has_review="$(printf '%s' "$comments_json" | python3 -c '
import json, sys, re
try: comments = json.load(sys.stdin)
except Exception: sys.exit(0)
comments = comments if isinstance(comments, list) else (comments or {}).get("comments") or []
print("1" if any(re.search(r"(?m)^\s*REVIEW", (c.get("content") or ""), re.I) for c in comments) else "0")
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

  start_code="$(_start_agent "$agent")"
  case "$start_code" in
    2??)
      resume_result="$(_send_resume "$agent" "[BOOT-RECONCILE] A gep ujraindult, visszaallitottalak. Folytasd a kartyaidat: $all_ids -- ELSO LEPES minden kartyan a friss statusz ujraolvasasa.")"
      resume_code="${resume_result%%|*}"
      resume_stopped="${resume_result##*|}"
      case "$resume_code" in
        2??) : ;;
        *) FAILED="$FAILED $agent(message=$resume_code)" ;;
      esac
      [ "$resume_stopped" = "1" ] && STOPPED_RECIPIENTS="$STOPPED_RECIPIENTS $agent"
      STARTED="$STARTED $agent($all_ids)"
      ;;
    *)
      FAILED="$FAILED $agent(start=$start_code)"
      ;;
  esac
done <<<"$WORK"

if [ -n "$STARTED" ] || [ -n "$FAILED" ]; then
  SUMMARY="Flotta: boot-reconcile $(date '+%H:%M')-kor -- elinditva:${STARTED:- (semmi)}."
  [ -n "$FAILED" ] && SUMMARY="$SUMMARY HIBAK:$FAILED"
  [ -n "$STOPPED_RECIPIENTS" ] && SUMMARY="$SUMMARY A resume-uzenet celzottja meg nem futott, amikor a kuldes megtortent (ujra kell probalni):$STOPPED_RECIPIENTS"
  _send_telegram_summary "$SUMMARY"
fi

if [ -n "$STARTED" ]; then
  echo "agent-boot-reconcile: started:$STARTED${FAILED:+ FAILED:$FAILED}"
elif [ -n "$FAILED" ]; then
  echo "agent-boot-reconcile: FAILED:$FAILED"
else
  if [ "$NOTHING_TO_DO" = "1" ]; then
    echo "agent-boot-reconcile: no agent had qualifying work -- nothing to do"
  else
    echo "agent-boot-reconcile: all agents with work already running -- nothing to do"
  fi
fi
exit 0
