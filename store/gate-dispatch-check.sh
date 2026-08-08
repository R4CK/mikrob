#!/usr/bin/env bash
# gate-dispatch-check.sh -- suppress a gate dispatch that has ALREADY been answered.
#
# WHY (Cybersec 2026-08-07, approved by MikroB): four times in one afternoon a gate
# dispatch arrived for a card whose verdict was already on the card -- once by 5 minutes,
# once by 60. Each one costs a full gate re-load (the agent re-reads the card, the commit,
# the diff and the surrounding code) for an answer that was already published. The fix is
# one cheap read before the dispatch, not more discipline.
#
# THE RULE, and why it is NOT "has the agent commented":
#   A gate agent SHOULD be re-dispatched when new work has landed since its verdict --
#   that is a legitimate re-gate (e.g. NO-GO -> fix -> re-gate). What is wasteful is a
#   dispatch when the agent's own verdict is the LATEST word on the card.
#   So: ADVISE-SKIP only when the agent's most recent comment is NEWER than the most recent
#   REVIEW comment. A REVIEW that postdates the verdict means there is something new to
#   look at, and the dispatch goes through.
#
# CONTRACT:
#   gate-dispatch-check.sh check <cardId> <agent>
#       -> "ALLOW"                          exit 0  (nothing known; dispatch it)
#       -> "ALLOW:no-verdict"               exit 0  (agent has never commented)
#       -> "ALLOW:stale-verdict"            exit 0  (a REVIEW landed after the verdict)
#       -> "ADVISE-SKIP:already-gated:<ts>" exit 8  (the verdict is the newest word)
#       -> "ADVISE-SKIP:no-review"          exit 8  (nothing was submitted for a gate to answer)
#       -> "ADVISE-SKIP:not-designated"     exit 8  (the card names OTHER gates, not this one)
#   gate-dispatch-check.sh decide <agent>   -> same verdict, comments JSON on STDIN, no API call
#       optional env: GATE_LABELS="qa,cybersec" (comma list of gate-agent names from the card's
#       OWN kanban labels) and/or GATE_LINE="QA + Cybersec ..." (the card's free-text "Gate: ..."
#       line, if any) -- see DESIGNATION below. Env, not CLI flags, so a caller never has to
#       shell-quote free-text card content.
#   gate-dispatch-check.sh selftest         -> offline self-test, no API calls, no side effects
#
# `decide` exists for a caller that must ask about MANY (card, agent) pairs at once -- the fleet
# nudger asks 4 gate agents about every non-blocked waiting card. Going through `check` would refetch
# the same card's comments once per agent; `decide` lets the caller fetch each card once and ask four
# times offline. It is the SAME _decide function the live path and the selftest use, so there is no
# second copy of the rule to drift.
#
# ADVISORY, NOT A BLOCK -- and this is the important part, measured rather than assumed.
# Replayed against the six real gate dispatches of 2026-08-07 it returns:
#     74ba7c78 -> ALLOW:stale-verdict   (the fix landed after the NO-GO: a correct re-gate)
#     the other five -> ADVISE-SKIP
# but THREE of those five carried a NEW QUESTION from the dispatcher (sweep the shadow
# class / prove the bypass and the XSS reasoning / show the two rows open no oracle), and
# each produced findings the original verdict did not contain. Only two were true replays.
# So a hard block would have suppressed three useful dispatches to save two wasteful ones.
# "Is there a new question" is not something this script can read. Therefore the caller
# must treat ADVISE-SKIP as a PROMPT -- skip a pure re-request, or dispatch anyway and say
# in the message what is new -- never as an automatic refusal.
#
# FAIL-OPEN BY DESIGN: any API/parse/network failure prints ALLOW and exits 0. This is a
# COST guard, not a security control -- a broken check must never silence a real dispatch.
# (The opposite direction would be a monitor that stops dispatching when the dashboard
# hiccups, which is how a fleet quietly stops gating.)
#
# NOT WIRED ANYWHERE YET. It changes when a gate agent is woken, so it goes live only
# after MikroB's review (a gate agent must not silently edit its own dispatch path).
#
# DESIGNATION (card 5bc10089, follow-up to 14acfadd; Cybered's proposals 1+3, MikroB decision
# msg 9850): "has no verdict" and "owes a verdict" are not the same fact. Rule 4 has MikroB
# pick which gates a card needs by risk; a card that never named a gate is not that gate's
# debt, and dispatching it there was Cybered's measured false-positive (4 of their apparent
# hits on the live board were cards whose OWN text designated other gates).
#
# TWO SOURCES, in priority order:
#   1. GATE_LABELS -- the card's own kanban labels (@qa/@qa2/@cybersec/@cybered). Durable,
#      because it takes a deliberate act by MikroB to attach one (rule 2's own convention,
#      just not yet used for gate designation). Authoritative when present.
#   2. GATE_LINE -- the card's free-text "Gate: ..." line, when no labels exist yet. Weaker
#      (prose, easy to under-specify), used as a fallback until labels are the norm.
# Neither present -> no exclusion, unchanged pre-existing behavior (only ~4 of 27 waiting
# cards carry a Gate: line at all today, so most of the board is unaffected either way).
#
# WHY EXCLUSION IS SAFE DESPITE A REAL COUNTER-EXAMPLE (fullstack measured it, card 14acfadd
# comment 10118): 6d46c7d3's own Gate line named QA + a Cybersec re-check, not Cybered -- yet
# Cybered is exactly who found the blocking finding there. Excluding Cybered from the passive
# NUDGE for that card would not have stopped that finding: Cybered reached it through their
# own initiative, not because a reminder fired, and said so on the card in the same breath
# ("NEM verdikt... en vagyok az egyik erintett"). MikroB's own close of 14acfadd made the same
# distinction explicit: a voluntary measurement outside the designated set is welcomed and
# valued, it is simply not OWED, so it should not generate an automated wake. This script only
# ever gates a passive reminder; it has no way to and does not try to stop an agent's own
# judgment about what to look at. The mutations below deliberately exercise this exact
# tradeoff so the decision stays auditable.
#
# "QA" DESIGNATES QA2 TOO, in both sources -- consistent with the qa2-covered-by-qa exception
# just above it: QA2 is a capacity twin of QA (CLAUDE.md's own words), not an independent role,
# so naming one names both for designation purposes.
set -euo pipefail

STORE="$(cd "$(dirname "$0")" && pwd)"
DASH="${DASH:-http://localhost:3420}"
TOKEN_FILE="${STORE}/.dashboard-token"

# SECURITY (gate-ops-scripts-token-in-argv): the bearer token goes to curl through a 0600
# header file, never on the command line where `ps` would show it.
_curl_get() { # $1 = path
  local hf; hf="$(mktemp)"; chmod 600 "$hf"
  printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE" 2>/dev/null)" > "$hf"
  curl -s --max-time 12 -H @"$hf" "${DASH}$1" 2>/dev/null
  rm -f "$hf" 2>/dev/null || true
}

# Decide from a comments JSON array on stdin. Kept as its own function so the selftest can
# exercise the SAME code the live path uses, instead of a re-implementation of it.
_decide() { # $1 = agent
  AGENT="$1" python3 -c '
import json, re, sys, os
agent = os.environ["AGENT"]
try:
    d = json.load(sys.stdin)
except Exception:
    print("ALLOW"); sys.exit(0)          # unparseable -> fail OPEN
cs = d if isinstance(d, list) else d.get("comments", [])
if not isinstance(cs, list):
    print("ALLOW"); sys.exit(0)

def ts(c):
    v = c.get("created_at")
    return v if isinstance(v, (int, float)) else 0

# A REVIEW is the signal that new work is on the table. Two narrowings, both measured:
#  - by SOMEONE ELSE: a gate agent quoting the word in its own verdict must not re-arm itself;
#  - ANCHORED to the start of a line, not "contains". Across 28 real comments mentioning the
#    word, only 8 were submissions; the other 20 were verdicts by other agents quoting it
#    ("QA PASS -- ...the REVIEW claim holds") or prose ("a te REVIEW-od utan"). A substring
#    test re-arms on all of those, which is the fail-open direction but pure noise.
review_rx = re.compile(r"^\s*(?:[#*>\-]*\s*)?REVIEW\b", re.M)
reviews = [ts(c) for c in cs
           if c.get("author") != agent and review_rx.search(c.get("content") or "")]

# NO REVIEW AT ALL -> there is nothing submitted for this gate to answer. A waiting card without a
# submission is parked for some other reason (a bound block, a question to MikroB), and treating it
# as gate work is what woke four gate agents for 53 blocked cards every nudger run (card 14acfadd).
# Checked BEFORE the verdict question on purpose: "nobody submitted anything" is a different and
# stronger answer than "you have not commented yet".
if not reviews:
    print("ADVISE-SKIP:no-review"); sys.exit(0)

GATE_AGENTS = ("qa", "qa2", "cybersec", "cybered")

def widen_qa(names):
    return names | {"qa", "qa2"} if ("qa" in names or "qa2" in names) else names

def designated_from_labels(csv):
    names = {n.strip().lstrip("@").lower() for n in csv.split(",") if n.strip()}
    names = {n for n in names if n in GATE_AGENTS}
    return widen_qa(names) if names else None

def designated_from_gate_line(text):
    low = text.lower()
    names = set()
    if re.search(r"\bqa2\b", low): names.add("qa2")
    if re.search(r"\bqa\b", low): names.add("qa")
    if re.search(r"\bcybersec\b", low): names.add("cybersec")
    if re.search(r"\bcybered\b", low): names.add("cybered")
    return widen_qa(names) if names else None

designated = (
    designated_from_labels(os.environ.get("GATE_LABELS", ""))
    or designated_from_gate_line(os.environ.get("GATE_LINE", ""))
)
if designated is not None and agent not in designated:
    print("ADVISE-SKIP:not-designated"); sys.exit(0)

mine = [c for c in cs if c.get("author") == agent]

# QA2-COVERED-BY-QA (MikroB decision, card 14acfadd follow-up, msg 9825): QA2 exists for parallel
# THROUGHPUT, not as a second mandatory review layer (CLAUDE.md own words) -- a QA PASS on this
# SAME submission already covers qa2. Modeled as widening "mine" with qa PASS comment rather than
# a separate branch, so the EXISTING staleness rule re-arms it for free: if MikroB explicitly
# re-requests qa2 (e.g. after a prior FAIL, on a fix commit), that arrives as a new REVIEW, and
# last_review > last_mine already fires ALLOW:stale-verdict -- no separate case needed for that
# exception. Narrow on purpose: only a PASS counts (a QA FAIL does not excuse qa2 from anything),
# and only for agent == qa2 (the decision was QA/QA2-specific, not a general gate-rotation rule).
if agent == "qa2":
    qa_pass_rx = re.compile(r"^\s*QA\s+PASS\b", re.I)
    mine = mine + [c for c in cs if c.get("author") == "qa" and qa_pass_rx.search(c.get("content") or "")]
if not mine:
    print("ALLOW:no-verdict"); sys.exit(0)

last_mine = max(ts(c) for c in mine)
last_review = max(reviews)

if last_review > last_mine:
    print("ALLOW:stale-verdict")
else:
    print(f"ADVISE-SKIP:already-gated:{int(last_mine)}")
'
}

case "${1:-}" in
  check)
    CARD="${2:-}"; AGENT="${3:-}"
    [[ -n "$CARD" && -n "$AGENT" ]] || { echo "usage: $0 check <cardId> <agent>" >&2; exit 2; }
    body="$(_curl_get "/api/kanban/${CARD}/comments" || true)"
    [[ -n "$body" ]] || { echo "ALLOW"; exit 0; }   # no answer from the API -> fail OPEN
    # DESIGNATION (card 5bc10089): fetch the card's own labels + description here too, same as
    # the nudger does from its bulk snapshot, so `check` and `decide` never drift on this rule.
    # There is no single-card GET; the bulk list is what the rest of the fleet already uses for
    # this. Best-effort: any failure here just leaves GATE_LABELS/GATE_LINE unset (fail OPEN,
    # matching this whole script's stance -- a lookup failure must widen dispatch, never narrow it).
    CARD_JSON="$(_curl_get "/api/kanban" || true)"
    GATE_LABELS="$(CID="$CARD" python3 -c '
import json, os, sys
try: cards = json.load(sys.stdin)
except Exception: sys.exit(0)
for c in cards if isinstance(cards, list) else []:
    if c.get("id") == os.environ["CID"]:
        print(",".join(l.get("name", "").lstrip("@") for l in (c.get("labels") or [])))
        break
' <<< "$CARD_JSON" 2>/dev/null || true)"
    GATE_LINE="$(CID="$CARD" python3 -c '
import json, os, re, sys
try: cards = json.load(sys.stdin)
except Exception: sys.exit(0)
rx = re.compile(r"^\s*Gate\s*:\s*(.+)$", re.M | re.I)
for c in cards if isinstance(cards, list) else []:
    if c.get("id") == os.environ["CID"]:
        m = rx.search(c.get("description") or "")
        if m: print(m.group(1))
        break
' <<< "$CARD_JSON" 2>/dev/null || true)"
    verdict="$(printf '%s' "$body" | GATE_LABELS="$GATE_LABELS" GATE_LINE="$GATE_LINE" _decide "$AGENT" || echo ALLOW)"
    echo "$verdict"
    [[ "$verdict" == ADVISE-SKIP:* ]] && exit 8 || exit 0
    ;;

  decide)
    AGENT="${2:-}"
    [[ -n "$AGENT" ]] || { echo "usage: $0 decide <agent>  (comments JSON on stdin)" >&2; exit 2; }
    verdict="$(_decide "$AGENT" || echo ALLOW)"
    echo "$verdict"
    [[ "$verdict" == ADVISE-SKIP:* ]] && exit 8 || exit 0
    ;;

  selftest)
    fail=0
    t() { # $1 = label, $2 = expected prefix, $3 = agent, stdin = comments json
      local got; got="$(_decide "$3")"
      if [[ "$got" == "$2"* ]]; then echo "  ok   $1 -> $got"
      else echo "  FAIL $1 -> got '$got', expected '$2'*"; fail=1; fi
    }
    echo "gate-dispatch-check selftest"
    # CONTRACT CHANGE (card 14acfadd): a card with no submission is no longer "dispatch it" -- see
    # the no-review branch in _decide. The two cases below expected ALLOW before that.
    t "no comments at all"            "ADVISE-SKIP:no-review" cybersec <<< '[]'
    t "a comment, but no REVIEW"      "ADVISE-SKIP:no-review" cybersec <<< '[{"author":"mikrob","created_at":100,"content":"kotott blokk, a 2a37a4df landolasara var"}]'
    t "only someone else's REVIEW"    "ALLOW:no-verdict"   cybersec <<< '[{"author":"backend","created_at":100,"content":"REVIEW -- done"}]'
    t "verdict is the newest word"    "ADVISE-SKIP:already-gated" cybersec <<< '[{"author":"backend","created_at":100,"content":"REVIEW"},{"author":"cybersec","created_at":200,"content":"CYBERSEC GO"}]'
    t "new REVIEW after the verdict"  "ALLOW:stale-verdict" cybersec <<< '[{"author":"cybersec","created_at":200,"content":"NO-GO"},{"author":"backend2","created_at":300,"content":"REVIEW -- fixed"}]'
    t "another gate commented later"  "ADVISE-SKIP:already-gated" cybersec <<< '[{"author":"backend","created_at":100,"content":"REVIEW"},{"author":"cybersec","created_at":200,"content":"GO"},{"author":"qa","created_at":300,"content":"QA PASS"}]'
    t "own comment says REVIEW"       "ADVISE-SKIP:already-gated" cybersec <<< '[{"author":"backend","created_at":100,"content":"REVIEW"},{"author":"cybersec","created_at":200,"content":"GO -- the REVIEW claim holds"}]'
    t "malformed json"                "ALLOW"              cybersec <<< 'not json'
    t "object-wrapped comments"       "ADVISE-SKIP:already-gated" cybersec <<< '{"comments":[{"author":"backend","created_at":100,"content":"REVIEW"},{"author":"cybersec","created_at":200,"content":"GO"}]}'
    # ts() robustness: a comment with no created_at must not crash the max(). Needs a REVIEW present
    # now, otherwise the no-review branch answers first and the ts() path is never reached.
    t "missing created_at"            "ADVISE-SKIP:already-gated" cybersec <<< '[{"author":"backend","content":"REVIEW"},{"author":"cybersec","content":"GO"}]'
    # Anchoring: a later comment that only MENTIONS the word must not re-arm the dispatch.
    t "later peer QUOTES the word"    "ADVISE-SKIP:already-gated" cybersec <<< '[{"author":"backend","created_at":100,"content":"REVIEW"},{"author":"cybersec","created_at":200,"content":"GO"},{"author":"mikrob","created_at":300,"content":"bontsd fel, a te REVIEW-od utan nyitom a gyerekkartyat"}]'
    t "later peer SUBMITS a review"   "ALLOW:stale-verdict" cybersec <<< '[{"author":"cybersec","created_at":200,"content":"GO"},{"author":"backend","created_at":300,"content":"REVIEW -- kesz, commit abc1234"}]'
    t "submission behind a md bullet" "ALLOW:stale-verdict" cybersec <<< '[{"author":"cybersec","created_at":200,"content":"GO"},{"author":"backend","created_at":300,"content":"## REVIEW\nkesz"}]'
    # `decide` must be the same answer as the internal function, and must carry the exit code the
    # nudger branches on -- a subcommand that printed the right word with the wrong status would
    # make every card look like work.
    d() { # $1 = label, $2 = expected verdict prefix, $3 = expected exit, $4 = agent
      local got st
      got="$(bash "$0" decide "$4" <<< "$SELFTEST_JSON")" && st=0 || st=$?
      if [[ "$got" == "$2"* && "$st" == "$3" ]]; then echo "  ok   $1 -> $got (exit $st)"
      else echo "  FAIL $1 -> got '$got' exit $st, expected '$2'* exit $3"; fail=1; fi
    }
    SELFTEST_JSON='[{"author":"backend","created_at":100,"content":"REVIEW"}]'
    d "decide: agent has no verdict"  "ALLOW:no-verdict"          0 cybersec
    SELFTEST_JSON='[{"author":"backend","created_at":100,"content":"REVIEW"},{"author":"cybersec","created_at":200,"content":"GO"}]'
    d "decide: already gated"         "ADVISE-SKIP:already-gated" 8 cybersec

    # QA2-covered-by-QA (MikroB decision, msg 9825).
    SELFTEST_JSON='[{"author":"backend","created_at":100,"content":"REVIEW"},{"author":"qa","created_at":200,"content":"QA PASS -- commit abc1234"}]'
    d "decide: QA PASS covers qa2"                "ADVISE-SKIP:already-gated" 8 qa2
    SELFTEST_JSON='[{"author":"backend","created_at":100,"content":"REVIEW"},{"author":"qa","created_at":200,"content":"QA FAIL -- 3 broken assertions"}]'
    d "decide: a QA FAIL does NOT cover qa2"       "ALLOW:no-verdict"          0 qa2
    SELFTEST_JSON='[{"author":"backend","created_at":100,"content":"REVIEW"},{"author":"qa","created_at":200,"content":"QA PASS -- commit abc1234"},{"author":"backend","created_at":300,"content":"REVIEW -- fix for the FAIL, commit def5678"}]'
    d "decide: a re-request after QA PASS re-arms" "ALLOW:stale-verdict"       0 qa2
    SELFTEST_JSON='[{"author":"backend","created_at":100,"content":"REVIEW"},{"author":"qa","created_at":200,"content":"QA PASS -- commit abc1234"}]'
    d "decide: the QA-covers-qa2 exception is qa2-only" "ALLOW:no-verdict"     0 cybersec

    # DESIGNATION (card 5bc10089). dd() is d() plus GATE_LABELS/GATE_LINE, since designation is
    # per-card context the plain d() has no way to pass.
    dd() { # $1=label $2=expected-prefix $3=expected-exit $4=agent $5=GATE_LABELS $6=GATE_LINE
      local got st
      got="$(GATE_LABELS="$5" GATE_LINE="$6" bash "$0" decide "$4" <<< "$SELFTEST_JSON")" && st=0 || st=$?
      if [[ "$got" == "$2"* && "$st" == "$3" ]]; then echo "  ok   $1 -> $got (exit $st)"
      else echo "  FAIL $1 -> got '$got' exit $st, expected '$2'* exit $3"; fail=1; fi
    }
    SELFTEST_JSON='[{"author":"backend","created_at":100,"content":"REVIEW"}]'
    dd "designation: labels name the agent -> unaffected"      "ALLOW:no-verdict"      0 cybersec "qa,cybersec" ""
    dd "designation: labels name OTHER agents -> excluded"     "ADVISE-SKIP:not-designated" 8 cybered "qa,cybersec" ""
    dd "designation: gate-line names the agent -> unaffected"  "ALLOW:no-verdict"      0 cybersec "" "QA + Cybersec (RBAC-akciok)"
    dd "designation: gate-line names OTHER agents -> excluded" "ADVISE-SKIP:not-designated" 8 cybered "" "QA + Cybersec (RBAC-akciok)"
    dd "designation: no labels, no gate-line -> unaffected"    "ALLOW:no-verdict"      0 cybered "" ""
    # Real case, card 2b7fe8ee: "Gate: QA." names only QA -> cybered excluded.
    dd "designation: 2b7fe8ee-shape, Gate: QA. excludes cybered" "ADVISE-SKIP:not-designated" 8 cybered "" "QA."
    dd "designation: 2b7fe8ee-shape, QA itself is unaffected"    "ALLOW:no-verdict"      0 qa "" "QA."
    # Real case, card 6d46c7d3: names QA + a Cybersec re-check, not Cybered. This is the counter-
    # example fullstack measured (comment 10118): Cybered found the blocking finding on this exact
    # card despite not being named. MikroB decided anyway (msg 9850) -- exclusion only silences the
    # passive NUDGE, it does not and cannot stop an agent's own initiative, which is what actually
    # happened here. Encoded as a test, not a footnote, so a reader hits the tradeoff on purpose.
    dd "designation: 6d46c7d3-shape EXCLUDES cybered (known, accepted tradeoff)" "ADVISE-SKIP:not-designated" 8 cybered "" "QA (a blokkolo ketto), Cybersec ujra-nezi telepites elott."
    # Labels take priority over a conflicting gate-line.
    dd "designation: labels override a conflicting gate-line"  "ALLOW:no-verdict"      0 cybered "cybered" "QA only, nothing else"
    # QA/QA2 symmetry: naming either designates both.
    SELFTEST_JSON='[{"author":"backend","created_at":100,"content":"REVIEW"}]'
    dd "designation: Gate: QA. also designates qa2 (twin)"     "ALLOW:no-verdict"      0 qa2 "" "QA."
    dd "designation: a QA2-only label also designates qa"      "ALLOW:no-verdict"      0 qa "qa2" ""
    # Unrecognized free text (no gate keyword at all) must not accidentally exclude everyone.
    dd "designation: unparseable gate-line -> no exclusion"    "ALLOW:no-verdict"      0 cybered "" "see the linked design doc"

    [[ $fail -eq 0 ]] && { echo "selftest: PASS"; exit 0; } || { echo "selftest: FAIL"; exit 1; }
    ;;

  *)
    echo "usage: $0 {check <cardId> <agent>|selftest}" >&2; exit 2 ;;
esac
