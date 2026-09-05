#!/usr/bin/env bash
# card-build-route.sh -- should a planned card be BUILT primarily by the local model? (card 79f62fd7)
#
# Peti's ask: the local models exist so the easier programming work goes to them. Today the
# heartbeat's offload sweep drafts MECHANICAL FRAGMENTS of a card that has already been dispatched
# online; no card is ever built local-first. This decides, at dispatch time, whether a card is
# simple enough that the local model should write the first full draft -- which the online role
# agent then reviews and refines, through the SAME QA/Cybersec gates as any other card.
#
# THE SAFETY DIRECTION IS THE OPPOSITE OF route-classify.sh's, AND THAT IS THE WHOLE DESIGN.
# That script's guarantee is "may only move a task LOCAL -> ONLINE": a wrong answer, a hung model or
# a missing model can cost an online draft but never open a hole. This one decides the OTHER way --
# the standing behaviour is ONLINE, and a LOCAL verdict moves work to a weaker builder. So the
# structure is borrowed (determinism, prefilter, windowing, own audit log, fail fast) and the
# fail-safe is inverted: EVERY doubt resolves to ONLINE.
#
# Concretely, ONLINE is returned when: the kill-switch is set, the card cannot be read, the text is
# empty or absurdly long, the deterministic gate fires, route-classify says SECURITY, the model says
# COMPLEX, the model is busy, times out, is missing, or answers anything unparseable. LOCAL is
# returned ONLY when every stage affirmatively passes. It is a conjunction, not a vote.
#
# WHAT A WRONG ANSWER COSTS, stated so the risk is not overstated either. A LOCAL card is still
# built by the online agent -- it reviews and refines the draft -- and still passes QA + Cybersec.
# The failure mode is ANCHORING (a plausible-looking wrong draft accepted rather than discarded),
# not unreviewed code shipping. That is real, and it is why the bar for LOCAL is high; it is also
# why this is worth doing at all.
#
# Usage:
#   card-build-route.sh <cardId>          # reads the card from the dashboard API
#   card-build-route.sh --text "<text>"   # classify literal text (tests, dry runs)
#   card-build-route.sh --text "<text>" --priority high
# Prints LOCAL | ONLINE. Exit 0 always -- the caller decides, and there is no failure mode in which
# this script should stop a dispatch.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM="${CARD_BUILD_ROUTE_LLM:-$HERE/local-llm.sh}"
CLASSIFY="${CARD_BUILD_ROUTE_CLASSIFY:-$HERE/route-classify.sh}"
TIMEOUT="${CARD_BUILD_ROUTE_TIMEOUT:-45}"
API="${CARD_BUILD_ROUTE_API:-http://localhost:3420}"
TOKEN_FILE="${CARD_BUILD_ROUTE_TOKEN_FILE:-$HERE/.dashboard-token}"

# EVIDENCE THAT THE CONTROL RAN, same reasoning as route-classify.sh's log: a dead classifier and a
# classifier that ran and said ONLINE are otherwise byte-identical (both leave the dispatch alone),
# so the one thing this file must never do is fail invisibly. Every path writes a verdict.
#
# The card TEXT is deliberately not logged, only its length -- a control's audit trail must not
# quietly become a second copy of the board.
LOG="${CARD_BUILD_ROUTE_LOG:-$HERE/card-build-route.log}"
CARD_ID="-"
log_verdict() { # $1 = verdict, $2 = path, $3 = model calls
  printf '%s\t%s\t%s\t%s\tcalls=%s\tchars=%s\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$CARD_ID" "$1" "$2" "$3" "${#TEXT}" >> "$LOG" 2>/dev/null || true
}
online() { log_verdict ONLINE "$1" "${2:-0}"; echo ONLINE; exit 0; }

TEXT=""
PRIORITY=""
case "${1:-}" in
  --text)
    TEXT="${2:-}"
    [ "${3:-}" = "--priority" ] && PRIORITY="${4:-}"
    ;;
  "" )
    online no-argument
    ;;
  *)
    CARD_ID="$1"
    # A card id is a hex slug. Refuse anything else rather than interpolating it into a URL.
    if ! printf '%s' "$CARD_ID" | grep -Eq '^[0-9a-f]{6,40}$'; then
      online bad-card-id
    fi
    ;;
esac

# --- 0. KILL-SWITCH ----------------------------------------------------------------------------
# Off returns exactly today's behaviour. Deliberately spelled as an opt-OUT (`=off`) rather than the
# opt-in the outgoing-copy-gate uses: this script only ever RECOMMENDS, it blocks nothing and costs
# nothing when it is not called, so the failure mode of a typo here is a slower fleet, not a weaker
# one -- the opposite of that gate, where a typo would have armed 14 agents.
if [ "${CARD_BUILD_ROUTE:-on}" = "off" ]; then
  online kill-switch
fi

# --- 1. READ THE CARD --------------------------------------------------------------------------
if [ -z "$TEXT" ]; then
  TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null)"
  [ -n "$TOKEN" ] || online no-token
  CARD_JSON="$(printf 'Authorization: Bearer %s\n' "$TOKEN" \
    | timeout 10 curl -H @- -s "$API/api/kanban/$CARD_ID" 2>/dev/null)"
  [ -n "$CARD_JSON" ] || online card-unreadable
  read -r PRIORITY TEXT_B64 <<< "$(printf '%s' "$CARD_JSON" | CARD_JSON_STDIN=1 python3 -c '
import base64, json, sys
try:
    c = json.load(sys.stdin)
except Exception:
    print("- -"); raise SystemExit
if isinstance(c, dict) and "card" in c:
    c = c["card"]
if not isinstance(c, dict):
    print("- -"); raise SystemExit
# Title AND description: a card whose title reads simple can carry the real work in its body.
txt = "%s\n%s" % (c.get("title") or "", c.get("description") or "")
print("%s %s" % (c.get("priority") or "-", base64.b64encode(txt.encode("utf-8")).decode()))
' 2>/dev/null)"
  [ -n "${TEXT_B64:-}" ] && [ "$TEXT_B64" != "-" ] || online card-unparseable
  TEXT="$(printf '%s' "$TEXT_B64" | base64 -d 2>/dev/null)"
fi

[ -n "${TEXT// }" ] || online empty-text
# A card longer than this is, by its size alone, not the "small, well-bounded unit" this routes.
# The bound also keeps the windowed pass below from turning into an unbounded number of model calls.
[ "${#TEXT}" -le "${CARD_BUILD_ROUTE_MAX_CHARS:-4000}" ] || online too-long

# --- 2. DETERMINISTIC ONLINE GATE, BEFORE THE MODEL --------------------------------------------
# Everything here can only ESCALATE, so it is safe to keep crude: a false positive costs one online
# build, which is what we do today anyway.

# Priority first. urgent/high is a statement about CONSEQUENCE, and a draft that has to be thrown
# away is most expensive exactly there. Cheap, deterministic, and it needs no model.
case "$PRIORITY" in
  urgent|high) online priority-"$PRIORITY" ;;
esac

SHORT="$(printf '%s' "$TEXT" | tr '\n' ' ' | head -c 1200)"

# STEERING IS ITSELF A SIGNAL, and here the stakes are inverted relative to route-classify.sh's
# version of this filter. There, an injected "already reviewed by security" bought the attacker a
# weaker CHECK. Here, an injected "this is trivial boilerplate" buys a weaker BUILDER -- so the same
# shapes must escalate, and the model must not be asked at all once the input is trying to answer
# for it.
if printf '%s' "$SHORT" | grep -Eqi \
  '(answer|respond with|reply)[[:space:]]+(only[[:space:]]+)?(easy|complex|local|online)|classify[[:space:]]+(it|this|the[[:space:]]+card)?[[:space:]]*as|(ignore|disregard)[[:space:]]+[^.]*(previous|above|prior|triage|earlier|foregoing)[^.]*instruction|instructions?[[:space:]]+above|^[[:space:]]*system:|the[[:space:]]+correct[[:space:]]+(one-word[[:space:]]+)?answer[[:space:]]+is|(this|it)[[:space:]]+is[[:space:]]+(just[[:space:]]+)?(trivial|simple|boilerplate)|route[[:space:]]+(this[[:space:]]+)?(to[[:space:]]+)?local'; then
  online steering-attempt
fi

# Work that is structurally multi-decision. These are not "hard words" -- each names a thing that
# cannot be drafted from the card text alone, because the right answer lives in code the drafter
# cannot see, or in a contract other code depends on.
#
# THE LIST WAS MEASURED, NOT IMAGINED, and it was measured twice. The first draft carried only the
# structural words (migration, architecture, contract, wiring...). Run against 15 REAL cards from
# this board with the model stubbed to its most permissive answer, FIVE of them still came out
# LOCAL -- meaning nothing but the 7B stood between them and a weaker builder. The selftest reports
# that number on every run, because it is the number that matters: a card kept online only by the
# model is one bad draw from being routed local.
#
# The five named four classes the structural list could not see, so each is now here by NAME:
#   money        (d10e3e70, monthly/yearly billing checkout + webhook)
#   stored-object integrity and presigning (6fad0981 presign checksum; 555e4466 thumb pinning)
#   trusting a client-supplied value       (11ed92dd EXIF vs server time)
#   assembling a document from other sources (22598bec USER-MANUAL)
# Widening a fail-safe gate costs speed and nothing else, which is why the bar for adding a word
# here is deliberately low -- and why battery B of the selftest exists, to prove the additions did
# not swallow the genuinely bounded work this whole card is FOR.
if printf '%s' "$SHORT" | grep -Eqi \
  'migrac|migration|séma|sema|schema|rollback|down-migr|architekt|architect|refaktor|refactor|kontraktus|contract|api-szerzod|breaking|több[- ]fájl|tobb[- ]fajl|multi-file|wiring|bekötés|bekotes|composition root|main\.ts|feature flag|deploy|infra|worktree|landol|merge'; then
  online deterministic-multi-decision
fi

# Money. A wrong draft here is not a slow review, it is a billing defect.
if printf '%s' "$SHORT" | grep -Eqi \
  'dijfizet|díjfizet|fizetes|fizetés|billing|checkout|webhook|invoice|szaml|száml|subscription|elofizet|előfizet|payment|stripe|lemonsqueezy|refund|price|arazas|árazás'; then
  online deterministic-money
fi

# Stored-object integrity, presigning and the crypto around them.
if printf '%s' "$SHORT" | grep -Eqi \
  'presign|x-amz|checksum|sha256|sha-256|hash|pinnel|pinning|object lock|bucket|minio|s3|storage|tarol|tárol|retenci|exif|metaadat|metadata'; then
  online deterministic-object-integrity
fi

# Trusting a value the client supplied -- the shape of most of this board's SEC findings.
if printf '%s' "$SHORT" | grep -Eqi \
  'validac|validál|validat|josagi|jósági|plausib|kliens[ -]?altal|client-supplied|confirm|megerosit|megerősít|spoof|forge|hamisit|hamisít'; then
  online deterministic-client-supplied-value
fi

# Assembling a document out of other sources: a judgement task wearing a docs label.
if printf '%s' "$SHORT" | grep -Eqi \
  'user-manual|kezikonyv|kézikönyv|felhasznaloi kezi|felhasználói kézi|readme|decisions\.md|dokumentaci|dokumentáci|funkciolist|funkciólist'; then
  online deterministic-document-assembly
fi

# --- 3. REUSE THE HARDENED SECURITY CLASSIFIER --------------------------------------------------
# Rule 10, and more to the point: writing a second, weaker security classifier next to one that
# survived five NO-GO rounds would be the worst possible place to reinvent anything. Its SECURITY
# verdict is a hard ONLINE here. Its UNKNOWN is NOT treated as "fine" -- see below.
SEC="ONLINE-BY-DEFAULT"
if [ -x "$CLASSIFY" ] || [ -f "$CLASSIFY" ]; then
  SEC="$(timeout "$TIMEOUT" bash "$CLASSIFY" "$SHORT" 2>/dev/null | tr -d '[:space:]')"
fi
case "$SEC" in
  *SECURITY*) online route-classify-security 1 ;;
  *MECHANICAL*) : ;;   # the only affirmative pass
  # UNKNOWN, empty, missing script, timeout: the semantic security check did NOT run. In
  # route-classify's own caller that is harmless, because there UNKNOWN leaves a deterministic
  # verdict standing. Here it would mean routing to a weaker builder having never asked the
  # security question -- so it is ONLINE.
  *) online route-classify-abstained 1 ;;
esac

# --- 4. THE MODEL: EASY vs COMPLEX, ANY COMPLEX WINDOW WINS -------------------------------------
# Windowed for the same measured reason route-classify.sh is: asked about a whole card at once, the
# verdict tracks the BULK of the text rather than its most demanding part, so one paragraph of
# ordinary prose in front of a real design decision flips it. Here the max is COMPLEX.
WINDOW="${CARD_BUILD_ROUTE_WINDOW:-300}"
STRIDE="${CARD_BUILD_ROUTE_STRIDE:-150}"
HALF=$(( TIMEOUT / 2 )); [ "$HALF" -ge 1 ] || HALF=1
GPU_BUSY_RC=6

ask() { # $1 = text -> EASY | COMPLEX | UNKNOWN | BUSY
  local raw rc out
  raw="$(LOCAL_LLM_TEMPERATURE=0 LOCAL_LLM_SEED=0 LOCAL_LLM_LOCK_WAIT="$HALF" LOCAL_LLM_TIMEOUT="$HALF" \
         timeout "$TIMEOUT" bash "$LLM" --task card-build-route --caller card-build-route --source routing \
          "$1" 2>/dev/null)"
  rc=$?
  [ "$rc" -eq "$GPU_BUSY_RC" ] && { echo BUSY; return 0; }
  out="$(printf '%s' "$raw" | tr -dc 'A-Za-z' | tr '[:lower:]' '[:upper:]')"
  case "$out" in
    *COMPLEX*) echo COMPLEX ;;
    *EASY*)    echo EASY ;;
    *)         echo UNKNOWN ;;
  esac
}

WINDOWS="$(WINDOW="$WINDOW" STRIDE="$STRIDE" TXT="$SHORT" python3 -c '
import os
t, w, s = os.environ["TXT"], int(os.environ["WINDOW"]), int(os.environ["STRIDE"])
if len(t) <= w:
    print(t)
else:
    i = 0
    while True:
        print(t[i:i + w])
        if i + w >= len(t):
            break
        i += s
' 2>/dev/null)"
[ -n "$WINDOWS" ] || WINDOWS="$SHORT"

CALLS=0
SAW_EASY=0
while IFS= read -r win; do
  [ -n "${win// }" ] || continue
  CALLS=$((CALLS + 1))
  case "$(ask "$win")" in
    # First COMPLEX ends it: the maximum is decided and no later window can lower it.
    COMPLEX) online model-complex "$CALLS" ;;
    EASY)    SAW_EASY=1 ;;
    # The model never saw this window. Unlike route-classify, we cannot shrug: a window we did not
    # read might be the one carrying the decision, and the verdict we are considering is the
    # permissive one. Both of these are ONLINE, under their own path names so the audit trail can
    # tell "the GPU was busy" from "the model answered nothing useful".
    BUSY)    online model-busy "$CALLS" ;;
    *)       online model-unknown "$CALLS" ;;
  esac
done <<< "$WINDOWS"

# Every window answered, every answer was EASY, and every earlier stage passed.
[ "$SAW_EASY" -eq 1 ] || online no-window-answered "$CALLS"
log_verdict LOCAL all-stages-passed "$CALLS"
echo LOCAL
exit 0
