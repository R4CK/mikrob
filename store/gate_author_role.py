"""WHO IS ALLOWED TO SPEAK FOR A GATE -- one table, shared by every tool that asks (card 48b0dd36).

WHY THIS IS A MODULE AND NOT A COPY. The rule lived in `gate-closure-check.py` alone, which is the
ADVISORY reader: it prints a line and a human decides. The tool that actually permits or refuses a
push to origin/develop is `landing-gate-verdict-parse.py`, and it read the verdict's TEXT SHAPE and
never its author -- so the enforcing half of the pair was the half without the check. Copying the
function across would have closed that for today and reopened it on the first alias someone adds to
one file and not the other; the next entry in this table has to reach both readers by construction.

Comment authorship on the kanban API comes from the request BODY under one shared Bearer token, so
any agent can post as any author. This table is therefore not authentication -- it cannot be. It is
the weaker, still useful statement: a verdict that does not even CLAIM to come from the gate is not
that gate's verdict.

STRICT author==gate IS THE WRONG FIX, measured on the live board (card 44849954, Cybered): 156
card-gate pairs carry a latest verdict written by someone other than the gate, and 152 of those are
MikroB's own summary comments restating a real verdict. Rejecting them outright would retroactively
call 54 closed cards ungated and make the tool unusable the day it shipped -- which is why the
callers treat an unattributable PASS and an unattributable REFUSAL differently, rather than this
table trying to.

THE SIBLING FOLD MIRRORS THE ONE ON THE VERDICT-WORD SIDE (rule 4 load-balances QA/QA2, and only one
of a pair reviews a given card, so a sibling's verdict IS that role's verdict). Applying the fold to
only one of the two sides is its own bug: measured, an author fold-free version calls 245 legitimate
QA2 verdicts foreign. Trailing digits are stripped by the same rule, so a future CYBERSEC2/CYBERED2
needs no edit here.
"""
import re

# The gate roles themselves. Named here rather than in each caller for the same reason as the alias
# table: a role that exists for one reader and not the other is the divergence this module exists
# to prevent.
GATE_ROLES = ("QA", "CYBERSEC", "CYBERED")

_AUTHOR_ALIASES = {"qa-engineer": "QA", "cybersecurity-redteam": "CYBERSEC"}
_AUTHOR_SIBLING_SUFFIX = re.compile(r"\d+$")

# DISPLAY-NAME ALIASES (Peti rename, 2026-10-02, Telegram 10092; parser fix card cf0a8c0b). The
# visible persona is WhiteHat/RedHat now; the internal agent id, GATE_ROLES and verdict AUTHORSHIP
# stay CYBERSEC/CYBERED (CLAUDE.md: "a belso azonositok ... szandekosan valtozatlanok"). This table
# only lets a VERDICT WORD or a `Gate:` DECLARATION spelled with the new display name resolve to the
# same canonical role every other reader already recognises. One table, so a fix here reaches every
# parser that imports it instead of drifting between whichever ones someone edited (the exact defect
# class gate_scan_lib.py's own docstring describes for the sibling table).
GATE_ROLE_ALIASES = {"CYBERSEC": ("WHITEHAT",), "CYBERED": ("REDHAT",)}


def canonical_gate(word):
    """Fold an uppercased alias (e.g. "WHITEHAT") to its canonical GATE_ROLES name. Passthrough
    for anything already canonical or unrecognised."""
    word = (word or "").upper()
    for canon, aliases in GATE_ROLE_ALIASES.items():
        if word == canon or word in aliases:
            return canon
    return word


def gate_spellings(role):
    """Every accepted spelling of `role` (its own case preserved, aliases lowercased to match),
    for callers that need to test free text for ANY of a role's names rather than normalise a
    single matched token. `role` may be given in either case."""
    up = (role or "").upper()
    aliases = GATE_ROLE_ALIASES.get(up, ())
    spellings = [role] + [a.lower() if (role or "").islower() else a for a in aliases]
    return spellings


def author_role(author):
    """The gate ROLE this author speaks for, or None for anyone else."""
    name = (author or "").strip().lower()
    if not name:
        return None
    if name in _AUTHOR_ALIASES:
        return _AUTHOR_ALIASES[name]
    role = _AUTHOR_SIBLING_SUFFIX.sub("", name).upper()
    return role if role in GATE_ROLES else None
