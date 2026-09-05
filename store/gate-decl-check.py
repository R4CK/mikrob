#!/usr/bin/env python3
"""gate-decl-check.py -- does a card's gate designation live where the scanners actually read it?

WHY THIS EXISTS (card 67a5ee01, Cybersec measurement 2026-09-05). MikroB designates a card's gates
by writing "Gate: QA + Cybersec". `gate_scan_lib.declared_gate_excludes_me()` -- which BOTH
cybersec-gate-scan.py and cybered-gate-scan.py consult to decide whether to skip a card -- reads
the card's DESCRIPTION. A designation written only into a comment therefore does not exist as far
as any scanner is concerned, however clearly it is stated to a human.

MEASURED ON THIS BOARD (2951 cards): 1161 declare in the description, 158 in both, and 110 in a
MikroB comment ONLY. No OPEN card is in that last group today, so this is a process guard rather
than an outstanding incident -- which is exactly when it is cheap to install.

THE REVERSE RISK, which the card names and which measurement confirms is the bigger one: of the 158
cards declaring in both places, 51 DISAGREE once sibling numbering is normalised away (see below).
23 of those have a description NARROWER than the latest MikroB comment -- and that direction is the
dangerous one, because a gate the description omits is a gate that SKIPS the card. The other 28 are
wider, which costs one unnecessary read. The two failure directions are not symmetric, so they are
not reported as one number.

SIBLING NUMBERING IS NORMALISED, for the same reason gate-closure-check.py normalises it: "QA2" is
the QA role staffed by its second agent, not a fourth gate. Comparing without normalising reported
2 disagreements that were nothing but "QA" against "QA + QA2".

Usage:
  gate-decl-check.py < card.json          # {"description": "...", "comments": [...]}
  gate-decl-check.py --card <id>          # fetch the card from the dashboard API

Output is one line:
  OK|<roles>                    the description declares the gates and nothing contradicts it
  NARROWER|<desc>|<comment>     the description omits a gate a MikroB comment names -- that gate
                                will skip the card. Exit 1.
  WIDER|<desc>|<comment>        the description names a gate a later comment dropped. Exit 1.
  COMMENT-ONLY|<roles>          designated only in a comment, so no scanner can see it. Exit 1.
  PROSE                         a `Gate:` line that names no role -- the scanners read the prose as
                                the designation and skip the card from every gate. Exit 1.
  MID-SENTENCE|<roles>          a real designation written mid-sentence, where the anchored
                                GATE_DECL_RX no longer sees it -- so the card falls through and
                                surfaces to every gate. Costs one unnecessary review, never a
                                missing one, but it is convention drift and grows if unreported.
                                Exit 1.
  NONE                          no designation anywhere -- not a finding here, since absence is
                                handled by declared_gate_excludes_me() falling through. Exit 0.

Exit: 0 when the designation is where the scanners read it, 1 when a read-back should not pass.
Unlike gate-closure-check.py this DOES use its exit code: it verifies a process step rather than
standing between a gate and a closure.
"""
from __future__ import annotations

import json
import os
import re
import sys

# Shared recognition rules rather than a fourth private copy of the same regex -- the defect class
# gate_scan_lib exists to close (card 3477c793).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gate_scan_lib import GATE_DECL_RX, BARE_DECL_RX  # noqa: E402

# A gate role, with any sibling number attached. `\d*` rather than an enumerated "QA2" so a future
# CYBERSEC2/CYBERED2 needs no edit here; there are zero of those on the board today.
_ROLE = re.compile(r"\b(QA|CYBERSEC|CYBERED)\d*\b", re.IGNORECASE)


def roles(text):
    """The gate ROLES named in a designation line, sibling numbers normalised away."""
    return {m.group(1).upper() for m in _ROLE.finditer(text or "")}


# The PRE-ANCHORING form now lives in gate_scan_lib beside the anchored rule, because the scanner
# consults it too (Cybered NO-GO 20940: a later mid-sentence designation makes the anchored reading
# untrustworthy, so declared_gate_excludes_me falls through). Keeping a private copy here would put
# the same idea in two files -- the defect class that module exists to close.


def declared_roles(text):
    """Roles from the LAST `Gate:` line in `text`, or None if it declares none.

    The last one wins, matching declared_gate_excludes_me(): scope widens mid-thread when a chained
    finding pulls another gate in, and the newest statement is the current one.
    """
    found = GATE_DECL_RX.findall(text or "")
    return roles(found[-1]) if found else None


def check(description, comments):
    """(code, description-roles, comment-roles). See the module docstring for the codes."""
    desc = declared_roles(description)
    # Only MikroB designates gates (rule 4 makes the tiering his job). A BUILDER's own "Gate: QA"
    # line is a suggestion, and treating it as authority is how a corrected tier gets pinned back
    # to the wrong value -- the reverse risk the card names.
    latest_comment = None
    for c in comments or []:
        if not isinstance(c, dict) or (c.get("author") or "").lower() != "mikrob":
            continue
        r = declared_roles(c.get("content"))
        if r:
            latest_comment = r

    # A REAL designation the anchored regex cannot see, because it is written mid-sentence
    # ("... o ismeri a kontextust. QA gate: a javitas ...") or after a boundary the class excludes
    # (`)` or `-`). Card 82fa48b0 anchored GATE_DECL_RX to a sentence or clause start, which loses 4
    # such cards board-wide; each one now falls through and surfaces to EVERY gate, so the cost is a
    # wasted read, not a missed gate. It is still reported: the position of a designation is a
    # CONVENTION, and fixing the parser does not fix how people write. Unreported, those 4 grow.
    #
    # IT SITS ON THE ROLE-SET DIFFERENCE, NOT ON `desc is None` (Cybered NO-GO 20940). The old
    # condition ran the report ONLY when the anchored regex saw nothing at all -- that is, only in
    # the harmless case, where the card already falls through to every gate and the cost is one
    # wasted read. In the DAMAGING case, where an earlier narrow "Gate: QA." survives anchoring
    # while a later, wider mid-sentence designation is dropped, the anchored regex does find
    # something, so the branch never ran: this tool answered OK and handed back the NARROWED role
    # set as truth. Loudest where the drift is free, silent where it costs two gates.
    bare = BARE_DECL_RX.findall(description or "")
    if bare:
        drifted = roles(bare[-1])
        if drifted and drifted != (desc or set()):
            return ("MID-SENTENCE", drifted, latest_comment)

    if desc is None and latest_comment is None:
        return ("NONE", None, None)
    # A `Gate:` line that names no role at all. GATE_DECL_RX searches rather than anchors, so it
    # matches "Gate:" mid-sentence and inside quoted prose -- and declared_gate_excludes_me() then
    # takes that prose as the card's designation and answers True for EVERY gate. Measured on this
    # card (67a5ee01): its own description discusses `Gate: QA + X"` and `Gate: sort description-be
    # irja`, and all three gates are consequently told the card is not theirs. 24 cards board-wide
    # carried the shape when this was written. The anchoring that repair needed SHIPPED on card
    # 82fa48b0 (2026-09-05), so GATE_DECL_RX no longer matches inside quoted prose and this code is
    # now reached only by a `Gate:` that starts a sentence and still names no role.
    if desc is not None and not desc:
        return ("PROSE", desc, latest_comment)
    if desc is None:
        return ("COMMENT-ONLY", None, latest_comment)
    if latest_comment is None or desc == latest_comment:
        return ("OK", desc, latest_comment)
    if latest_comment - desc:
        return ("NARROWER", desc, latest_comment)
    return ("WIDER", desc, latest_comment)


def _fmt(rs):
    return ",".join(sorted(rs)) if rs else "-"


def main(argv):
    if "--card" in argv:
        import urllib.request
        card_id = argv[argv.index("--card") + 1]
        root = os.environ.get("MARVEEN_MAIN", "/home/neon/marveen")
        token = open(os.path.join(root, "store/.dashboard-token")).read().strip()
        req = urllib.request.Request(
            "http://localhost:3420/api/kanban/%s" % card_id,
            headers={"Authorization": "Bearer %s" % token})
        card = json.load(urllib.request.urlopen(req))
        card = card.get("card", card)
        req = urllib.request.Request(
            "http://localhost:3420/api/kanban/%s/comments" % card_id,
            headers={"Authorization": "Bearer %s" % token})
        raw = json.load(urllib.request.urlopen(req))
        comments = raw.get("comments", raw) if isinstance(raw, dict) else raw
    else:
        try:
            payload = json.load(sys.stdin)
        except Exception as exc:
            print("UNREADABLE|%s" % exc)
            return 1
        card, comments = payload, payload.get("comments") or []

    code, desc, com = check(card.get("description"), comments)
    if code == "OK":
        print("OK|%s" % _fmt(desc))
        return 0
    if code == "NONE":
        print("NONE")
        return 0
    if code == "MID-SENTENCE":
        print("MID-SENTENCE|%s (a real designation written mid-sentence, where the anchored "
              "GATE_DECL_RX does not read it -- the card surfaces to every gate instead, which "
              "costs a review rather than losing one. Put the `Gate:` on its own line.)"
              % _fmt(desc))
        return 1
    if code == "PROSE":
        print("PROSE|a `Gate:` line names no gate role, so declared_gate_excludes_me() reads the "
              "prose as the designation and answers 'not yours' to EVERY gate -- this card is "
              "invisible to all three scanners")
        return 1
    if code == "COMMENT-ONLY":
        print("COMMENT-ONLY|%s (declared only in a MikroB comment -- no scanner reads comments, "
              "so this designation does not exist for cybersec-gate-scan or cybered-gate-scan)"
              % _fmt(com))
        return 1
    if code == "NARROWER":
        print("NARROWER|%s|%s (a gate the comment names is missing from the description, so "
              "declared_gate_excludes_me() tells it the card is not its own and it SKIPS)"
              % (_fmt(desc), _fmt(com)))
        return 1
    print("WIDER|%s|%s (the description names a gate a later comment dropped -- costs one "
          "unnecessary review, not a missing one)" % (_fmt(desc), _fmt(com)))
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
