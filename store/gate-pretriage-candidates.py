#!/usr/bin/env python3
"""gate-pretriage-candidates.py -- pick the candidate commit SHAs a card's comments name, newest-
intent first. Extracted out of gate-pretriage-card.sh (card 34e7285e) so this selection logic is
independently testable without a live dashboard.

Input: kanban comments JSON on stdin (a list, or an object with a "comments" list -- same shape the
dashboard API returns). Output: one candidate SHA per line, most-preferred first. The caller (bash)
picks the first candidate `git` confirms is a real commit -- a card id is ALSO an 8-hex token, so
this script does not try to tell a short SHA from a card id itself.

WHY restrict to the latest REVIEW comment (card 34e7285e, real incidents 627ac234 / 11e87eee):
scanning a WHOLE comment history, then reversing collected matches by TEXT POSITION to approximate
"newest", picked the WRONG hash twice. A REVIEW that names the actual commit up front
("REVIEW -- ... @ 481ff958") but ALSO mentions an unrelated commit later in its own prose (merge-
conflict context: "this branches from before my 6525d1db landed") had the later-positioned,
unrelated hash outrank the real one -- reversal treats "appears later in THIS comment's text" as
if it meant "more recent", which is true ACROSS comments but not WITHIN one. Once the latest
REVIEW-prefixed comment is found, its own text is scanned FIRST-occurrence-wins instead: the
earliest mention is the subject, a later mention is incidental context about something else.
"""
import json
import re
import sys


def select_candidates(rows: list[dict]) -> list[str]:
    non_marker = [c for c in rows if c.get("author") != "gate-pretriage"]
    # Cybersec GO on d7ac3470 (measured, card comment 10364): a gate-pretriage comment's own
    # "@ <sha>" line is a bare hex string too, so without this exclusion it can itself become a
    # candidate -- excluded by AUTHOR, not by re-detecting the marker string in content (a content
    # check is exactly what a quoted marker defeats).
    review_rows = [c for c in non_marker if (c.get("content") or "").strip().upper().startswith("REVIEW")]
    if review_rows:
        scan_rows, first_occurrence_wins = [review_rows[-1]], True
    else:
        scan_rows, first_occurrence_wins = non_marker, False

    pref: list[str] = []
    weak: list[str] = []
    for c in scan_rows:
        txt = c.get("content") or ""
        pref += re.findall(r"(?:[Cc]ommit[:\s]+|@\s*`?)([0-9a-f]{7,40})\b", txt)
        weak += re.findall(r"\b([0-9a-f]{7,40})\b", txt)

    pref_ordered = pref if first_occurrence_wins else list(reversed(pref))
    weak_ordered = weak if first_occurrence_wins else list(reversed(weak))

    seen: set[str] = set()
    order: list[str] = []
    for s in pref_ordered + weak_ordered:  # commit-prefixed first
        if s not in seen:
            seen.add(s)
            order.append(s)
    return order


if __name__ == "__main__":
    data = json.load(sys.stdin)
    comments = data if isinstance(data, list) else data.get("comments", [])
    print("\n".join(select_candidates(comments)))
