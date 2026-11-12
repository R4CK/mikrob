#!/usr/bin/env python3
"""Read a card's comments (JSON on stdin) and print the Gate-SHA(s) from its LATEST REVIEW.

Card 507e8167: marveen-land.sh's --card mode trusted a local `card/<id>` ref's content to decide
"already fully landed" (branch tip is an ancestor of origin/develop) without ever checking that the
ref actually points at the commit the card's own REVIEW claims to be landing. A stale/leftover
`card/<id>` ref pointing at an old, unrelated, already-landed commit satisfied that ancestor check
and the landing silently no-opped -- reported "already landed" on a card whose real gated commit
was never pushed.

This mirrors landing-gate-verdict-parse.py's Gate-SHA line parsing, but answers a different
question: not "does a verdict cover sha X", but "what sha does this card's own latest REVIEW name".
Rule 4c: the verdict word is a comment's first line; the REVIEW comment is written by the engineer
BEFORE any gate speaks (rule 4), so "latest REVIEW" is well-defined even once gate verdicts follow.

Usage:  landing-review-gate-sha-parse.py < comments.json
Prints exactly one line: OK|<sha>[,<sha>...]   or   NONE|<reason>
"""
import json
import re
import sys

GATE_SHA_LINE = re.compile(r"^\s*Gate-SHA:\s*(.+)", re.I)
HEX = re.compile(r"[0-9a-f]{7,40}", re.I)
REVIEW_FIRST_LINE = re.compile(r"^REVIEW\b", re.I)


def shas_in(text):
    found = []
    for line in text.split("\n"):
        m = GATE_SHA_LINE.match(line)
        if m:
            for tok in HEX.findall(m.group(1)):
                if tok.lower() not in found:
                    found.append(tok.lower())
    return found


def main():
    try:
        doc = json.load(sys.stdin)
    except Exception as exc:
        print(f"NONE|unreadable: {exc}")
        return 0
    comments = doc.get("comments", doc) if isinstance(doc, dict) else doc
    if not isinstance(comments, list):
        print("NONE|unexpected response shape")
        return 0

    # Comments come back in creation order (oldest first), same as every other reader in this
    # tree (landing-gate-verdict-parse.py included) assumes -- so the LAST match below is the
    # latest REVIEW, not the first.
    latest_shas = None
    for c in comments:
        if not isinstance(c, dict):
            continue
        text = (c.get("content") or "").strip()
        first = text.split("\n")[0].strip()
        if REVIEW_FIRST_LINE.match(first):
            shas = shas_in(text)
            if shas:
                latest_shas = shas

    if latest_shas:
        print("OK|" + ",".join(latest_shas))
    else:
        print("NONE|no REVIEW comment with a Gate-SHA line found")
    return 0


if __name__ == "__main__":
    sys.exit(main())
