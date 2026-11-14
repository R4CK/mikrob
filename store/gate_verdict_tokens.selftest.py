#!/usr/bin/env python3
"""Self-test for gate_verdict_tokens.py (card ec34c025).

Pins the shape gate-closure-check.py relies on after importing from here instead of defining its
own copy: the gate names, outcome words, which outcomes pass, and that the regex still anchors to
the comment's opening word (rule 4c) with the `(?![-\\w])` boundary that stops "QA PASS-eligible"
from parsing as a QA verdict.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate_verdict_tokens as gvt  # noqa: E402

failures = []
n = 0


def check(label, got, want):
    global n
    n += 1
    ok = got == want
    print("%s %-30s got=%r want=%r" % ("OK  " if ok else "FAIL", label, got, want))
    if not ok:
        failures.append((label, want, got))


check("GATE_NAMES", gvt.GATE_NAMES, ("QA", "CYBERSEC", "WHITEHAT", "CYBERED", "REDHAT"))
check("OUTCOME_WORDS", gvt.OUTCOME_WORDS, ("PASS", "FAIL", "GO", "NO-GO"))
check("PASSING", gvt.PASSING, frozenset({"PASS", "GO"}))

for text, want in (
    ("QA PASS -- all good", ("QA", "", "PASS")),
    ("qa2 pass", ("qa", "2", "pass")),
    ("CYBERSEC NO-GO", ("CYBERSEC", "", "NO-GO")),
    ("WHITEHAT GO", ("WHITEHAT", "", "GO")),
    ("REDHAT: NO-GO", ("REDHAT", "", "NO-GO")),
    ("CYBERED GATE: GO", ("CYBERED", "", "GO")),
):
    m = gvt.VERDICT_RE.match(text)
    got = (m.group(1), m.group(2), m.group(3)) if m else None
    check("VERDICT_RE match %r" % text, got, want)

# The boundary that keeps a builder's own "QA PASS-eligible" from parsing as a verdict.
check("VERDICT_RE rejects PASS-eligible", gvt.VERDICT_RE.match("QA PASS-eligible for review"), None)
# Prose that merely mentions a verdict mid-sentence is not an opening match.
check("VERDICT_RE anchored, not search", bool(gvt.VERDICT_RE.match("see the QA PASS above")), False)

print()
print("selftest: %d case(s), %s" % (n, "PASS" if not failures else "FAIL"))
for f in failures:
    print("  - %s: expected %s, got %s" % f)
sys.exit(1 if failures else 0)
