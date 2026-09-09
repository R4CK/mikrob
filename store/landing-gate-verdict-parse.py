#!/usr/bin/env python3
"""Read a card's comments (JSON on stdin) and say whether a gate verdict covers a given sha.

Split out of landing-gate-verdict-check.sh rather than inlined as `python3 -c`: the shell there
already pipes the API body in on stdin, and a `python3 -` heredoc would have fought that same
stdin. A file takes the program out of the argument list entirely, and makes the parser testable
without a dashboard.

Usage:  landing-gate-verdict-parse.py <sha> < comments.json
Prints exactly one line: OK|... FAILED|... UNVERIFIED-AUTHOR|... NOQA|... OTHERSHA|...
                         NONE|... UNREADABLE|...
"""
import json
import re
import sys

# WHO MAY SPEAK FOR A GATE. Shared with gate-closure-check.py rather than copied -- see that
# module for the measurements. Imported by name because both files live in store/, which is
# sys.path[0] whenever either is run as a script (and both only ever are).
from gate_author_role import author_role

# Rule 4c: the verdict word is the comment's FIRST line. Rule 4b: `Gate-SHA:` is its own line.
#
# `QA2?` -- A GATE ROLE MAY BE STAFFED BY MORE THAN ONE AGENT (card c52e2823). Rule 4 requires
# load-balancing between same-capability gate siblings (today QA/QA2), and only ONE of a pair
# reviews a given card, so a sibling's verdict IS that role's verdict. Without the digit `QA2 PASS`
# matched nothing: every card QA2 gated refused to land with the message "a security gate passed
# this sha but QA did not" -- an assertion that a verdict is absent while it sits on the card.
# Measured on 5433c74c, where all three gates had passed and the landing refused twice.
#
# The digit belongs on FAIL as much as on PASS, and that direction is the sharper one: a `QA2 FAIL`
# the parser cannot see is a REFUSAL that vanishes, and this file's ordering ("a failing verdict for
# THIS sha outranks a passing one") can only rank a refusal it recognises.
PASS = re.compile(r"^(QA2?\s+PASS|CYBERSEC\s+GO|CYBERED\s+GO)\b", re.I)
FAIL = re.compile(r"^(QA2?\s+FAIL|CYBERSEC\s+NO-GO|CYBERED\s+NO-GO)\b", re.I)
QA = re.compile(r"^QA2?\s+PASS\b", re.I)
# Which gate the verdict WORD claims to be. Same fold as the author side: the sibling digit is
# not a separate gate.
CLAIMS = re.compile(r"^(QA)2?\b|^(CYBERSEC)\b|^(CYBERED)\b", re.I)
GATE_SHA_LINE = re.compile(r"^\s*Gate-SHA:\s*(.+)", re.I)
HEX = re.compile(r"[0-9a-f]{7,40}", re.I)


def shas_in(text):
    found = set()
    for line in text.split("\n"):
        m = GATE_SHA_LINE.match(line)
        if m:
            for tok in HEX.findall(m.group(1)):
                found.add(tok.lower())
    return found


def claimed_role(first_line):
    """The gate this verdict SAYS it comes from, or None if the line is not a verdict."""
    m = CLAIMS.match(first_line)
    return next(g for g in m.groups() if g).upper() if m else None


# A sha short enough to prefix-match half the repo is not an identification. Git's own short form
# is 7, so that is the floor. The check below rejects anything shorter OUTRIGHT rather than
# comparing with it.
MIN_SHA = 7


def covers(found, sha):
    # Short shas are the norm in these comments, so accept a prefix either way.
    #
    # The guard here used to be `f and ...`, protecting against an empty entry in `found`. That was
    # dead code -- HEX requires 7+ characters, so an entry can never be empty -- and a mutation
    # deleting it changed nothing, which is how the misplacement surfaced. The live danger is the
    # OTHER operand: with an empty `sha`, `f.startswith("")` is True for every verdict on the card,
    # so the check would pass on a completely unrelated commit. That case is rejected before we get
    # here (see main), and this stays a plain comparison.
    s = sha.lower()
    return any(s.startswith(f) or f.startswith(s) for f in found)


def main():
    if len(sys.argv) < 2:
        print("UNREADABLE|no sha given")
        return 0
    sha = sys.argv[1].strip()
    if len(sha) < MIN_SHA:
        # Fail-closed: refuse mode turns UNREADABLE into a refusal, which is the right answer for
        # "I was not told which commit to check".
        print(f"UNREADABLE|sha {sha!r} is shorter than {MIN_SHA} chars -- refusing to prefix-match on it")
        return 0
    try:
        doc = json.load(sys.stdin)
    except Exception as exc:
        print(f"UNREADABLE|{exc}")
        return 0
    comments = doc.get("comments", doc) if isinstance(doc, dict) else doc
    if not isinstance(comments, list):
        print("UNREADABLE|unexpected response shape")
        return 0

    qa_passes, other_passes, unattributed, fails, any_pass = [], [], [], [], False
    for c in comments:
        if not isinstance(c, dict):
            continue
        text = (c.get("content") or "").strip()
        first = text.split("\n")[0].strip()
        who = c.get("author") or "?"
        if PASS.match(first):
            any_pass = True
            if covers(shas_in(text), sha):
                # A PASS MUST COME FROM THE GATE IT CLAIMS TO BE (card 48b0dd36, Cybersec).
                #
                # This tool decides whether a push to origin/develop happens, and until now it
                # authenticated a verdict by its TEXT SHAPE alone: any author whose comment began
                # `QA PASS` and carried a `Gate-SHA:` line satisfied the mandatory QA requirement.
                # A maker could sign off their own work by writing the words.
                #
                # Author checking is not authentication -- the kanban API takes the author from the
                # request body under one shared token -- but a verdict that does not even CLAIM to
                # come from the gate is not that gate's verdict, and that is the cheap half.
                if author_role(who) != claimed_role(first):
                    unattributed.append(f"{who}: {first[:40]}")
                # Rule 4 makes QA mandatory on EVERY card; a security gate is risk-tiered on top.
                # So a lone `CYBERSEC GO` is not evidence the card was gated, only that half of it
                # was -- it is reported, but it does not satisfy the check.
                elif QA.match(first):
                    qa_passes.append(f"{who}: {first[:40]}")
                else:
                    other_passes.append(f"{who}: {first[:40]}")
        elif FAIL.match(first):
            if covers(shas_in(text), sha):
                # DELIBERATELY NOT AUTHOR-CHECKED, and the asymmetry is the whole design. An
                # unattributable PASS is not a pass; an unattributable REFUSAL is still a refusal.
                # Requiring a role author here would DROP relayed refusals -- MikroB's own
                # "<GATE> <VERDICT> ELFOGADVA" restatement is the routine shape on this board --
                # and let a landing proceed over a stated NO-GO. That is strictly worse than the
                # hole being closed, so a failing verdict stands whoever wrote it.
                fails.append(f"{who}: {first[:40]}")

    # A failing verdict for THIS sha outranks a passing one: a re-gate after a fix lands a new sha,
    # so a pass and a fail naming the same sha means the fix was never re-gated.
    if fails:
        print("FAILED|" + "; ".join(fails))
    elif qa_passes:
        extra = ("; also " + "; ".join(other_passes)) if other_passes else ""
        print("OK|" + "; ".join(qa_passes) + extra)
    elif unattributed:
        # Ranked above NOQA because it is the more specific complaint: something verdict-shaped
        # names this sha, and the reason it does not count is WHO wrote it. Any kind other than OK
        # refuses in the lander's refuse mode, so a new word here is fail-closed by construction.
        print("UNVERIFIED-AUTHOR|a verdict for this sha was written by someone who does not hold "
              "that gate's role (" + "; ".join(unattributed)
              + ") -- a gate's own PASS is what this check needs")
    elif other_passes:
        print("NOQA|a security gate passed this sha (" + "; ".join(other_passes)
              + ") but QA did not -- rule 4 makes QA mandatory on every card")
    elif any_pass:
        print("OTHERSHA|a gate verdict exists on this card, but none of them names this sha")
    else:
        print("NONE|no QA/Cybersec/Cybered verdict on this card at all")
    return 0


if __name__ == "__main__":
    sys.exit(main())
