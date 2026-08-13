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
# No line-start anchor (card 165ff1af, 2026-08-13): this is a second, independently-drifted copy
# of the same regex carried by gate-dispatch-check.sh _extract_gate_line -- it required "Gate:" at
# the start of a line, which real card 165ff1af defeats by writing it mid-paragraph (preceded by a
# space, not a newline). Cybersec was nudged on 165ff1af 6+ times because THIS copy, not the one in
# gate-dispatch-check.sh, is what the nudger actually calls per-card. findall()[-1] instead of
# search() for the same reason gate-dispatch-check.sh takes the last match: a superseding Gate:
# line appended later (card 84fd2839) must win over a stale one earlier in the description.
gate_line_rx = re.compile(r"\bGate\s*:\s*(.+)$", re.M | re.I)
meta={}
by_id={c.get("id"): c for c in cards}
for cid in gate_cards:
    c=by_id.get(cid) or {}
    labels=",".join((l.get("name") or "").lstrip("@") for l in (c.get("labels") or []))
    matches=gate_line_rx.findall(c.get("description") or "")
    meta[cid]={"labels": labels, "gate_line": (matches[-1] if matches else "")}
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
# PER-AGENT no-change fingerprint for the CONDITIONAL eng agents (card 4cdb7e31). Same construction
# and the same fail-open stance as _fp, but over the PLANNED set plan[a] is derived from, because
# that is the set the ENG predicate actually reads. plan[a] is a pure existence test, so a card that
# is semantically finished yet still sits in "planned" without a BLOKKOLT- title -- the decision
# recorded ONLY in its comments (8779c351 "marad LOW, nem epitunk", b077e073 "csak ha uzletileg
# dontunk", f3278236 "kotott feltetel", b63c93b8 EPIC parent whose children are all done/waiting) --
# holds it True forever, and the full rule-11 nudge went out every minute regardless: 6 identical
# sends in a row, zero board delta between them.
# Per agent, not one shared hash: a change in the backend set must not resend the fullstack nudge.
# NOT a comment-reading heuristic (option b on the card): deciding "is this card really live" from the
# last comment would need a semantic convention nobody enforces, and its failure direction is the
# dangerous one -- a false negative silently starves a real card, while a false "changed" here costs
# exactly one redundant nudge.
eng_fp={}
for a in eng:
    src=sorted((c.get("id"), c.get("updated_at")) for c in cards
               if c.get("status")=="planned" and "BLOKKOLT" not in (c.get("title") or "")
               and c.get("assignee")==a)
    eng_fp[a]=hashlib.sha256(repr(src).encode()).hexdigest()
out["_eng_fp"]=eng_fp
print(json.dumps(out))
' 2>/dev/null)"
[ -z "$WORK" ] && exit 0

get() { echo "$WORK" | python3 -c "import json,sys;print(json.load(sys.stdin).get(sys.argv[1],False))" "$1" 2>/dev/null; }
eng_fp() { echo "$WORK" | python3 -c "import json,sys;print(json.load(sys.stdin).get('_eng_fp',{}).get(sys.argv[1],''))" "$1" 2>/dev/null; }

# Persisted no-change fingerprints (this script's own process never lives between cron runs).
# Overridable so a selftest never touches the live state file.
#
# ONE key per branch in ONE file, and the writer MERGES. The gate branch used to rewrite the whole
# object, which was harmless only while gateFp was the single key -- the moment a second branch
# stores its own fingerprint, a whole-object write drops the other one every run and silently turns
# that branch's precheck back off. This is the failure mode the precheck exists to prevent, so the
# read/write pair lives here once instead of being open-coded per branch.
NUDGER_STATE="${NUDGER_STATE_FILE:-$ROOT/store/.fleet-nudger-state.json}"
state_get() { NUDGER_STATE="$NUDGER_STATE" python3 -c '
import json, os, sys
try:
    print(json.load(open(os.environ["NUDGER_STATE"])).get(sys.argv[1], ""))
except Exception:
    print("")
' "$1" 2>/dev/null; }
state_set() { NUDGER_STATE="$NUDGER_STATE" python3 -c '
import json, os, sys
path = os.environ["NUDGER_STATE"]
try:
    data = json.load(open(path))
    if not isinstance(data, dict): data = {}
except Exception:
    data = {}
data[sys.argv[1]] = sys.argv[2]
try:
    with open(path, "w") as f: json.dump(data, f)
except Exception:
    pass
' "$1" "$2" 2>/dev/null; }

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
NUDGE_ENG='SELF-ADVANCE (rule 11, NE varj MikroB-ra): ha nincs aktiv munkad, curl a kanbant es vedd a neked cimzett legmagasabb-prio planned kartyat (nem BLOKKOLT) -> in_progress -> epitsd -> vegen waiting+REVIEW. Ha nincs planned, epitsd a design-impl kovetkezo kepernyoit (fron-ted/fron-teddy) v. a kovetkezo sec-followupot (backend/fullstack). Szabaly 10/11. TOKEN-SPOROLAS (Peti 2026-08-13): a kartyan mar rajta lehet egy LOCAL-LLM DRAFT komment (helyi 7B, offload-dispatch.sh irta) -- ELOSZOR ezt nezd meg. Ha lefedi a feladatot/hibat, VALIDALD (futtasd le a teszteket, olvasd at) es azt ALKALMAZD, NE irj ujra nulla-tol Claude-dal. Csak akkor irj sajat kodot, ha a draft hianyzik, hianyos, vagy hibas -- ilyenkor ird le roviden a REVIEW kommentben, mit hagytal el a draftbol es miert.'
if [ -n "$PRIORITY_PROJECTS" ]; then
  NUDGE_ENG="$NUDGE_ENG DISPATCH-PRIORITAS BEALLITVA: ($PRIORITY_PROJECTS) projekt(ek) kartyai MOST elozzek meg a tobbit, EBBEN a sorrendben (dashboard-beallitas, felulirja a rule 14 alap sorrendjet, amig ez a beallitas fenn van)."
fi
# Observable in --dry-run without printing the whole nudge body (same summary-line convention as
# GATE-WORK/ENG-WORK below).
[ "$DRY_RUN" = "1" ] && echo "PRIORITY-PROJECTS:${PRIORITY_PROJECTS:-none}"
NUDGE_GATE='SELF-ADVANCE (rule 11, NE varj MikroB-ra): ha nincs aktiv munkad, curl a kanbant es vedd a legregebbi waiting+REVIEW kartyat a hataskorodben (QA=minden funkcionalisan; Cybersec=trust-boundary; Cybered=magas-tetu) amin nincs a TE verdikted -> gate-eld -> majd a kovetkezot. Szabaly 11.'
# SELF-PICKED cards (card fa637e41). The loop below already runs gate-dispatch-check.sh per
# (card, agent) and never NAMES a card this agent is not designated for -- measured on the live
# board: cybered is offered beeb6963, not the Gate:QA-only 165ff1af. But the sentence above also
# tells the agent to go FIND a card by itself, and on that path the scope judgement is the agent's
# own prose reading of "a hataskorodben". That is how cybered re-picked one QA-only card 7 times.
# The deterministic answer already exists as a one-liner, so point at it instead of adding a second
# copy of the rule here: `check` derives designation from the card itself (verified: it returns
# not-designated for cybered on 165ff1af with no extra input).
#
# And explicitly: do NOT leave a skip comment. It was adopted as a workaround so the card would
# carry a trace, but a comment bumps kanban_cards.updated_at (db.ts addKanbanComment does that
# UPDATE outright), and updated_at is exactly the input to the no-change fingerprint above -- so
# every skip comment invalidates the fingerprint and re-arms the full gate-nudge round it was
# meant to stop. The trace is not needed either: not-designated is derived from the card
# description, so the check answers it identically whether or not anyone commented.
NUDGE_GATE="$NUDGE_GATE Ha MAGAD valasztasz kartyat (nem a lent megnevezettet), ELOSZOR futtasd ra: bash $ROOT/store/gate-dispatch-check.sh check <cardId> <a te agent-neved>. ADVISE-SKIP:not-designated -> NEM a te hataskorod, hagyd ki. NE irj rola skip-kommentet: a komment bumpolja a kartya updated_at-jet, ami a nudger no-change fingerprintjenek bemenete, tehat ujra-armozza az egesz gate-nudge kort. A check ugyanezt a valaszt adja komment nelkul is."

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
#
# NO-CHANGE PRECHECK (card 4cdb7e31), per agent: plan[a] answers "is there a planned card", never
# "is there anything NEW". Four cards on this board sit in planned indefinitely by decision rather
# than by a BLOKKOLT- title, so plan[a] is permanently True for backend and the identical full
# rule-11 nudge -- a complete context reload for the receiver -- went out every minute forever. Same
# remedy the gate branch already carries (bb1751f2): resend only when the agent's own candidate set
# actually moved.
#
# The fingerprint is burned on the DECISION to nudge, not on confirmed delivery, matching the gate
# branch. Delivery can still drop the send (no session, or a busy pane), and then this agent is not
# nudged again until its board changes. Accepted rather than papered over: a busy agent is already
# working, a session-less one is parked, and both are covered by rule 11 self-advance plus MikroB's
# 10-minute orchestrator. Making persistence depend on delivery would make the decision depend on
# live tmux state, which is precisely what this file keeps out of the predicate so it stays testable.
ENG_WITH_WORK=""
ENG_UNCHANGED=""
for a in $ENG_CONDITIONAL; do
  [ "$(get "$a")" = "True" ] || continue
  fp="$(eng_fp "$a")"
  # Empty fp -> the snapshot could not produce one; fail open and nudge, same stance as everywhere
  # else here. A cost guard that goes quiet on a parse hiccup is a fleet that quietly stops working.
  if [ -n "$fp" ] && [ "$fp" = "$(state_get "engFp:$a")" ]; then
    ENG_UNCHANGED="$ENG_UNCHANGED $a"
    continue
  fi
  state_set "engFp:$a" "$fp"
  ENG_WITH_WORK="$ENG_WITH_WORK $a"
done
[ "$DRY_RUN" = "1" ] && echo "ENG-WORK:${ENG_WITH_WORK:- none}"
# Reported separately from ENG-WORK so a suppressed agent is distinguishable from an agent that
# simply has no planned card -- both end in nobody being woken, but only one of them is this
# precheck acting, and a control that cannot tell them apart would pass either way.
[ "$DRY_RUN" = "1" ] && echo "ENG-UNCHANGED:${ENG_UNCHANGED:- none}"
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
# reach the exact same GATE-WORK conclusion as last time is pure waste. Persistence is the shared
# state_get/state_set pair above (card 4cdb7e31 gave the file a second key, so the write has to merge
# rather than replace the object).
FP="$(get "_fp")"
LAST_FP="$(state_get gateFp)"
if [ -n "$FP" ] && [ "$FP" = "$LAST_FP" ]; then
  # Nothing recorded changed since the last run that HAD this exact fingerprint -- no candidate
  # card entered/left the waiting-not-BLOKKOLT set, and none of them picked up a new comment. Short
  # no-op: skip the per-card gate-dispatch-check.sh calls and every nudge send this run.
  [ "$DRY_RUN" = "1" ] && echo "GATE-WORK:none (no-change precheck, fp unchanged)"
else
  state_set gateFp "$FP"
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
        | GATE_LABELS="$gate_labels" GATE_LINE="$gate_line" CID="$card" bash "$CHECK" decide "$a" 2>/dev/null || true)"
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
