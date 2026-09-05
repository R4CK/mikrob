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
#
# ANCHORED TO A SENTENCE OR CLAUSE BOUNDARY (card 82fa48b0, 2026-09-05), which is neither of the two
# things this line has been before, and the middle position is the measured one:
#
#   * A bare search (the previous form) matches the word inside QUOTED PROSE. Measured on card
#     67a5ee01, whose description DISCUSSES designations: the last match was the sentence
#     "...a Gate: sort description-be irja PUT-tal...", which names no role, so the caller below
#     computed an EMPTY role set and excluded ALL THREE gates from a card nobody had designated.
#   * Anchoring to a line start (`^\s*Gate:`, the form 77fd0f07 removed and the form this card
#     originally prescribed) is worse in the other direction: real designations are usually the
#     CLOSING SENTENCE of a paragraph, not a line of their own. Measured over all 2997 cards, on the
#     1322 that carry a role-naming designation today, line-start anchoring drops 419 of them --
#     seventeen real designations lost per false positive fixed.
#
# So the match must begin a sentence or a clause: at a line start, or after `. ! ? ; , (`. Measured
# on the same corpus this preserves 1318 of 1322 and changes none. MikroB approved this variant
# (comment 20581) over the line-start one after that measurement.
#
# THE FOUR IT STILL LOSES, named so the next reader does not have to re-derive them:
#   5fd54914  "... -> 3-gate: QA + Cybersec + Cybered."            -- preceded by `-`
#   722b444a  "... ; (5) gate: QA + kockazat szerinti ..."         -- preceded by `)`
#   f5e4279b  "... ; (3) gate: QA + Cybersec (install/token ...)"  -- preceded by `)`
#   c52e2823  "... o ismeri a kontextust. QA gate: a javitas ..."  -- mid-sentence prose
# Every one of them fails SAFE: no designation found -> declared_gate_excludes_me() returns False
# -> the card falls through and surfaces to EVERY gate. That is the direction this module's own
# docstring asks for, one wasted read rather than one missed gate. Adding `)` and `-` to the class
# would recover three of them and is a one-character change, deliberately NOT made here: it widens
# the approved boundary set and belongs in its own decision.
#
# DO NOT add a quote character to the boundary class. `"` is exactly what separates the founding
# case's quoted prose from a real designation; allowing it re-opens the bug this closed.
GATE_DECL_RX = re.compile(
    r'(?:^[ \t]*|(?<=[.!?;,(])[ \t]*)Gate:\s*([^\n]+)',
    re.IGNORECASE | re.MULTILINE,
)


# Verdict-word vocabulary (card 171422d2, Cybersec measurement 2026-08-24, 3477c793 kore).
# Was two private copies (cybered-gate-scan.py had one, cybersec-gate-scan.py had none) -- exactly
# the "one idea, two places" defect class this module exists to close, so it lives HERE now, not in
# a scanner. Board-wide sweep of 300 gate-authored verdict comments found 62 written in a synonym
# shape the old vocabulary never matched: "QA GATE: PASS" (38), "QA VERDICT: PASS" (21),
# "CYBERSEC GATE: GO" (3). VOCABULARY WIDENING ONLY -- these are the exact three measured shapes,
# nothing speculative added for symmetry (e.g. no unmeasured "CYBERED GATE: GO" form). Both regexes
# are read-only, informational-display consumers today (cybered-gate-scan.py's risk-tiering
# context column); turning a match into an actual gating DECISION is explicitly out of this card's
# scope until that use is separately reviewed for safety.
PASS_RE = re.compile(
    r'^(QA2?\s+(?:(?:GATE|VERDICT)\s*:\s*)?PASS'
    r'|CYBERSEC\s+(?:GATE\s*:\s*)?GO'
    r'|CYBERED\s+(?:FULL-CARD\s+)?GO)',
    re.IGNORECASE,
)
FAIL_RE = re.compile(
    r'^(QA2?\s+(?:(?:GATE|VERDICT)\s*:\s*)?FAIL'
    r'|CYBERSEC\s+(?:GATE\s*:\s*)?NO-GO'
    r'|CYBERED\s+NO-GO)',
    re.IGNORECASE,
)


# The PRE-ANCHORING form of the same declaration. It lives HERE, beside the anchored rule, because
# it is no longer only a drift-measuring curiosity: `declared_gate_excludes_me` below CONSULTS it to
# decide whether the anchored reading can be trusted at all. Two copies of it in two files is the
# exact defect class this module exists to close.
BARE_DECL_RX = re.compile(r'Gate:\s*([^\n]+)', re.IGNORECASE)


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

    A declaration the anchored regex CANNOT READ but the bare one can, positioned after the last
    anchored one -> also False, for the same reason one level over: an incomplete reading is not a
    decision either. See the block in the body.
    """
    text = description or ''
    matches = list(GATE_DECL_RX.finditer(text))
    if not matches:
        return False

    # A LATER DESIGNATION THE ANCHORED RULE CANNOT SEE MAKES THE EARLIER ONE UNTRUSTWORTHY
    # (Cybered NO-GO on this card, comment 20940). Anchoring closed a fail-open hole and opened a
    # narrower one in the OTHER direction, precisely on the case the last-match-wins rule exists
    # for. If the newest designation is written mid-sentence -- and 419 of the board's real ones
    # are -- the anchored regex drops it, and the last SURVIVING match is an older, usually
    # NARROWER designation. The card then falls silently out of the gates the fresh designation
    # names. Cybered's proof-of-concept, on ordinary card prose:
    #
    #     "Elso korben a felbontas szerint keszult. Gate: QA.
    #      MikroB kiterjesztette a hatokort ..., tehat a helyes designacio
    #      mostantol Gate: QA + Cybersec + Cybered (publikus write path)."
    #
    # Before this guard: qa False, cybersec True, cybered True -- two gates skipped on a card whose
    # own newest sentence names them. Under the pre-anchoring search all three were False.
    #
    # So: if the bare form finds a declaration BEYOND the last anchored one, this description is not
    # something we can read reliably, and an unreadable designation is not a decision. Fall through.
    # That is the same asymmetry stated below and in this module's docstring -- one wasted read
    # against one missing gate -- applied to a reading we know is incomplete rather than to an
    # absence. Both regexes run to end of line, so their `end()` positions coincide for the same
    # declaration and a strictly greater one is genuinely a later, unseen declaration.
    #
    # Measured board-wide, independently of Cybered's own sweep and agreeing with it exactly (3001
    # cards x 3 gates): this surfaces ONE extra card today (3d923ef5, to cybersec and cybered) and
    # skips none. The shape it protects against is already present on that card -- its anchored last
    # match already differs from its bare last match, and only a single edit widening its scope
    # mid-sentence separates it from being live.
    last_anchored_end = matches[-1].end()
    if any(b.end() > last_anchored_end for b in BARE_DECL_RX.finditer(text)):
        return False

    return my_gate.lower() not in matches[-1].group(1).lower()
