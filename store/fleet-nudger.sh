#!/usr/bin/env bash
# Deterministic fleet nudger (Peti: "a fleet ne alljon MikroB-ra varva").
# Runs on a system cron, INDEPENDENT of MikroB's LLM session, so idle fleet
# agents are woken to self-advance (CLAUDE.md rule 11) even when MikroB is busy.
# Only nudges an idle agent that ACTUALLY has assignable work -> no token waste.
set -u
ROOT="/home/neon/marveen"
TOK="$(cat "$ROOT/store/.dashboard-token" 2>/dev/null)"
# DASH is overridable for the same reason gate-dispatch-check.sh makes it overridable: the only way
# to test "this agent is NOT woken" is to point the script at a board where nobody has work. It
# defaults to the live dashboard, so the cron entry is unchanged.
DASH="${DASH:-http://localhost:3420}"
API="$DASH/api/kanban"
MSG_API="$DASH/api/messages"
[ -z "$TOK" ] && exit 0

# SECURITY (Cybersec/gate-ops-scripts-token-in-argv, card edb7559f): the dashboard bearer token must
# NEVER be passed on a curl command line -- /proc/<pid>/cmdline is world-readable to any local user or
# process. A private 0600 temp file carries the header instead; -H @"$hdr_file" reads it without ever
# putting the token in argv. Removed on EXIT.
hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
trap 'rm -f "$hdr_file"' EXIT
printf 'Authorization: Bearer %s\n' "$TOK" > "$hdr_file"

# Split by whether "always work" is actually true for that agent (MikroB decision, msg 9910,
# follow-up to card 14acfadd). fron-ted/fron-teddy have their own always-available backlog (65
# design-impl screens they can self-create from), so unconditional is correct for them. backend/
# fullstack do not: "there is always a sec-followup" was the same kind of unconditional assumption
# the OLD gate predicate made ("any waiting card exists"), and it has the same failure mode --
# waking an idle agent that provably has nothing dispatched. plan[a] (below) is already computed
# from THIS SAME snapshot for exactly this purpose; the ENG loop just never read it.
ENG_ALWAYS="fron-ted fron-teddy"
ENG_CONDITIONAL="backend fullstack"
GATE="qa qa2 cybersec cybered"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

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
# Candidate cards for a gate: waiting, and not already annotated as a bound block. Cybered measured
# (msg 8873) that 53 of 55 waiting cards were BLOKKOLT-*, i.e. parked on another card landing, with
# no gate work on them. The per-agent verdict question is answered outside this snapshot.
# (No apostrophes in this block: the whole program is a single-quoted -c argument.)
gate_cards=[c.get("id") for c in cards
            if c.get("status")=="waiting" and "BLOKKOLT" not in (c.get("title") or "")]
# DESIGNATION (card 5bc10089): pulled from THIS SAME snapshot, not a second bulk fetch -- the
# fleet already has the labels and description in memory here. gate-dispatch-check.sh turns
# these into an exclusion; an empty value on either simply means no exclusion for that card.
import re
gate_line_rx = re.compile(r"^\s*Gate\s*:\s*(.+)$", re.M | re.I)
meta={}
by_id={c.get("id"): c for c in cards}
for cid in gate_cards:
    c=by_id.get(cid) or {}
    labels=",".join((l.get("name") or "").lstrip("@") for l in (c.get("labels") or []))
    m=gate_line_rx.search(c.get("description") or "")
    meta[cid]={"labels": labels, "gate_line": (m.group(1) if m else "")}
out={a:plan[a] for a in eng}
out["_gate_cards"]=gate_cards
out["_meta"]=meta
# No-change fingerprint (card bb1751f2): (id, updated_at) for every gate-candidate card, sorted so
# key order never causes a spurious mismatch. updated_at bumps on every new comment (db.ts
# addKanbanComment does an explicit UPDATE ... SET updated_at on the parent card alongside the
# INSERT), so this single value -- already in hand from THIS SAME fetch, no second request -- catches
# BOTH a changed candidate SET (a card entered/left "waiting, not BLOKKOLT") AND a new comment/verdict
# on an unchanged card (a card sitting still with no new comment has an unchanged updated_at). A
# deliberately coarse signal: it cannot tell a real verdict from an unrelated edit that also touches
# updated_at, so it only ever suppresses a resend when NOTHING recorded changed at all -- a
# false-changed reads as "resend", never the reverse, matching the existing fail-open stance in this file.
fp_src=sorted((c.get("id"), c.get("updated_at")) for c in cards if c.get("id") in set(gate_cards))
import hashlib
out["_fp"]=hashlib.sha256(repr(fp_src).encode()).hexdigest()
print(json.dumps(out))
' 2>/dev/null)"
[ -z "$WORK" ] && exit 0

get() { echo "$WORK" | python3 -c "import json,sys;print(json.load(sys.stdin).get(sys.argv[1],False))" "$1" 2>/dev/null; }

# Project dispatch priority (card 2d6587fe): rule 14 hardcodes "project cards (CleanCore) before
# non-project (marveen-infra)". This reads the same setting the dashboard's dropdown writes
# (store/project-dispatch-priority.json), so a Peti override at the dashboard actually reaches the
# nudge text instead of only living in a prose rule nobody re-reads at dispatch time. Empty/missing
# -> unchanged wording (rule 14's own default order still applies, just not named explicitly).
# Overridable so a selftest can point at a throwaway file instead of the live setting.
PRIORITY_CONFIG="${PROJECT_PRIORITY_CONFIG:-$ROOT/store/project-dispatch-priority.json}"
PRIORITY_PROJECTS="$(python3 -c "
import json
try:
    d = json.load(open('$PRIORITY_CONFIG'))
    p = d.get('priority') or []
    print(', '.join(x for x in p if isinstance(x, str)))
except Exception:
    print('')
" 2>/dev/null)"
NUDGE_ENG='SELF-ADVANCE (rule 11, NE varj MikroB-ra): ha nincs aktiv munkad, curl a kanbant es vedd a neked cimzett legmagasabb-prio planned kartyat (nem BLOKKOLT) -> in_progress -> epitsd -> vegen waiting+REVIEW. Ha nincs planned, epitsd a design-impl kovetkezo kepernyoit (fron-ted/fron-teddy) v. a kovetkezo sec-followupot (backend/fullstack). Szabaly 10/11.'
if [ -n "$PRIORITY_PROJECTS" ]; then
  NUDGE_ENG="$NUDGE_ENG DISPATCH-PRIORITAS BEALLITVA: ($PRIORITY_PROJECTS) projekt(ek) kartyai MOST elozzek meg a tobbit, EBBEN a sorrendben (dashboard-beallitas, felulirja a rule 14 alap sorrendjet, amig ez a beallitas fenn van)."
fi
# Observable in --dry-run without printing the whole nudge body (same summary-line convention as
# GATE-WORK/ENG-WORK below).
[ "$DRY_RUN" = "1" ] && echo "PRIORITY-PROJECTS:${PRIORITY_PROJECTS:-none}"
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
#
# --dry-run prints the decision instead of sending it. Added with the gate predicate below (card
# 14acfadd) so the change to WHO gets woken can be measured against the live board without waking
# anybody -- there is no other way to verify a nudger except by observing who it pokes.
nudge() { # session, message
  local sess="$1" msg="$2" agent="${1#agent-}"
  if ! tmux has-session -t "$sess" 2>/dev/null; then
    [ "$DRY_RUN" = "1" ] && echo "SKIP $agent (no session)"
    return
  fi
  # Skip if working (spinner present). A capture-pane READ cannot corrupt the pane, so this stays a
  # cheap pre-filter; it is not a lock and never was.
  if tmux capture-pane -pt "$sess" 2>/dev/null | grep -q 'esc to interrupt'; then
    [ "$DRY_RUN" = "1" ] && echo "SKIP $agent (busy)"
    return
  fi
  # The dry-run replaces ONLY the send, after every filter the live path applies -- a dry-run that
  # skipped a filter would report a nudge the real run does not make.
  if [ "$DRY_RUN" = "1" ]; then echo "WOULD-NUDGE $agent"; return; fi
  python3 -c 'import json,sys; print(json.dumps({"from":"mikrob","to":sys.argv[1],"content":"[fleet-nudger, automatikus emlekezteto -- nem MikroB olvasta el a kartyadat]\n\n"+sys.argv[2]}))' \
    "$agent" "$msg" \
    | curl -s -o /dev/null -H @"$hdr_file" -H 'Content-Type: application/json' \
        -X POST "$MSG_API" --data-binary @- 2>/dev/null || true
}

# fron-ted/fron-teddy: always nudge if idle -- design-impl always has a next screen to self-create.
for a in $ENG_ALWAYS; do
  nudge "agent-$a" "$NUDGE_ENG"
done
# backend/fullstack: nudge ONLY if plan[a] says a non-blocked planned card is actually assigned to
# them. Reuses the SAME per-agent snapshot the gate loop below reads from -- no second question
# asked of the board, just a check nothing was reading before now.
ENG_WITH_WORK=""
for a in $ENG_CONDITIONAL; do
  [ "$(get "$a")" = "True" ] && ENG_WITH_WORK="$ENG_WITH_WORK $a"
done
[ "$DRY_RUN" = "1" ] && echo "ENG-WORK:${ENG_WITH_WORK:- none}"
for a in $ENG_WITH_WORK; do
  nudge "agent-$a" "$NUDGE_ENG"
done
# GATE agents: nudge an agent ONLY if some card is actually waiting for THAT agent's verdict.
#
# The old predicate was `any waiting card exists`, which on this board is permanently true (70
# waiting cards, 49 of them BLOKKOLT-*). So all four gate agents were woken every run regardless of
# whether a single one of them had anything to answer -- Cybered checked its own 17 apparent hits
# and every one was a false positive. A woken gate agent re-reads cards and burns quota to conclude
# there is nothing to do.
#
# Two filters now, and the second is the load-bearing one: drop BLOKKOLT-* cards (a bound block is
# not gate work), then ask gate-dispatch-check.sh whether THIS agent's verdict is already the newest
# word on the card. That script is the existing answer to exactly this question -- it has a selftest
# and it distinguishes a stale verdict (a REVIEW landed after it -> real re-gate) from a replay.
# Reusing it beats a second copy of the rule here that would drift from it.
#
# COST. This runs every minute, and asking per (card, agent) would be 4 fetches per card -- ~84 API
# calls a minute on the current board, worst exactly in the fully-gated case this is meant to make
# cheap. So each card is fetched AT MOST ONCE per run into a temp cache and then decided offline for
# every agent; that is what `decide` is for, as opposed to `check`, which does its own fetch.
#
# FAIL-OPEN, matching gate-dispatch-check.sh's own stance: if the comments cannot be read, the card
# counts as work. A cost guard that goes quiet on an API hiccup is a fleet that silently stops gating.

# NO-CHANGE PRECHECK (card bb1751f2, Cybersec msg 10933): the SAME rule-11 nudge, in full, went out
# to the gate agents on 7 straight runs while the waiting-card list -- and every candidate card's
# updated_at -- was provably byte-identical each time. Each send is a FULL context reload for the
# receiving agent regardless of whether anything to act on actually changed, so a run that would
# reach the exact same GATE-WORK conclusion as last time is pure waste. Persisted across cron
# invocations (this script's own process never lives between runs); overridable so a selftest never
# touches the live state file.
NUDGER_STATE="${NUDGER_STATE_FILE:-$ROOT/store/.fleet-nudger-state.json}"
FP="$(get "_fp")"
LAST_FP="$(NUDGER_STATE="$NUDGER_STATE" python3 -c '
import json, os
try:
    print(json.load(open(os.environ["NUDGER_STATE"])).get("gateFp", ""))
except Exception:
    print("")
' 2>/dev/null)"
if [ -n "$FP" ] && [ "$FP" = "$LAST_FP" ]; then
  # Nothing recorded changed since the last run that HAD this exact fingerprint -- no candidate
  # card entered/left the waiting-not-BLOKKOLT set, and none of them picked up a new comment. Short
  # no-op: skip the per-card gate-dispatch-check.sh calls and every nudge send this run.
  [ "$DRY_RUN" = "1" ] && echo "GATE-WORK:none (no-change precheck, fp unchanged)"
else
  NUDGER_STATE="$NUDGER_STATE" FP="$FP" python3 -c '
import json, os
try:
    with open(os.environ["NUDGER_STATE"], "w") as f:
        json.dump({"gateFp": os.environ["FP"]}, f)
except Exception:
    pass
' 2>/dev/null
CARDS="$(echo "$WORK" | python3 -c 'import json,sys;print(" ".join(json.load(sys.stdin).get("_gate_cards",[])))' 2>/dev/null)"
CHECK="$ROOT/store/gate-dispatch-check.sh"
CACHE="$(mktemp -d)"
trap 'rm -f "$hdr_file"; rm -rf "$CACHE"' EXIT
# One file per candidate card, written ONCE for all four agents to read (same reasoning as the
# comment cache just below: this loop asks 4 agents about every card, and re-deriving designation
# per agent would just be the per-agent-fetch cost paid again for a different field).
echo "$WORK" | python3 -c '
import json, sys, os
meta = json.load(sys.stdin).get("_meta", {})
cache = sys.argv[1]
for cid, m in meta.items():
    with open(os.path.join(cache, cid + ".labels"), "w") as f: f.write(m.get("labels", ""))
    with open(os.path.join(cache, cid + ".gateline"), "w") as f: f.write(m.get("gate_line", ""))
' "$CACHE" 2>/dev/null
GATE_WITH_WORK=""
for a in $GATE; do
  has_work=0
  work_card=""
  for card in $CARDS; do
    if [ ! -f "$CACHE/$card" ]; then
      curl -s --max-time 12 -H @"$hdr_file" "$API/$card/comments" > "$CACHE/$card" 2>/dev/null
    fi
    body="$(cat "$CACHE/$card" 2>/dev/null)"
    if [ -z "$body" ]; then has_work=1; work_card="$card"; break; fi  # unreadable -> assume work (fail open)
    if [ -x "$CHECK" ] || [ -f "$CHECK" ]; then
      gate_labels="$(cat "$CACHE/$card.labels" 2>/dev/null)"
      gate_line="$(cat "$CACHE/$card.gateline" 2>/dev/null)"
      verdict="$(printf '%s' "$body" \
        | GATE_LABELS="$gate_labels" GATE_LINE="$gate_line" bash "$CHECK" decide "$a" 2>/dev/null || true)"
    else
      verdict="ALLOW"                                       # checker missing -> fail open
    fi
    case "$verdict" in
      ALLOW*|'') has_work=1; work_card="$card"; break ;;
      *) : ;;                                               # ADVISE-SKIP -> this card is answered
    esac
  done
  if [ "$has_work" = "1" ]; then
    GATE_WITH_WORK="$GATE_WITH_WORK $a"
    eval "WORK_CARD_$a=\"\$work_card\""
  fi
done
# The predicate result, separate from delivery. Delivery then drops agents with no session or a busy
# pane -- pre-existing filters, unrelated to whether the work exists. Keeping the two apart is what
# makes this testable: a control can assert the DECISION without depending on live tmux state.
[ "$DRY_RUN" = "1" ] && echo "GATE-WORK:${GATE_WITH_WORK:- none}"
# Naming the first still-open card (card 801774f2 follow-up: cybersec logged 4 straight replies
# saying an already-gated card was re-pinged, because the generic nudge made the agent re-scan its
# entire waiting queue from scratch every minute instead of going straight to the one real item).
for a in $GATE_WITH_WORK; do
  wc_var="WORK_CARD_$a"
  card_id="${!wc_var:-}"
  msg="$NUDGE_GATE"
  [ -n "$card_id" ] && msg="$msg KONKRET KARTYA amin meg nincs a verdikted: $card_id (ezzel kezdd, ne scannelj vegig mindent)."
  nudge "agent-$a" "$msg"
done
fi
exit 0
