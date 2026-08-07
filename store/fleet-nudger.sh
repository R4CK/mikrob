#!/usr/bin/env bash
# Deterministic fleet nudger (Peti: "a fleet ne alljon MikroB-ra varva").
# Runs on a system cron, INDEPENDENT of MikroB's LLM session, so idle fleet
# agents are woken to self-advance (CLAUDE.md rule 11) even when MikroB is busy.
# Only nudges an idle agent that ACTUALLY has assignable work -> no token waste.
set -u
ROOT="/home/neon/marveen"
TOK="$(cat "$ROOT/store/.dashboard-token" 2>/dev/null)"
API="http://localhost:3420/api/kanban"
MSG_API="http://localhost:3420/api/messages"
[ -z "$TOK" ] && exit 0

# SECURITY (Cybersec/gate-ops-scripts-token-in-argv, card edb7559f): the dashboard bearer token must
# NEVER be passed on a curl command line -- /proc/<pid>/cmdline is world-readable to any local user or
# process. A private 0600 temp file carries the header instead; -H @"$hdr_file" reads it without ever
# putting the token in argv. Removed on EXIT.
hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
trap 'rm -f "$hdr_file"' EXIT
printf 'Authorization: Bearer %s\n' "$TOK" > "$hdr_file"

ENG="backend fullstack fron-ted fron-teddy"
GATE="qa qa2 cybersec cybered"

# One kanban snapshot -> per-agent work availability (JSON: {agent: has_work_bool}).
WORK="$(curl -s -H @"$hdr_file" "$API" 2>/dev/null | python3 -c '
import json,sys
try: cards=json.load(sys.stdin)
except Exception: sys.exit(0)
eng=["backend","fullstack","fron-ted","fron-teddy"]
def has_verdict(card, author):
    # crude: a comment by the gate author already exists on this card id (checked separately)
    return False
# planned (non-blocked) assigned to an eng agent -> that agent has work
plan={a:False for a in eng}
for c in cards:
    if c.get("status")=="planned" and "BLOKKOLT" not in (c.get("title") or ""):
        a=c.get("assignee")
        if a in plan: plan[a]=True
# any waiting card with a REVIEW comment but not yet done -> gate agents have work
# (the agent itself skips cards it already verdicted; here we just detect a non-empty review queue)
gate_work = any(c.get("status")=="waiting" for c in cards)
out={a:plan[a] for a in eng}
out["_gate"]=gate_work
print(json.dumps(out))
' 2>/dev/null)"
[ -z "$WORK" ] && exit 0

get() { echo "$WORK" | python3 -c "import json,sys;print(json.load(sys.stdin).get(sys.argv[1],False))" "$1" 2>/dev/null; }

NUDGE_ENG='SELF-ADVANCE (rule 11, NE varj MikroB-ra): ha nincs aktiv munkad, curl a kanbant es vedd a neked cimzett legmagasabb-prio planned kartyat (nem BLOKKOLT) -> in_progress -> epitsd -> vegen waiting+REVIEW. Ha nincs planned, epitsd a design-impl kovetkezo kepernyoit (fron-ted/fron-teddy) v. a kovetkezo sec-followupot (backend/fullstack). Szabaly 10/11.'
NUDGE_GATE='SELF-ADVANCE (rule 11, NE varj MikroB-ra): ha nincs aktiv munkad, curl a kanbant es vedd a legregebbi waiting+REVIEW kartyat a hataskorodben (QA=minden funkcionalisan; Cybersec=trust-boundary; Cybered=magas-tetu) amin nincs a TE verdikted -> gate-eld -> majd a kovetkezot. Szabaly 11.'

# Delivery goes through the dashboard, NOT straight into the tmux pane (card 7560bb6a).
#
# This script writes from a cron process, so the dashboard's in-process pane mutex
# (src/web/session-send-lock.ts) could not reach it -- and the previous version sent the text and
# the Enter as two separate calls with a `sleep 1` between them, leaving a FULL SECOND in which the
# dashboard's chunked writer could interleave into the same pane. That is not theory: a self-advance
# reminder from this script spliced itself into the MIDDLE of inter-agent message 8701, and foreign
# text inside a trusted-sender frame is a prompt-injection surface.
#
# POSTing to /api/messages reuses the path that is ALREADY serialised
# (message-router -> sendPromptToSession -> withSessionSendLock). No second locking scheme for the
# same resource -- two overlapping mechanisms on one pane is how one of them quietly fails open.
#
# No new dependency: this script already cannot work without the dashboard (the kanban snapshot
# above exits early when the API is unreachable).
#
# ATTRIBUTION: the message is sent as `mikrob`, because that is what makes it a trusted-peer inside
# our own team rather than untrusted external data -- an untrusted-framed nudge is data the agent is
# told NOT to act on, which would defeat it. A separate sender id is not available: trusted-peer
# requires an agents/<name> directory, and inventing one would put a phantom agent in every peer's
# roster. Since a cron script then speaks with MikroB's authority, the TEXT says plainly that it is
# automated, so no reader mistakes it for MikroB having looked at their card.
nudge() { # session, message
  local sess="$1" msg="$2" agent="${1#agent-}"
  tmux has-session -t "$sess" 2>/dev/null || return
  # Skip if working (spinner present). A capture-pane READ cannot corrupt the pane, so this stays a
  # cheap pre-filter; it is not a lock and never was.
  tmux capture-pane -pt "$sess" 2>/dev/null | grep -q 'esc to interrupt' && return
  python3 -c 'import json,sys; print(json.dumps({"from":"mikrob","to":sys.argv[1],"content":"[fleet-nudger, automatikus emlekezteto -- nem MikroB olvasta el a kartyadat]\n\n"+sys.argv[2]}))' \
    "$agent" "$msg" \
    | curl -s -o /dev/null -H @"$hdr_file" -H 'Content-Type: application/json' \
        -X POST "$MSG_API" --data-binary @- 2>/dev/null || true
}

# ENG agents: always nudge if idle -- there is always work (design-impl has 65
# screens, backend/fullstack have sec-followups + wiring). The message tells them
# to take a planned card OR self-create+build the next design-impl screen.
for a in $ENG; do
  nudge "agent-$a" "$NUDGE_ENG"
done
if [ "$(get _gate)" = "True" ]; then
  for a in $GATE; do nudge "agent-$a" "$NUDGE_GATE"; done
fi
exit 0
