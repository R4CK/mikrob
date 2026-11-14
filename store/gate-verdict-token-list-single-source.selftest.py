#!/usr/bin/env python3
"""Guard: gate-closure-check.py must import the verdict-token list, never redefine it (card
ec34c025, Kesz-ha bullet 2: "a test fails if a second copy of the token list appears in the
repo").

SCOPED TO THE ONE FILE THIS CARD MIGRATED, not the whole repo. The other known copies
(kanban-gate-completeness-guard.ts, landing-gate-verdict-parse.py, nmr-rederive.py,
gate-pretriage-candidates.py, gate-dispatch-check.sh, heartbeat-scriptfirst.sh) are pre-existing
and migrating them is explicitly out of scope here (MikroB's rescope names them as later cards,
F5/F7/F8) -- a repo-wide zero-duplicates guard would fail on day one against work this card never
touched. What this guard pins is narrower and load-bearing regardless: gate-closure-check.py
specifically must not grow its OWN copy of the vocabulary back, since it is the one file this
card proved produces byte-identical output via the shared module (20 real cards, see the REVIEW).

Mutation-tested: temporarily re-adding `_VERDICT = re.compile(r"...")` or
`PASSING = {"PASS", "GO"}` to gate-closure-check.py turns this guard red (verified by hand before
landing; not re-run automatically here, since that would mean editing the file under test).
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "gate-closure-check.py")

with open(TARGET, encoding="utf-8") as f:
    # Comments must not trip this: the file's own history (kept above the import line) quotes the
    # regex and the set literal in prose while explaining the move (card ec34c025 again, and the
    # general rule from guards-that-pin-behaviour -- a guard must match the OPERATIVE line, not any
    # line that merely mentions the shape). Strip full-line and trailing comments before scanning.
    lines = []
    for raw in f:
        code = raw.split("#", 1)[0]
        lines.append(code)
    source = "\n".join(lines)

failures = []
n = 0


def check(label, cond):
    global n
    n += 1
    print("%s %s" % ("OK  " if cond else "FAIL", label))
    if not cond:
        failures.append(label)


# An ACTUAL regex-literal assignment to _VERDICT (not the import's `as _VERDICT` alias).
check(
    "no inline _VERDICT = re.compile(...) in gate-closure-check.py",
    not re.search(r"^_VERDICT\s*=\s*re\.compile", source, re.MULTILINE),
)
# An ACTUAL set/frozenset literal assignment to PASSING (not the imported name).
check(
    "no inline PASSING = {...} in gate-closure-check.py",
    not re.search(r"^PASSING\s*=\s*[{(]", source, re.MULTILINE),
)
check(
    "gate-closure-check.py imports VERDICT_RE from gate_verdict_tokens",
    bool(re.search(r"^from gate_verdict_tokens import\b.*\bVERDICT_RE\b", source, re.MULTILINE)),
)
check(
    "gate-closure-check.py imports PASSING from gate_verdict_tokens",
    bool(re.search(r"^from gate_verdict_tokens import\b.*\bPASSING\b", source, re.MULTILINE)),
)

print()
print("selftest: %d case(s), %s" % (n, "PASS" if not failures else "FAIL"))
for f in failures:
    print("  - %s" % f)
sys.exit(1 if failures else 0)
