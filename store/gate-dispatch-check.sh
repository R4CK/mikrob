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
#       -> "ADVISE-SKIP:done-or-archived"   exit 8  (the card itself is already done/archived)
#   gate-dispatch-check.sh decide <agent>   -> same verdict, comments JSON on STDIN, no API call
#       optional env: GATE_LABELS="qa,cybersec" (comma list of gate-agent names from the card's
#       OWN kanban labels) and/or GATE_LINE="QA + Cybersec ..." (the card's free-text "Gate: ..."
#       line, if any) -- see DESIGNATION below. Also CARD_STATUS="done" and/or CARD_ARCHIVED="1" if
#       the caller has the card's own status to hand (see DONE/ARCHIVED below); `check` always has
#       this, `decide` only if its caller passes it. Env, not CLI flags, so a caller never has to
#       shell-quote free-text card content.
#   gate-dispatch-check.sh selftest         -> offline self-test, no API calls, no side effects
#
# THE ONE THING AN AUTHOR CAN DO TO MAKE THIS EXACT (card f910eabd): put a line
#
#     Gate-SHA: <sha>[, <sha>...]
#
# in the REVIEW comment (a gate verdict may declare the sha it reviewed the same way). When that
# line is present it REPLACES the prose scrape for that comment: no keyword guessing, no card-id
# collisions, no "does this hex token mean a commit". Everything below is heuristics reading prose,
# and prose has produced four documented false-positive classes here; one declared line removes the
# guesswork for the comment that carries it. It is OPTIONAL and stays optional -- no line means the
# old heuristics run unchanged, which is what every card written before this convention relies on.
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

# DONE/ARCHIVED (Cybersec, card d6aa0135): `check` never asked the card its OWN status, only its
# comments -- so a card that already landed is indistinguishable from one still waiting, and a
# landing merge sha newer than the gated verdict shas is TRUE OF EVERY LANDED CARD, so the old
# sha-difference logic below answered ALLOW:stale-verdict on it forever. Measured on the live board:
# 2 of 6 closed cards (339cd617, 31e97fe7) got exactly that false ALLOW. Checked before anything
# else, including the no-review branch, because "the card is already closed" is a stronger and more
# specific answer than "you have not commented yet". Optional env, same fail-open stance as
# GATE_LABELS/CARD_IDS: a caller (like `decide`, which takes no API call by contract) that has no
# card metadata to hand just leaves this unset and gets the pre-existing behaviour.
if os.environ.get("CARD_STATUS", "") == "done" or os.environ.get("CARD_ARCHIVED", ""):
    print("ADVISE-SKIP:done-or-archived"); sys.exit(0)

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

# STRUCTURED FIELD (card f910eabd). Everything below this line is heuristics reading prose, and the
# prose keeps winning: four documented false-positive classes on the same guesswork (REVIEW-prefix,
# intersection-vs-difference, and the one measured for this card -- a comment that names the SAME
# already-gated sha plus one stray hex token, which the difference rule reads as new work). The
# stray token is usually a SIBLING CARD ID, and the card-id filter cannot close that: the board
# listing truncates done cards, so CARD_IDS is partial by construction.
#
# So an author may say it outright: a line `Gate-SHA: <sha>[ <sha>...]` names exactly what is being
# submitted, and when it is present it REPLACES the scrape for that comment -- no card-id
# subtraction either, because an explicit value needs no guessing about what its author meant.
# Verdicts may carry the same line for the sha they reviewed; the comparison is symmetric.
#
# LINE-ANCHORED, like review_rx and for the same measured reason: a gate quoting the convention in
# prose ("the Gate-SHA: 1234abc named in that review is stale") must not arm anything. Anchoring is
# what makes a mention cheap to write about. (No apostrophes in this block on purpose -- the whole
# program is a single-quoted bash argument, and one apostrophe ends it mid-regex.)
#
# QUOTING IS THE WHOLE POINT, AND THE FIRST CUT GOT IT WRONG (Cybered NO-GO on 25c0c64). That regex
# copied review_rx-s prefix class, which EXPLICITLY allows `>` -- the markdown quote marker, i.e.
# the one character whose exclusion was the goal -- and its leading `\s*` also let an indented or
# fenced quote through. Three natural quote forms armed:
#     "> Gate-SHA: 1234abcd"  |  "    Gate-SHA: 1234abcd"  |  a ```-fenced block containing the line
# Since a declared line is a SUBMISSION SIGNAL on its own, that let a gate manufacture a phantom
# submission by quoting a review inside its own verdict -- the b60835e1 shape, one level up. So:
# fenced blocks are removed before matching, and the line must start at column 0 with at most a
# list/heading marker. A stricter match fails into the OLD heuristics (the field simply does not
# count), which is the same fail-open direction the rest of this script takes.
#
# MIGRATION IS THE DEFAULT, NOT A PHASE: no field -> the old heuristics run unchanged, so a card
# written before this convention (i.e. every card today) behaves exactly as it did. Fail-open, same
# stance as the rest of this script.
gate_sha_rx = re.compile(r"^(?:[-*#]+[ \t]*)?Gate-SHA:[ \t]*([0-9a-fA-F]{7,40}(?:[ \t]*[, ][ \t]*[0-9a-fA-F]{7,40})*)", re.M | re.I)
fence_rx = re.compile(r"(```|~~~).*?(\1|\Z)", re.S)

def structured_shas(text):
    out = set()
    for m in gate_sha_rx.finditer(fence_rx.sub("", text or "")):
        out |= {s.lower() for s in re.findall(r"[0-9a-fA-F]{7,40}", m.group(1))}
    return out

# CARD-ID COLLISION (real incident, fef84e46/63c4b270, 2026-08-13): kanban card ids are the SAME
# hex-lookalike shape as a git short-sha, and a card almost always mentions its OWN id somewhere
# in a comment (title echo, kartya <id>, or a branch name like fix/foo-<cardId>). That id then
# gets extracted as a sha on BOTH sides and trivially overlaps itself, producing a false
# ADVISE-SKIP:already-gated that HIDES a genuinely unreviewed new commit. Strip the card own id
# (env CID, optional -- callers that cannot supply it just skip this filter, fail-open) before
# comparing.
#
# OTHER CARDS ids too (card b60835e1). Stripping only the own id was not enough once a sha in ANY
# comment could arm a gate: measured on the live board, the extra dispatches came almost entirely
# from SIBLING card ids being read as commits -- one E2E sweep comment named eight sibling cards and
# armed all four gates on a card with no submission at all. Every real commit in the two incidents
# this card is about (415967c0, ac792b3b, 66f36444, 04ad1760) is NOT a card id, and every noise
# trigger except one WAS, so the discriminator is clean. Env CARD_IDS, comma-separated, optional and
# fail-open like CID: a caller that cannot supply the board just gets the old behaviour. The board
# listing truncates done cards, so this set is partial by nature -- an unknown id stays a sha, which
# is the loud direction. Accepted collision: an 8-hex short-sha that IS some card id gets dropped;
# with a few hundred ids that is a ~1e-7 chance per token, against a measured, recurring noise class.
_cid = (os.environ.get("CID") or "").lower()
_card_ids = {i.strip().lower() for i in (os.environ.get("CARD_IDS") or "").split(",") if i.strip()}
if _cid:
    _card_ids.add(_cid)
def extract_shas(text):
    found = {m.group(0).lower() for m in re.finditer(r"\b[0-9a-fA-F]{7,40}\b", text or "")
             if re.search(r"[a-fA-F]", m.group(0))}
    return found - _card_ids

def shas_of(comment):
    """The shas a comment is ABOUT: its declared ones if it declares any, else the scrape."""
    text = comment.get("content") or ""
    return structured_shas(text) or extract_shas(text)

GATE_AGENTS = ("qa", "qa2", "cybersec", "cybered")
# Who cannot be SUBMITTING work: the gates themselves (their verdicts are the other side of this
# question), the orchestrator, and the mechanical pre-triage tool (which quotes the sha it ran
# against and would otherwise re-arm every gate by itself).
NON_SUBMITTERS = set(GATE_AGENTS) | {"mikrob", "gate-pretriage"}

# WHAT COUNTS AS A SUBMISSION (card b60835e1; incidents beeb6963 and 339cd617). The line-anchored
# REVIEW prefix was the ONLY signal, and build agents do not always write it: real announcements
# read "JAVITVA -- commit ac792b3b" and "CYBERED NO-GO JAVITVA. Uj commit 66f36444". Measured on the
# real comment history of both cards, with the card truncated to the moment of the incident, the
# miss ran in the DANGEROUS direction on four (card, agent) pairs -- 339cd617/cybered and
# 339cd617/qa, beeb6963/cybered and beeb6963/qa2 all returned ADVISE-SKIP:already-gated while a
# fresh commit fixing that very gate own finding was sitting on the card unreviewed. (The card
# text predicted the harmless direction for beeb6963; the measurement says otherwise.)
#
# So an engineering-role comment that NAMES A COMMIT also counts as a submission, whatever it opens
# with. Newness is deliberately NOT decided here -- the sha-difference rule further down already
# owns that question, and duplicating it in the classifier is how the two answers drift apart.
#
# Direction of the remaining error: a build agent who mentions a sha in passing now re-arms the
# gate. That is a cheap, self-correcting false positive (a gate looks, sees nothing new, moves on),
# and the whole point of this card is that the opposite error is silent.
def is_submission(c):
    author = (c.get("author") or "").lower()
    if author == agent.lower():
        return False
    text = c.get("content") or ""
    # A declared Gate-SHA IS the submission signal (card f910eabd): whoever writes that line is
    # naming a commit for a gate to look at, which is the whole definition. Checked before the
    # prose rules because it is the only one that cannot be triggered by quoting.
    if structured_shas(text):
        return True
    if review_rx.search(text):
        return True
    if author in NON_SUBMITTERS:
        return False
    return bool(extract_shas(text))

review_comments = [c for c in cs if is_submission(c)]

# NO REVIEW AT ALL -> there is nothing submitted for this gate to answer. A waiting card without a
# submission is parked for some other reason (a bound block, a question to MikroB), and treating it
# as gate work is what woke four gate agents for 53 blocked cards every nudger run (card 14acfadd).
# Checked BEFORE the verdict question on purpose: "nobody submitted anything" is a different and
# stronger answer than "you have not commented yet".
if not review_comments:
    print("ADVISE-SKIP:no-review"); sys.exit(0)

def widen_qa(names):
    return names | {"qa", "qa2"} if ("qa" in names or "qa2" in names) else names

def designated_from_labels(csv):
    names = {n.strip().lstrip("@").lower() for n in csv.split(",") if n.strip()}
    names = {n for n in names if n in GATE_AGENTS}
    return widen_qa(names) if names else None

def designated_from_gate_line(text):
    # DESIGNATION vs EXPLANATION (card 55af560d): a name-scan over the WHOLE line reads the
    # explanatory parenthetical too, so a card that EXCLUDES a gate by NAMING it in its own
    # exclusion reasoning -- "QA + Cybersec (... trust boundary, ezert Cybersec, nem Cybered)."
    # -- woke the excluded gate anyway, because "Cybered" appears in the text. Measured on two
    # live cards (241532d8, 35533cca): both name the excluded gate BY NAME while excluding it,
    # which is the more carefully a card documents its own exclusion, the more certainly this
    # bug wakes the gate it just excluded.
    #
    # The fix scans only the OWN designation clause of the gate line -- everything before the first "("
    # or sentence-ending punctuation (. ! ?) -- not the whole line. A negation-word list
    # ("nem", "not", "kimarad", ...) was considered and rejected: that is the same
    # never-complete-vocabulary trap this fleet has hit before in other guards (see
    # security-qualifier-vocab-lists-recur-incomplete), and it would need to grow every time a
    # new phrasing appeared. Clause position is structural, not vocabulary, so it does not rot.
    clause_end = re.search(r"[.(!?]", text)
    clause = text[: clause_end.start()] if clause_end else text
    low = clause.lower()
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

mine = [c for c in cs if (c.get("author") or "").lower() == agent.lower()]

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
    mine = mine + [c for c in cs if (c.get("author") or "").lower() == "qa" and qa_pass_rx.search(c.get("content") or "")]
if not mine:
    print("ALLOW:no-verdict"); sys.exit(0)

last_mine = max(ts(c) for c in mine)
last_review = max(ts(c) for c in review_comments)

# SHA CHECK (card 011b3f89, real incident 25083c6f): a REVIEW that merely re-describes the SAME
# commit the verdict already covers is not new work, no matter which comment is timestamped
# later -- the pure timestamp comparison below produced a false ALLOW:stale-verdict on 25083c6f
# (Cybered GO at 596f0f15, then a later REVIEW comment that re-described that SAME 596f0f15 in
# more detail, not a new commit). Compare the short-sha(s) named in the newest REVIEW against the
# short-sha(s) named in the newest verdict; only fall back to the timestamp rule when at least one
# side names no sha at all (fail-open, same stance as the rest of this script).
newest_mine = max(mine, key=ts)
newest_review = max(review_comments, key=ts)
mine_shas = shas_of(newest_mine)
review_shas = shas_of(newest_review)

# INTERSECTION vs DIFFERENCE (Cybersec, real incident 36d559e5/974509e3, 2026-08-13): the prior
# check asked "does the REVIEW overlap the verdict shas at all" -- but a REVIEW naming BOTH a
# genuinely new sha AND a superseded one (e.g. "974509e3 supersedes 6fd834e2/91a22169, do not
# gate those separately", which is the RIGHT thing for an author to write) still overlaps, so the
# whole REVIEW was skipped as already-gated and the new sha was never reviewed. The correct
# question is whether the REVIEW names at least one sha the verdict does NOT cover.
# ORDER FIRST (Cybersec, card d9ce20f5): the sha branch below used to sit here and exit before this
# comparison could run, so ANY review naming shas the verdict does not cover re-armed the card --
# including a review written DAYS BEFORE the verdict. Measured blast radius: 26 (agent, card) pairs on
# 10 waiting cards, e.g. 339cd617/cybersec where the REVIEW predates the verdict by 95 hours and still
# produced ALLOW:stale-verdict. Fail-open in the cheap direction (wasted gate rework, quota burn), but
# real. A review that predates the verdict is stale by definition: the verdict is the newest word about
# it, whatever shas it happens to mention.
#
# TIE-BREAK: `<`, so an EQUAL timestamp falls through and can re-arm (Cybered, before this landed).
# My first cut used `<=` on the reasoning that fewer re-arms is the point of this card. That optimised
# the wrong axis. The point is no FALSE re-arms; a tie is not a false re-arm, it is an UNKNOWN -- and on
# an unknown the two error directions are not equal. A spurious re-arm is cheap and self-correcting: a
# gate looks, sees nothing new, moves on. A missed gate is SILENT, which is the exact failure this card
# exists to remove. The measured 26-pair problem contains no tie at all, so `<` costs nothing there.
if last_review < last_mine:
    print(f"ADVISE-SKIP:already-gated:{int(last_mine)}")
    sys.exit(0)

# A SILENCED WAKE MUST NOT LOOK LIKE A QUIET ONE (Cybersec HIGH, reproduced by QA2, card f910eabd).
# The declared field overrides the prose scrape -- that is the point, and in the noise direction it
# only costs tokens. In the OTHER direction it costs a review: a STALE Gate-SHA header, copied from
# the previous comment (the likeliest real mistake, since the convention asks for the line on every
# REVIEW), makes a comment whose PROSE announces a new fix look already-gated. Measured:
#     verdict "NO-GO @ ac792b3b", then "REVIEW -- the HIGH is fixed, new commit 974509e3"
#     without the line -> ALLOW:stale-verdict     with a stale "Gate-SHA: ac792b3b" -> ADVISE-SKIP
# So the answer says WHICH of the two it is. The verdict stays a skip (this is an advisory cost
# guard, and turning the declaration into an arming signal would just re-open the sibling-card-id
# class the field exists to close) -- but a distinguishable label means a sweep can audit exactly
# the cases where a declaration, and nothing else, kept a gate away from an open finding.
#
# The counterfactual mirrors the real rule instead of restating it: what would this same code have
# answered if neither comment carried a declaration? Both sides are checked, because a stale
# declaration on the VERDICT can swallow a review just as well as one on the review.
def without_declaration_lines(text):
    """The comment as it would read if its declaration had never been written.

    Naively scraping the raw text is NOT that world: extract_shas also sees the sha INSIDE the
    `Gate-SHA:` line, so a stale declaration on the verdict side quietly re-entered the
    counterfactual through the very line under test and hid its own silencing. Fence state is
    tracked so a quoted line -- which was never a declaration -- keeps contributing its shas.
    """
    out, fenced = [], False
    for line in (text or "").split("\n"):
        stripped = line.lstrip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            fenced = not fenced
            out.append(line)
            continue
        if not fenced and gate_sha_rx.match(line):
            continue
        out.append(line)
    return "\n".join(out)

mine_prose = extract_shas(without_declaration_lines(newest_mine.get("content") or ""))
review_prose = extract_shas(without_declaration_lines(newest_review.get("content") or ""))
declared = bool(structured_shas(newest_mine.get("content") or "")
                or structured_shas(newest_review.get("content") or ""))

def prose_would_arm():
    if not (mine_prose and review_prose):
        return True  # the rule below falls through to ALLOW when either side names nothing
    return bool({s for s in review_prose if not any(s.startswith(v) or v.startswith(s) for v in mine_prose)})

# From here the review IS newer than the verdict, so the only question left is whether it says anything
# the verdict has not already covered -- which is exactly what the sha difference answers.
if mine_shas and review_shas:
    new_shas = {s for s in review_shas if not any(s.startswith(v) or v.startswith(s) for v in mine_shas)}
    if new_shas:
        print("ALLOW:stale-verdict")
    elif declared and prose_would_arm():
        print(f"ADVISE-SKIP:already-gated-by-declaration:{int(last_mine)}")
    else:
        print(f"ADVISE-SKIP:already-gated:{int(last_mine)}")
    sys.exit(0)

print("ALLOW:stale-verdict")
'
}

# Extracts a card's own kanban labels, comma-joined, from a bulk /api/kanban JSON array on stdin.
# Kept as its own function (mirroring _decide) so selftest can exercise the SAME code the live
# `check` path uses.
_extract_gate_labels() { # $1 = cardId, stdin = /api/kanban JSON array
  CID="$1" python3 -c '
import json, os, sys
try: cards = json.load(sys.stdin)
except Exception: sys.exit(0)
for c in cards if isinstance(cards, list) else []:
    if c.get("id") == os.environ["CID"]:
        print(",".join(l.get("name", "").lstrip("@") for l in (c.get("labels") or [])))
        break
'
}

# Extracts a card's free-text "Gate: ..." line from its description, from the SAME bulk JSON.
# findall() + the LAST match, not search()'s first: a description can carry more than one
# "Gate: ..." line (an earlier tier decision superseded by a later one, appended rather than
# edited in place -- card 84fd2839, Cybered's finding on 5bc10089). The newest line is the live
# decision; taking the first would let a stale, since-overridden Gate: line keep winning forever.
#
# NO LINE-START ANCHOR (card 165ff1af, 2026-08-13): the regex used to require "Gate:" at the
# start of a line (`^\s*Gate\s*:`). Real card 165ff1af writes it mid-paragraph -- "...MemoryRouter
# routing context. Gate: QA. (funkcionalis lefedettseg...)" -- with a plain space before "Gate:",
# not a newline. The anchored regex silently matched nothing, GATE_LINE came back empty, and
# Cybersec (correctly excluded by a QA-only card) got nudged 8 times before anyone noticed. Now
# matches "Gate:" anywhere via a word boundary (`\bGate\s*:`), so placement within a sentence no
# longer defeats extraction.
_extract_gate_line() { # $1 = cardId, stdin = /api/kanban JSON array
  CID="$1" python3 -c '
import json, os, re, sys
try: cards = json.load(sys.stdin)
except Exception: sys.exit(0)
rx = re.compile(r"\bGate\s*:\s*(.+)$", re.M | re.I)
for c in cards if isinstance(cards, list) else []:
    if c.get("id") == os.environ["CID"]:
        matches = rx.findall(c.get("description") or "")
        if matches: print(matches[-1])
        break
'
}

# Extracts a card's own status + archived-at flag, tab-separated, from the SAME bulk JSON already
# fetched for GATE_LABELS/GATE_LINE (card d6aa0135) -- there is no single-card GET, and the bulk
# list already truncates DONE cards (kanban-api-truncates-done-not-open), so this is best-effort:
# a card that fell out of the truncated window is not found and this stays empty, same fail-open
# direction as every other lookup here. It still catches the measured real cases (both were present
# in the bulk response), which is strictly better than the zero coverage before this.
_extract_status() { # $1 = cardId, stdin = /api/kanban JSON array
  CID="$1" python3 -c '
import json, os, sys
try: cards = json.load(sys.stdin)
except Exception: sys.exit(0)
for c in cards if isinstance(cards, list) else []:
    if c.get("id") == os.environ["CID"]:
        print("%s\t%s" % (c.get("status") or "", "1" if c.get("archived_at") else ""))
        break
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
    GATE_LABELS="$(_extract_gate_labels "$CARD" <<< "$CARD_JSON" 2>/dev/null || true)"
    GATE_LINE="$(_extract_gate_line "$CARD" <<< "$CARD_JSON" 2>/dev/null || true)"
    # DONE/ARCHIVED (card d6aa0135): same bulk JSON, same fail-open stance -- a lookup miss (the
    # card fell out of the truncated done-card window) just leaves both empty.
    CARD_STATUS_LINE="$(_extract_status "$CARD" <<< "$CARD_JSON" 2>/dev/null || true)"
    CARD_STATUS="${CARD_STATUS_LINE%%$'\t'*}"
    CARD_ARCHIVED="${CARD_STATUS_LINE#*$'\t'}"
    # Every card id on the board, so sibling ids quoted in a comment are not read as commits
    # (card b60835e1). Same bulk JSON already in hand; failure leaves it empty (fail OPEN).
    CARD_IDS="$(printf '%s' "$CARD_JSON" | python3 -c '
import json, sys
try: cards = json.load(sys.stdin)
except Exception: sys.exit(0)
print(",".join(c.get("id") or "" for c in cards if isinstance(c, dict)))
' 2>/dev/null || true)"
    verdict="$(printf '%s' "$body" | GATE_LABELS="$GATE_LABELS" GATE_LINE="$GATE_LINE" CID="$CARD" CARD_IDS="$CARD_IDS" CARD_STATUS="$CARD_STATUS" CARD_ARCHIVED="$CARD_ARCHIVED" _decide "$AGENT" || echo ALLOW)"
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
    # PREFIX matching, which is fine until two verdicts SHARE a prefix -- and since card f910eabd
    # two do: "already-gated" is a prefix of "already-gated-by-declaration", so a case expecting the
    # plain one passes on either. `tno` is the other half: assert a verdict does NOT start with a
    # prefix, so the two answers can actually be told apart in a test.
    tno() { # $1 = label, $2 = FORBIDDEN prefix, $3 = agent, stdin = comments json
      local got; got="$(_decide "$3")"
      if [[ "$got" != "$2"* ]]; then echo "  ok   $1 -> $got"
      else echo "  FAIL $1 -> got '$got', which must NOT start with '$2'"; fail=1; fi
    }
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
    # --- Gate-SHA: the declared field beats the prose scrape (card f910eabd) ------------------
    # THE MEASURED CASE. A comment newer than the verdict that names the SAME already-gated sha
    # plus ONE stray hex token (here a sibling card id) -- the difference rule reads the stray as
    # new work and wakes the gate for nothing. The card-id filter cannot close this: the board
    # listing truncates done cards, so CARD_IDS is partial by construction. The pair below is the
    # point of the card: identical text, one line added.
    t "stray hex token re-arms without the field" "ALLOW:stale-verdict" cybered <<< '[{"author":"backend2","created_at":100,"content":"REVIEW -- kesz, commit ac792b3b"},{"author":"cybered","created_at":200,"content":"CYBERED GO -- @ ac792b3b"},{"author":"backend2","created_at":300,"content":"Valasz: az ac792b3b valtozatlan, a testver-kartya 63c4b270 mar landolt."}]'
    t "declared Gate-SHA suppresses it"           "ADVISE-SKIP:already-gated" cybered <<< '[{"author":"backend2","created_at":100,"content":"REVIEW -- kesz, commit ac792b3b"},{"author":"cybered","created_at":200,"content":"CYBERED GO -- @ ac792b3b"},{"author":"backend2","created_at":300,"content":"Gate-SHA: ac792b3b\nValasz: az ac792b3b valtozatlan, a testver-kartya 63c4b270 mar landolt."}]'
    # NO REGRESSION of the difference rule (cards e76c1b7e/2737207): a review that supersedes older
    # shas still re-arms, and now says so exactly instead of being inferred from the sentence.
    t "declared NEW sha still re-arms"            "ALLOW:stale-verdict" cybersec <<< '[{"author":"backend","created_at":100,"content":"REVIEW -- 6fd834e2"},{"author":"cybersec","created_at":200,"content":"NO-GO @ 6fd834e2"},{"author":"backend","created_at":300,"content":"Gate-SHA: 974509e3\nREVIEW -- 974509e3 supersedes 6fd834e2/91a22169."}]'
    # ANCHORING is what makes the convention safe to talk about: a gate quoting it mid-sentence
    # must not arm anything -- the same failure shape as the quoted REVIEW word (card b60835e1).
    t "quoted Gate-SHA mid-line does not arm"     "ADVISE-SKIP:already-gated" cybersec <<< '[{"author":"backend","created_at":100,"content":"REVIEW -- ac792b3b"},{"author":"cybersec","created_at":200,"content":"GO @ ac792b3b"},{"author":"cybered","created_at":300,"content":"Megjegyzes: a review-bol hianyzik a Gate-SHA: 1234abcd sor, kerem potolni."}]'
    # The field is a submission signal on its own -- an author who declares a sha has submitted it,
    # whatever the comment opens with (the "JAVITVA -- commit X" shape that b60835e1 measured).
    t "Gate-SHA alone counts as a submission"     "ALLOW:no-verdict" cybersec <<< '[{"author":"backend2","created_at":100,"content":"Gate-SHA: ac792b3b\nJAVITVA, ugyanaz az ag."}]'
    # SYMMETRIC: a verdict may declare what it reviewed, and that side is read the same way. Here
    # the verdict declares the new sha, so the later review naming it is NOT new work.
    t "verdict declares what it gated"            "ADVISE-SKIP:already-gated" cybersec <<< '[{"author":"backend","created_at":100,"content":"REVIEW -- 6fd834e2"},{"author":"cybersec","created_at":300,"content":"Gate-SHA: 974509e3\nCYBERSEC GO"},{"author":"backend","created_at":200,"content":"REVIEW -- 974509e3"}]'
    # MIGRATION IS THE DEFAULT: without the field, every pre-convention card behaves exactly as
    # before. Pinned so a later "cleanup" cannot make the field mandatory by accident.
    t "no field at all -> old behaviour"          "ADVISE-SKIP:already-gated" cybersec <<< '[{"author":"backend","created_at":100,"content":"REVIEW -- ac792b3b"},{"author":"cybersec","created_at":200,"content":"GO @ ac792b3b"}]'
    # SILENCED vs QUIET (Cybersec HIGH on 780f024, reproduced by QA2). A stale Gate-SHA header --
    # the likeliest real mistake, since the convention asks for the line on every REVIEW -- can make
    # a comment whose PROSE announces a new fix look already-gated. The verdict stays a skip, but it
    # SAYS that a declaration is what silenced it, so a sweep can audit exactly those cases.
    #
    # The pair is the test: identical text, one line added. Without the line the same input arms.
    t "stale declaration is a VISIBLE silencing"  "ADVISE-SKIP:already-gated-by-declaration" cybersec <<< '[{"author":"cybersec","created_at":100,"content":"CYBERSEC NO-GO @ac792b3b -- one HIGH open"},{"author":"backend","created_at":200,"content":"Gate-SHA: ac792b3b\nREVIEW -- the HIGH is fixed, new commit 974509e3 pushed."}]'
    t "...and without the line the same text arms" "ALLOW:stale-verdict" cybersec <<< '[{"author":"cybersec","created_at":100,"content":"CYBERSEC NO-GO @ac792b3b -- one HIGH open"},{"author":"backend","created_at":200,"content":"REVIEW -- the HIGH is fixed, new commit 974509e3 pushed."}]'
    # SYMMETRIC: a stale declaration on the VERDICT swallows a review just as well as one on the
    # review, so the counterfactual checks both sides.
    t "stale declaration on the VERDICT side too"  "ADVISE-SKIP:already-gated-by-declaration" cybersec <<< '[{"author":"cybersec","created_at":100,"content":"Gate-SHA: 974509e3\nCYBERSEC NO-GO @ac792b3b"},{"author":"backend","created_at":200,"content":"REVIEW -- fixed in 974509e3"}]'
    # An HONEST skip must keep the plain label -- otherwise the new one means nothing. `tno` because
    # "already-gated" is a PREFIX of "already-gated-by-declaration": a plain prefix assertion here
    # would pass on either answer and prove nothing.
    tno "an honest skip is NOT labelled a silencing" "ADVISE-SKIP:already-gated-by-declaration" cybered <<< '[{"author":"backend2","created_at":100,"content":"REVIEW -- ac792b3b"},{"author":"cybered","created_at":200,"content":"CYBERED GO -- @ ac792b3b"},{"author":"backend2","created_at":300,"content":"Gate-SHA: ac792b3b\nAnswer to the question: ac792b3b is unchanged."}]'
    # The measured coincidence of this card (a stray sibling-card id) IS a silencing by declaration --
    # a correct one, and now an auditable one. Same verdict family as the stale-header case, which is
    # the honest reading: the declaration, and nothing else, kept the gate away.
    t "the stray-token case is auditable too"     "ADVISE-SKIP:already-gated-by-declaration" cybered <<< '[{"author":"backend2","created_at":100,"content":"REVIEW -- kesz, commit ac792b3b"},{"author":"cybered","created_at":200,"content":"CYBERED GO -- @ ac792b3b"},{"author":"backend2","created_at":300,"content":"Gate-SHA: ac792b3b\nValasz: valtozatlan, a testver 63c4b270 landolt."}]'

    # QUOTE FORMS (Cybered NO-GO on 25c0c64). The first cut reused review_rx-s prefix class, which
    # allows `>` -- the markdown quote marker, the one character that had to be excluded -- and its
    # leading \s* also passed indented and fenced quotes. Each of the three forms Cybered measured
    # gets its own case, because a declared line is a submission signal on its own: a gate quoting a
    # review inside its own verdict could otherwise manufacture a phantom submission.
    t "markdown-quoted Gate-SHA does not arm"     "ADVISE-SKIP:already-gated" cybersec <<< '[{"author":"backend","created_at":100,"content":"REVIEW -- ac792b3b"},{"author":"cybersec","created_at":200,"content":"GO @ ac792b3b"},{"author":"cybered","created_at":300,"content":"Idezem a reviewt:\n> Gate-SHA: 1234abcd\nennyi volt."}]'
    t "indented Gate-SHA does not arm"            "ADVISE-SKIP:already-gated" cybersec <<< '[{"author":"backend","created_at":100,"content":"REVIEW -- ac792b3b"},{"author":"cybersec","created_at":200,"content":"GO @ ac792b3b"},{"author":"cybered","created_at":300,"content":"Idezem a reviewt:\n    Gate-SHA: 1234abcd\nennyi volt."}]'
    t "fenced Gate-SHA does not arm"              "ADVISE-SKIP:already-gated" cybersec <<< '[{"author":"backend","created_at":100,"content":"REVIEW -- ac792b3b"},{"author":"cybersec","created_at":200,"content":"GO @ ac792b3b"},{"author":"cybered","created_at":300,"content":"Idezem:\n```\nGate-SHA: 1234abcd\n```\nennyi volt."}]'
    # An UNCLOSED fence must swallow to the end too -- a truncated paste is the likeliest real form.
    t "unclosed fence swallows the line"          "ADVISE-SKIP:already-gated" cybersec <<< '[{"author":"backend","created_at":100,"content":"REVIEW -- ac792b3b"},{"author":"cybersec","created_at":200,"content":"GO @ ac792b3b"},{"author":"cybered","created_at":300,"content":"Pelda:\n```\nGate-SHA: 1234abcd"}]'
    # ...and the stricter match must not swallow a REAL declaration that follows a quoted one.
    t "quoted then really declared -> arms"       "ALLOW:stale-verdict" cybersec <<< '[{"author":"backend","created_at":100,"content":"REVIEW -- 6fd834e2"},{"author":"cybersec","created_at":200,"content":"NO-GO @ 6fd834e2"},{"author":"backend","created_at":300,"content":"A regi sor:\n```\nGate-SHA: 6fd834e2\n```\nAz uj:\nGate-SHA: 974509e3"}]'
    # A list marker is formatting, not quoting: a bulleted declaration still counts.
    t "list-marker declaration still arms"        "ADVISE-SKIP:already-gated" cybered <<< '[{"author":"backend2","created_at":100,"content":"REVIEW -- ac792b3b"},{"author":"cybered","created_at":200,"content":"CYBERED GO -- @ ac792b3b"},{"author":"backend2","created_at":300,"content":"- Gate-SHA: ac792b3b\nValasz: valtozatlan, a testver 63c4b270 landolt."}]'
    # Multiple shas on one line (a review that submits two commits together).
    t "two declared shas, one still new"          "ALLOW:stale-verdict" cybersec <<< '[{"author":"backend","created_at":100,"content":"REVIEW -- 6fd834e2"},{"author":"cybersec","created_at":200,"content":"Gate-SHA: 6fd834e2\nNO-GO"},{"author":"backend","created_at":300,"content":"Gate-SHA: 6fd834e2, 974509e3\nREVIEW -- fix + follow-up."}]'
    t "malformed json"                "ALLOW"              cybersec <<< 'not json'
    t "object-wrapped comments"       "ADVISE-SKIP:already-gated" cybersec <<< '{"comments":[{"author":"backend","created_at":100,"content":"REVIEW"},{"author":"cybersec","created_at":200,"content":"GO"}]}'
    # ts() robustness: a comment with no created_at must not crash the max(). Needs a REVIEW present
    # now, otherwise the no-review branch answers first and the ts() path is never reached.
    # Expectation FLIPPED with the tie-break change (card d9ce20f5, Cybered): with no timestamps at all
    # both sides read equal, which is a tie -- and a tie now takes the LOUD direction. That is the same
    # reasoning applied to its most extreme case: if an equal pair of real timestamps is an unknown
    # ordering, an ABSENT pair is maximally unknown, and a cheap re-arm beats a silent skip. Measured
    # before flipping it: the live API returned created_at on 48/48 comments across two cards, so this
    # case is defensive-only and the extra re-arm costs nothing in practice.
    t "missing created_at -> tie -> re-arm" "ALLOW:stale-verdict" cybersec <<< '[{"author":"backend","content":"REVIEW"},{"author":"cybersec","content":"GO"}]'
    # Anchoring: a later comment that only MENTIONS the word must not re-arm the dispatch.
    t "later peer QUOTES the word"    "ADVISE-SKIP:already-gated" cybersec <<< '[{"author":"backend","created_at":100,"content":"REVIEW"},{"author":"cybersec","created_at":200,"content":"GO"},{"author":"mikrob","created_at":300,"content":"bontsd fel, a te REVIEW-od utan nyitom a gyerekkartyat"}]'
    t "later peer SUBMITS a review"   "ALLOW:stale-verdict" cybersec <<< '[{"author":"cybersec","created_at":200,"content":"GO"},{"author":"backend","created_at":300,"content":"REVIEW -- kesz, commit abc1234"}]'
    t "submission behind a md bullet" "ALLOW:stale-verdict" cybersec <<< '[{"author":"cybersec","created_at":200,"content":"GO"},{"author":"backend","created_at":300,"content":"## REVIEW\nkesz"}]'
    # SHA CHECK (card 011b3f89). The real 25083c6f incident: Cybered's GO named 596f0f15
    # (comment 8825, ts 1786108474); backend's LATER REVIEW (comment 9999, ts 1786140913) just
    # re-described that SAME commit in more detail, not a new one -- the pure timestamp rule alone
    # would say ALLOW:stale-verdict here (last_review > last_mine), which is the false positive this
    # card fixes.
    t "25083c6f real incident: later REVIEW repeats the SAME sha" "ADVISE-SKIP:already-gated" cybered <<< '[{"author":"cybered","created_at":1786108474,"content":"CYBERED GO -- 25083c6f @ `596f0f15`. Es lezarom a CustodyAuthzError-vitat."},{"author":"backend","created_at":1786140913,"content":"REVIEW -- RESZLEGES TELJESITES, MikroB dontese szerint. Ag fix/error-mapping-25083c6f, 2 commit, pusholva. Az 5 lekepezes kesz (596f0f15)."}]'
    # Contrast case: a REVIEW naming a DIFFERENT sha is genuinely new work -- must still re-arm.
    t "a REVIEW naming a DIFFERENT sha still re-arms" "ALLOW:stale-verdict" cybered <<< '[{"author":"cybered","created_at":100,"content":"GO -- 596f0f15"},{"author":"backend","created_at":200,"content":"REVIEW -- new fix, commit a1b2c3d4"}]'

    # Card d9ce20f5: the case the sha branch answered WRONG while it ran first. Same shape as the test
    # directly above -- review names a sha the verdict does not cover -- but the review is OLDER. It must
    # NOT re-arm: the verdict came after it and is the newest word. Mutation check: putting the sha
    # branch back ahead of the order check turns this red and leaves the three above green, which is
    # precisely why the earlier controls did not catch the regression.
    t "an OLDER review naming a different sha does NOT re-arm" "ADVISE-SKIP:already-gated" cybered <<< '[{"author":"backend","created_at":100,"content":"REVIEW -- older submission, commit a1b2c3d4"},{"author":"cybered","created_at":200,"content":"GO -- 596f0f15"}]'
    # The 95-hour real pair from the incident, in the shape the measurement found it.
    t "339cd617 real pair: REVIEW 95h older than the verdict" "ADVISE-SKIP:already-gated" cybersec <<< '[{"author":"backend","created_at":1786000000,"content":"REVIEW -- kesz, commit 11aa22bb"},{"author":"cybersec","created_at":1786342000,"content":"CYBERSEC GO -- 339cd617 @ 596f0f15"}]'
    # Pins the tie-break itself (Cybered): SAME timestamp, review names a sha the verdict does not
    # cover -> it must RE-ARM, not skip. With `<=` this returns ADVISE-SKIP and a gate silently never
    # looks; the loud direction is the safe one when the ordering is genuinely unknown.
    t "equal timestamps re-arm rather than skip silently" "ALLOW:stale-verdict" cybered <<< '[{"author":"cybered","created_at":500,"content":"GO -- 596f0f15"},{"author":"backend","created_at":500,"content":"REVIEW -- new fix, commit a1b2c3d4"}]'
    # Short-shas for the same commit can differ in length (7 vs 8+ hex chars) -- prefix match, not
    # exact-string match, so this must NOT re-arm either.
    t "same commit, different short-sha LENGTH still matches" "ADVISE-SKIP:already-gated" cybered <<< '[{"author":"cybered","created_at":100,"content":"GO -- 596f0f1"},{"author":"backend","created_at":200,"content":"REVIEW -- same fix, commit 596f0f15"}]'
    # INTERSECTION vs DIFFERENCE (Cybersec, real incident 36d559e5/974509e3, 2026-08-13). A REVIEW
    # that names BOTH a new sha AND a superseded one (the author explicitly saying "X supersedes Y,
    # do not gate Y separately") used to overlap on the superseded sha and get skipped whole -- the
    # new sha was never reviewed. Three controls: (a) review repeats only the verdict's sha -> skip;
    # (b) review adds one new sha alongside the old one -> must re-arm; (c) review names only a new
    # sha -> must re-arm (already covered above, kept here for the family).
    t "review repeats ONLY the verdict sha" "ADVISE-SKIP:already-gated" cybersec <<< '[{"author":"cybersec","created_at":100,"content":"NO-GO -- abc1111"},{"author":"backend","created_at":200,"content":"REVIEW -- same fix, commit abc1111"}]'
    t "review names verdict sha PLUS a new one -- must re-arm" "ALLOW:stale-verdict" cybersec <<< '[{"author":"cybersec","created_at":100,"content":"NO-GO -- abc1111"},{"author":"backend","created_at":200,"content":"REVIEW -- fixed, new commit def2222 supersedes abc1111, dont gate that one separately"}]'
    t "review names ONLY a new sha -- must re-arm" "ALLOW:stale-verdict" cybersec <<< '[{"author":"cybersec","created_at":100,"content":"NO-GO -- abc1111"},{"author":"backend","created_at":200,"content":"REVIEW -- fixed, commit def2222"}]'
    # No sha on either side -> unchanged, falls back to the pre-existing timestamp rule (fail-open).
    t "no sha anywhere falls back to the timestamp rule" "ALLOW:stale-verdict" cybersec <<< '[{"author":"cybersec","created_at":100,"content":"NO-GO"},{"author":"backend","created_at":200,"content":"REVIEW -- fixed, no commit mentioned"}]'

    # SUBMISSION WITHOUT THE REVIEW PREFIX (card b60835e1). Both cases are the real comment shapes,
    # and both were measured against the live comment history truncated to the moment of the
    # incident: the old rule answered ADVISE-SKIP:already-gated on all four (card, agent) pairs
    # while a fresh commit fixing that gate own finding sat on the card unreviewed. Mutation check:
    # drop the sha arm of is_submission and these two go red while every case above stays green --
    # which is exactly why 40+ existing controls did not catch this.
    t "339cd617 real shape: JAVITVA (no REVIEW prefix) names a new commit" "ALLOW:stale-verdict" cybered <<< '[{"author":"backend2","created_at":1786212647,"content":"REVIEW -- kesz, commit 415967c0, ag feat/settings-calendar-write"},{"author":"cybered","created_at":1786213071,"content":"CYBERED GO -- @ 415967c0 (backend2, settings/calendar write-oldal + RBAC-dontes)"},{"author":"backend2","created_at":1786213391,"content":"JAVITVA -- commit ac792b3b (ugyanaz az ag, origin-ra pusholva, a korabbi 415967c0 folott)"}]'
    t "beeb6963 real shape: NO-GO JAVITVA names the fix commit" "ALLOW:stale-verdict" cybered <<< '[{"author":"backend","created_at":1786168835,"content":"REVIEW: kesz. Branch feat/precommit-declared-paths, commit 04ad1760, pusholva."},{"author":"cybered","created_at":1786170631,"content":"CYBERED NO-GO -- @ 04ad1760 (a negyedik megkerulesi ut nyitva)"},{"author":"backend","created_at":1786177051,"content":"CYBERED NO-GO JAVITVA. Uj commit 66f36444 a tipjen (a 04ad1760 folott), pusholva."}]'
    # ...and the same shape must still SKIP when the announced commit is the one already gated.
    t "a JAVITVA repeating the gated sha does NOT re-arm" "ADVISE-SKIP:already-gated" cybered <<< '[{"author":"backend","created_at":100,"content":"REVIEW -- commit 04ad1760"},{"author":"cybered","created_at":200,"content":"GO -- 04ad1760"},{"author":"backend","created_at":300,"content":"JAVITVA -- ugyanaz a commit 04ad1760, csak ujrapusholva"}]'

    # WHO CANNOT SUBMIT. Without these the widening arms every gate off its own machinery: the
    # pre-triage tool quotes the sha it ran against, the other gates quote it in their verdicts, and
    # MikroB quotes it when deciding the tier. All three are the SAME sha the gate would be asked
    # about, so counting them would make "no submission" impossible to ever answer.
    t "another gate naming a sha is not a submission"  "ADVISE-SKIP:no-review" cybersec <<< '[{"author":"cybered","created_at":100,"content":"CYBERED GO -- 04ad1760"}]'
    t "gate-pretriage naming a sha is not a submission" "ADVISE-SKIP:no-review" cybersec <<< '[{"author":"gate-pretriage","created_at":100,"content":"GATE PRE-TRIAGE (mechanikus, verdict:null) @ 66f36444"}]'
    t "mikrob naming a sha is not a submission"        "ADVISE-SKIP:no-review" cybersec <<< '[{"author":"mikrob","created_at":100,"content":"TIER-DONTES valtozatlan: QA + Cybered. Friss commit 66f36444."}]'
    t "an engineering comment with no sha is not a submission" "ADVISE-SKIP:no-review" cybersec <<< '[{"author":"backend","created_at":100,"content":"Kerdes MikroB-nak: melyik migracios szamot vegyem?"}]'

    # SIBLING CARD IDS (card b60835e1, measured on the live board). Card ids are the same hex shape
    # as a short sha, and cards quote each other constantly -- one real E2E sweep comment named eight
    # sibling cards and armed all four gates on a card with no submission at all. tc() is t() plus
    # CARD_IDS, which is how `check` and the nudger both call this.
    tc() { # $1 = label, $2 = expected prefix, $3 = agent, $4 = CARD_IDS, stdin = comments json
      local got; got="$(CARD_IDS="$4" _decide "$3")"
      if [[ "$got" == "$2"* ]]; then echo "  ok   $1 -> $got"
      else echo "  FAIL $1 -> got '$got', expected '$2'*"; fail=1; fi
    }
    tc "sibling card ids are not commits" "ADVISE-SKIP:no-review" cybered "564df813,ac7d5530,90ad1000" <<< '[{"author":"teszter","created_at":100,"content":"E2E Sweep kesz. Erintett kartyak: 564df813, ac7d5530, 90ad1000."}]'
    tc "a real commit alongside sibling ids still counts" "ALLOW:no-verdict" cybered "564df813,ac7d5530" <<< '[{"author":"backend2","created_at":100,"content":"JAVITVA -- commit ac792b3b (a 564df813 es ac7d5530 kartyakat is erinti)"}]'
    tc "an unknown id stays a sha (partial board, fail-open)" "ALLOW:no-verdict" cybered "564df813" <<< '[{"author":"backend2","created_at":100,"content":"JAVITVA -- commit ac792b3b"}]'

    # DONE/ARCHIVED (card d6aa0135, real incident: 339cd617/31e97fe7). The sha-difference rule below
    # answers ALLOW:stale-verdict on EVERY landed card forever -- the landing merge sha is always
    # newer than the gated verdict sha, that is what "landed" means. The card's own status must
    # short-circuit before that logic ever runs.
    tst() { # $1=label $2=expected-prefix $3=agent $4=CARD_STATUS $5=CARD_ARCHIVED, stdin=comments json
      local got; got="$(CARD_STATUS="$4" CARD_ARCHIVED="$5" _decide "$3")"
      if [[ "$got" == "$2"* ]]; then echo "  ok   $1 -> $got"
      else echo "  FAIL $1 -> got '$got', expected '$2'*"; fail=1; fi
    }
    # The exact measured shape: a REVIEW, a verdict, and a later comment about the SAME landed commit
    # -- without the status check this reads as new work forever.
    tst "339cd617-shape: a done card does not re-arm despite a newer-looking comment" "ADVISE-SKIP:done-or-archived" cybersec "done" "" <<< '[{"author":"backend","created_at":100,"content":"REVIEW -- kesz, commit 11aa22bb"},{"author":"cybersec","created_at":200,"content":"CYBERSEC GO -- @ 11aa22bb"},{"author":"backend","created_at":300,"content":"Merge commit 33cc44dd landolt."}]'
    tst "archived does not re-arm even when status alone would not say done" "ADVISE-SKIP:done-or-archived" cybersec "waiting" "1" <<< '[{"author":"backend","created_at":100,"content":"REVIEW"},{"author":"cybersec","created_at":200,"content":"GO"}]'
    tst "waiting, not archived -> unaffected" "ALLOW:stale-verdict" cybersec "waiting" "" <<< '[{"author":"cybersec","created_at":200,"content":"NO-GO"},{"author":"backend2","created_at":300,"content":"REVIEW -- fixed"}]'
    tst "empty CARD_STATUS (lookup miss, fail-open) -> unaffected" "ALLOW:stale-verdict" cybersec "" "" <<< '[{"author":"cybersec","created_at":200,"content":"NO-GO"},{"author":"backend2","created_at":300,"content":"REVIEW -- fixed"}]'
    # Checked BEFORE no-review too: a done card with no submission at all must read as
    # done-or-archived, the more specific answer, not the also-true-but-vaguer no-review.
    tst "done card with no submission -> done-or-archived, not no-review" "ADVISE-SKIP:done-or-archived" cybersec "done" "" <<< '[]'

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

    # CLAUSE-SCOPED DESIGNATION (card 55af560d): the excluded gate is named BY NAME inside its
    # own exclusion reasoning, which a whole-line scan reads as a designation. Real cases.
    SELFTEST_JSON='[{"author":"backend","created_at":100,"content":"REVIEW"}]'
    dd "designation: 241532d8-shape, excluded gate named in its own parenthetical reasoning -> still excluded" \
       "ADVISE-SKIP:not-designated" 8 cybered "" \
       "QA + Cybersec (a kartya uj UNAUTH statikus route-ot vezet be, ami fajlnevet vesz at az URL-bol -- trust boundary, ezert Cybersec, nem Cybered)."
    dd "designation: 241532d8-shape, the ACTUALLY-designated gate is unaffected" \
       "ALLOW:no-verdict" 0 cybersec "" \
       "QA + Cybersec (a kartya uj UNAUTH statikus route-ot vezet be, ami fajlnevet vesz at az URL-bol -- trust boundary, ezert Cybersec, nem Cybered)."
    dd "designation: 35533cca-shape, excluded gate named in a trailing exclusion sentence -> still excluded" \
       "ADVISE-SKIP:not-designated" 8 cybersec "" \
       "QA + Cybered (Cybered a 9f74a0da 8232-es kommentjeben EXPLICIT utokort kert magara az ELESITESRE -- a dry-run-ra kapott GO nem fedi az elo hatast). Cybersec kimarad: az elesites nem nyit uj tamadasi feluletet, a beadasi utat (POST /api/agents/<agent>/compact, panel-mutex, token headerfile-bol) mar lefedte a 9f74a0da-n."
    dd "designation: 35533cca-shape, the ACTUALLY-designated gate is unaffected" \
       "ALLOW:no-verdict" 0 cybered "" \
       "QA + Cybered (Cybered a 9f74a0da 8232-es kommentjeben EXPLICIT utokort kert magara az ELESITESRE -- a dry-run-ra kapott GO nem fedi az elo hatast). Cybersec kimarad: az elesites nem nyit uj tamadasi feluletet, a beadasi utat (POST /api/agents/<agent>/compact, panel-mutex, token headerfile-bol) mar lefedte a 9f74a0da-n."

    # GATE_LINE EXTRACTION (card 84fd2839, Cybered's finding on 5bc10089): a description can carry
    # MORE THAN ONE "Gate: ..." line -- an earlier tier decision superseded by a later one, appended
    # rather than edited in place. _extract_gate_line must return the LAST one, not the first. These
    # exercise the SAME function `check` calls against a real /api/kanban array, not a re-implementation.
    e() { # $1=label $2=expected-output $3=cardId, stdin=cards JSON array
      local got
      got="$(_extract_gate_line "$3")"
      if [[ "$got" == "$2" ]]; then echo "  ok   $1 -> '$got'"
      else echo "  FAIL $1 -> got '$got', expected '$2'"; fail=1; fi
    }
    e "single Gate: line -> that line" "QA + Cybersec" c1 <<< '[{"id":"c1","description":"intro text\nGate: QA + Cybersec\nmore text"}]'
    e "two Gate: lines -> the LAST (newest), not the first" "QA + Cybersec + Cybered (current)" c1 <<< '[{"id":"c1","description":"Gate: QA only\n\nFRISSITVE (MikroB): a scope bovult.\nGate: QA + Cybersec + Cybered (current)"}]'
    e "no Gate: line at all -> empty" "" c1 <<< '[{"id":"c1","description":"no gate line here"}]'
    e "card id not found in the array -> empty" "" c2 <<< '[{"id":"c1","description":"Gate: QA"}]'
    e "case-insensitive and indented Gate: line" "Cybered" c1 <<< '[{"id":"c1","description":"  gate:   Cybered"}]'
    # Real incident, card 165ff1af (2026-08-13): "Gate:" embedded mid-paragraph, preceded by a
    # space not a newline. A line-start-anchored regex used to miss this entirely (empty GATE_LINE
    # -> no designation exclusion -> Cybersec nudged 8x on a QA-only card).
    e "mid-paragraph Gate: (no preceding newline)" "QA. (funkcionalis lefedettseg, nincs trust-boundary erintes)" c1 <<< '[{"id":"c1","description":"MemoryRouter routing context. Gate: QA. (funkcionalis lefedettseg, nincs trust-boundary erintes)"}]'

    # _extract_status (card d6aa0135): the function `check` calls to answer "is this card already
    # done/archived", exercised directly against a real bulk /api/kanban shape.
    es() { # $1=label $2=expected-status $3=expected-archived $4=cardId, stdin=cards JSON array
      local got got_status got_archived
      got="$(_extract_status "$4")"
      got_status="${got%%$'\t'*}"; got_archived="${got#*$'\t'}"
      if [[ "$got_status" == "$2" && "$got_archived" == "$3" ]]; then
        echo "  ok   $1 -> status='$got_status' archived='$got_archived'"
      else
        echo "  FAIL $1 -> got status='$got_status' archived='$got_archived', expected status='$2' archived='$3'"; fail=1
      fi
    }
    es "a done card reports its status" "done" "" c1 <<< '[{"id":"c1","status":"done"}]'
    es "an archived card also reports archived=1" "done" "1" c1 <<< '[{"id":"c1","status":"done","archived_at":1786000000}]'
    es "a waiting card reports status, no archived flag" "waiting" "" c1 <<< '[{"id":"c1","status":"waiting"}]'
    es "card id not found in the array -> both empty (fail-open)" "" "" c2 <<< '[{"id":"c1","status":"done"}]'

    [[ $fail -eq 0 ]] && { echo "selftest: PASS"; exit 0; } || { echo "selftest: FAIL"; exit 1; }
    ;;

  *)
    echo "usage: $0 {check <cardId> <agent>|selftest}" >&2; exit 2 ;;
esac
