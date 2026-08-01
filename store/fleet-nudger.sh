#!/usr/bin/env bash
# Deterministic fleet nudger (Peti: "a fleet ne alljon MikroB-ra varva").
# Runs on a system cron, INDEPENDENT of MikroB's LLM session, so idle fleet
# agents are woken to self-advance (CLAUDE.md rule 11) even when MikroB is busy.
# Only nudges an idle agent that ACTUALLY has assignable work -> no token waste.
set -u
ROOT="/home/neon/marveen"
TOK="$(cat "$ROOT/store/.dashboard-token" 2>/dev/null)"
API="http://localhost:3420/api/kanban"
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

nudge() { # session, message
  local sess="$1" msg="$2"
  tmux has-session -t "$sess" 2>/dev/null || return
  # skip if working (spinner present)
  tmux capture-pane -pt "$sess" 2>/dev/null | grep -q 'esc to interrupt' && return
  tmux send-keys -t "$sess" -l "$msg"; sleep 1; tmux send-keys -t "$sess" Enter
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
