#!/usr/bin/env python3
"""Do the designated gates' verdicts judge the SAME sha? (card 1c4f9af1)

Cybered's finding: the closure rule -- MikroB's manual check today, an automated one later -- asks
whether EVERY designated gate produced a verdict. It does not ask whether they produced them for the
same code. After a NO-GO the author fixes the finding and re-gates; if only one gate re-runs, the
card shows "QA PASS" and "CYBERSEC GO" side by side while one of them is judging the pre-fix sha.
Superficially complete, actually never reviewed as a whole.

WHY THIS COMPARES THE LATEST VERDICT PER GATE, NOT ALL OF THEM. Mixed shas across a card's history
are normal and healthy -- that is exactly what delta-gating looks like: gate verdicts on sha A, the
author fixes, everyone re-verdicts on sha B. Measured on this board (33 cards carrying at least one
gate verdict): 10 have more than one distinct sha across their history, and most of those are the
healthy shape. Taking the LATEST verdict per gate separates the two cases; taking all of them would
flag a third of the board and be ignored within a day.

WHY A MISSING `Gate-SHA:` LINE IS ITS OWN ANSWER, not a refusal. Rule 4b made that line OPTIONAL, and
the board agrees: 70 of 76 verdicts carry one (92%), so 8% legitimately do not. Reporting NOSHA
separately keeps this usable -- a human closing a card can see "these two agree, this third one
cannot be checked" instead of a blanket refusal that would train everyone to skip the check.

Input:  the card's comments JSON on stdin (the /api/kanban/<id>/comments shape).
        Optional argv[1]: comma-separated designated gates, e.g. "qa,cybersec".
        Omitted -> inferred from the verdicts present, and the output says so, because an
        UNSTATED designation is exactly how a missing third gate goes unnoticed.
Output: exactly one line.
        AGREE|<sha>|<details>        every designated gate's latest verdict passes, on one sha
        DISAGREE|<details>           the delta-gate hazard: latest verdicts name different shas
        FAILED|<details>             a designated gate's latest verdict is a FAIL/NO-GO
        MISSING|<details>            a designated gate has no verdict at all
        NOSHA|<details>              a latest verdict carries no Gate-SHA, so agreement is unprovable
        UNREADABLE|<why>
Exit:   0 always. The caller decides -- this is a readout, not a gate on the gate.
"""
import json
import re
import sys

GATES = ("QA", "CYBERSEC", "CYBERED")

# The verdict must be the comment's OPENING word (rule 4c), with the `Gate-SHA:` header allowed to
# come first -- both orders exist on the board and both are legitimate. Prose that merely MENTIONS
# "QA PASS" mid-sentence is not a verdict, which is why this anchors rather than searches.
_LEAD_SKIP = re.compile(r"^(?:\s*Gate-SHA:[^\n]*\n|\s*\n)*", re.IGNORECASE)
_VERDICT = re.compile(
    r"^\s*(QA|CYBERSEC|CYBERED)\s*(?:GATE|VERDICT)?\s*:?\s*(PASS|FAIL|GO|NO-GO)\b",
    re.IGNORECASE,
)
_SHA_LINE = re.compile(r"^\s*Gate-SHA:\s*([0-9a-fA-F]{7,40})", re.IGNORECASE | re.MULTILINE)

PASSING = {"PASS", "GO"}


def verdict_of(content):
    """(gate, outcome, sha) for a comment that OPENS with a verdict, else None."""
    if not isinstance(content, str):
        return None
    body = content[_LEAD_SKIP.match(content).end():]
    m = _VERDICT.match(body)
    if not m:
        return None
    sha_m = _SHA_LINE.search(content)
    outcome = m.group(2).upper()
    return (m.group(1).upper(), "NO-GO" if outcome == "NO-GO" else outcome,
            sha_m.group(1).lower() if sha_m else None)


def latest_per_gate(comments):
    """The LAST verdict each gate gave. Order is the board's own comment order.

    Deliberately not "the highest id" or a timestamp: the caller hands us the list the API returned,
    and re-sorting it here would invent an ordering the board never promised.
    """
    latest = {}
    for c in comments:
        v = verdict_of((c or {}).get("content"))
        if v:
            latest[v[0]] = v
    return latest


def shas_agree(a, b):
    """Prefix-compatible, because the board carries both short and long shas for the same commit."""
    return a == b or a.startswith(b) or b.startswith(a)


def check(comments, designated=None):
    latest = latest_per_gate(comments)
    inferred = designated is None
    if inferred:
        designated = sorted(latest.keys())
        if not designated:
            return "MISSING|no gate verdict on this card at all"
    designated = [g.upper() for g in designated]

    missing = [g for g in designated if g not in latest]
    if missing:
        return "MISSING|%s has no verdict%s" % (
            ", ".join(missing), " (gates inferred from the verdicts present)" if inferred else "")

    failed = ["%s=%s" % (g, latest[g][1]) for g in designated if latest[g][1] not in PASSING]
    if failed:
        return "FAILED|" + "; ".join(failed)

    nosha = [g for g in designated if latest[g][2] is None]
    if nosha:
        return "NOSHA|%s gave no Gate-SHA, so agreement cannot be checked (%s)" % (
            ", ".join(nosha),
            "; ".join("%s=%s" % (g, latest[g][2] or "-") for g in designated))

    shas = [latest[g][2] for g in designated]
    detail = "; ".join("%s=%s" % (g, latest[g][2]) for g in designated)
    for other in shas[1:]:
        if not shas_agree(shas[0], other):
            return "DISAGREE|the latest verdicts judge different shas: " + detail
    suffix = " (gates inferred from the verdicts present)" if inferred else ""
    return "AGREE|%s|%s%s" % (shas[0], detail, suffix)


def main():
    try:
        raw = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001 -- any unparseable body is one answer
        print("UNREADABLE|could not parse the comments JSON (%s)" % exc)
        return
    comments = raw if isinstance(raw, list) else (raw or {}).get("comments")
    if not isinstance(comments, list):
        print("UNREADABLE|unexpected response shape")
        return
    designated = None
    if len(sys.argv) > 1 and sys.argv[1].strip():
        designated = [g for g in re.split(r"[,\s]+", sys.argv[1].strip()) if g]
        unknown = [g for g in designated if g.upper() not in GATES]
        if unknown:
            print("UNREADABLE|not a gate name: %s" % ", ".join(unknown))
            return
    print(check(comments, designated))


if __name__ == "__main__":
    main()
