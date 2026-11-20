"""THE verdict-token vocabulary -- one source, so gate-closure-check.py and any future importer
cannot drift apart on what counts as a gate verdict word (card ec34c025, rescope point 5 of
ed332869's shared-contract scope).

This module owns exactly what rule 4c of the root CLAUDE.md fixes: the gate NAMES (QA, CYBERSEC,
WHITEHAT, CYBERED, REDHAT -- the last two are display-name aliases, card cf0a8c0b), the OUTCOME
words (PASS, FAIL, GO, NO-GO), and which outcomes PASS. gate-closure-check.py previously defined
its own copy of the regex and the PASSING set; this card moves that copy here and gate-closure-
check.py now imports it. Migrating the OTHER files that carry their own copy of this vocabulary
(kanban-gate-completeness-guard.ts, landing-gate-verdict-parse.py, nmr-rederive.py,
gate-pretriage-candidates.py, gate-dispatch-check.sh, heartbeat-scriptfirst.sh) is explicitly out
of scope here -- MikroB's rescope names them as later cards (F5/F7/F8) precisely so no single card
has to touch every consumer at once.

The verdict must be the comment's OPENING word (rule 4c), with an optional `Gate-SHA:`/`Skills:`
header line allowed first -- the caller applies that lead-skip itself (gate-closure-check.py's
own `_LEAD_SKIP`), because that convention is about COMMENT STRUCTURE, not the token vocabulary
this module owns.

`(?![-\\w])` rather than `\\b`: `\\b` matches between the S of PASS and the hyphen of
"QA PASS-eligible", so a builder's own "QA PASS-eligible" line would parse as a QA verdict.
"""
import re

GATE_NAMES = ("QA", "CYBERSEC", "WHITEHAT", "CYBERED", "REDHAT")
OUTCOME_WORDS = ("PASS", "FAIL", "GO", "NO-GO")
PASSING = frozenset({"PASS", "GO"})

VERDICT_RE = re.compile(
    r"^\s*(QA|CYBERSEC|WHITEHAT|CYBERED|REDHAT)(\d*)(?:[ \t]*(?:GATE|VERDICT))?[ \t]*(?::[ \t]*)?(PASS|FAIL|GO|NO-GO)(?![-\w])",
    re.IGNORECASE,
)
