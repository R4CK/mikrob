#!/usr/bin/env python3
"""Order the commit-SHA candidates found in a card's comments, NEWEST REVIEW FIRST (card d7ac3470).

Reads the /api/kanban/<id>/comments JSON on stdin, prints one candidate per line. The caller resolves
each against git and takes the first that is a real commit -- a card id is also an 8-hex token, so
only git can tell a short SHA from a card id.

THE BUG THIS EXISTS TO FIX. The previous inline version collected every `commit <sha>` mention across
ALL comments into one list, every bare hex into another, and tried the whole first list before the
second. That makes the WORDING outrank RECENCY: an old comment that happens to write "commit 7021f00"
beats a newer one that writes the fresh sha another way. Measured on card 63e2069c at the moment the
script actually ran: the newest REVIEW (fullstack, ce83bcf) had no `commit ` prefix, so it sat in the
weak list, while two comments from three hours earlier had the prefixed form -- and the pre-triage
ran against the pre-NO-GO commit. Same shape on 45331a93 and 2124e347 the same day.

So RECENCY IS THE PRIMARY KEY and the `commit `-prefix preference only breaks ties WITHIN one comment.

Two more sources of wrong answers, both removed here:
  - THE SCRIPT'S OWN OUTPUT. The pre-triage posts a comment naming the sha it triaged. On the next
    run that comment is just another comment full of hex, so the tool feeds itself its own stale
    answer -- visibly so on 63e2069c, where its earlier output was one more vote for 7021f00.
  - THE CARD'S OWN ID, which appears in nearly every comment and is 8 hex like any short sha.

Timestamps are sorted EXPLICITLY rather than trusting the API's order. It happens to return comments
oldest-first today, but nothing promises that, and this whole class of bug is what a trusted-but-
unstated ordering costs.
"""
import json
import os
import re
import sys

COMMIT_PREFIXED = re.compile(r"[Cc]ommit[:\s]+([0-9a-f]{7,40})\b")
BARE_HEX = re.compile(r"\b([0-9a-f]{7,40})\b")


def candidates(rows, card_id="", marker=""):
    """Yield candidate SHAs, newest comment first, commit-prefixed first within each comment."""
    # Explicit sort; `created_at` missing sorts last (treated as oldest) rather than crashing.
    ordered = sorted(rows, key=lambda c: c.get("created_at") or 0, reverse=True)
    card = (card_id or "").lower()
    out, seen = [], set()
    for c in ordered:
        text = c.get("content") or ""
        # Skip the tool's OWN previous output: its sha is an answer, not evidence.
        if marker and marker in text:
            continue
        pref = COMMIT_PREFIXED.findall(text)
        weak = BARE_HEX.findall(text)
        # Within one comment the LAST mention wins -- a comment that corrects itself ("...was abc,
        # the real one is def") ends on the answer.
        for sha in list(reversed(pref)) + list(reversed(weak)):
            s = sha.lower()
            if s == card or s in seen:
                continue
            seen.add(s)
            out.append(s)
    return out


def main():
    card_id = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CARD", "")
    marker = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("MARKER", "")
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0  # unreadable input is "no candidates", never a crash in a scheduled path
    rows = payload if isinstance(payload, list) else payload.get("comments", [])
    if not isinstance(rows, list):
        return 0
    for sha in candidates(rows, card_id, marker):
        print(sha)
    return 0


if __name__ == "__main__":
    sys.exit(main())
