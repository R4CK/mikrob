#!/usr/bin/env python3
"""Shared recognition rules for the per-gate self-advance scanners (card 3477c793).

ONE definition, two consumers (`cybersec-gate-scan.py`, `cybered-gate-scan.py`). The reason this
module exists at all is the defect class both fixes below belong to: the `kanban-gate-scan` skill
DOCUMENTED the gate-tier filter after 18 measured false positives on 2026-08-17, and neither actual
script ever got it -- one idea, two places, and the half that runs was the half that missed out.
Putting the rules here is what keeps the next fix from landing on only one of them.
"""
import re

# A structural header line that may legitimately stand BEFORE the verdict word.
#
# Rule 4c (CLAUDE.md, 2026-08-24) settles the convention going forward: verdict word on line 1,
# `Gate-SHA:` on line 2. It does not retroactively rewrite what is already on the board. Rule 4b,
# which came first, only required the `Gate-SHA:` line to start a LINE -- so several gate agents put
# it FIRST and the verdict word second, and every scanner that anchored on line 1 stopped seeing
# those verdicts.
GATE_SHA_LINE_RX = re.compile(r'^\s*Gate-SHA:\s*\S', re.IGNORECASE)


def verdict_body(content):
    """The comment text starting at the first line that is not blank and not a `Gate-SHA:` header.

    MEASURED BEFORE CHOOSING HOW FAR TO RELAX (board-wide sweep, 2026-08-24, 300 gate-authored
    comments carrying an anchored verdict word):

        254  verdict word already on line 1        -- recognised before and after
         42  ONLY `Gate-SHA:`/blank lines before it -- recovered by this function
          4  free PROSE before the verdict word     -- deliberately still NOT recognised

    The last four are why this skips a NAMED STRUCTURAL LINE rather than "the first two lines".
    Accepting arbitrary text above the verdict would reopen the false-positive class both scanners
    already carry warnings about (a quoted "REVIEW"/"DONE" mid-sentence reading as the real thing),
    and it would buy 4 cases at the price of every prose comment that happens to mention a gate word
    on its second line. Recovering 42 of 46 with a rule that cannot misfire is the better trade;
    the 4 are listed here rather than silently rounded away.

    Blank lines are skipped too -- `Gate-SHA: x\\n\\nCYBERSEC GO` is the same shape.
    """
    text = str(content or '')
    lines = text.split('\n')
    for i, line in enumerate(lines):
        if not line.strip():
            continue
        if GATE_SHA_LINE_RX.match(line):
            continue
        return '\n'.join(lines[i:]).lstrip()
    return ''


# The declared gate tier, e.g. "Gate: QA + Cybersec + Cybered" at the end of a card description.
# NOT anchored to a line start (77fd0f07, 2026-08-17): some descriptions end the last PARAGRAPH with
# "... szoveg. Gate: QA." on the same line as prose, and a `^\s*Gate:` MULTILINE anchor missed those
# entirely, letting a QA-only card through the filter.
GATE_DECL_RX = re.compile(r'Gate:\s*([^\n]+)', re.IGNORECASE)


def declared_gate_excludes_me(description, my_gate):
    """True when the card's own description names its gates and MINE is not among them.

    Ported from the `kanban-gate-scan` skill, where it was added after a raw cybered sweep flagged
    18 cards as "ungated" and all 18 turned out to be QA-only or QA+Cybersec -- one full card read,
    with its comments, burned per card just to conclude "not mine".

    The LAST mention wins: scope can widen mid-thread (MikroB adds Cybered after a chained finding),
    and the newest statement is the current one.

    NO `Gate:` line at all -> False, i.e. fall through and surface the card. Absence of a declaration
    is not a decision, and the failure directions are not symmetric: surfacing a card that is not
    mine costs one read, while skipping one that is costs a missing gate.
    """
    matches = GATE_DECL_RX.findall(description or '')
    if not matches:
        return False
    return my_gate.lower() not in matches[-1].lower()
