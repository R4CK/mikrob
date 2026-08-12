#!/usr/bin/env python3
"""Order the commit-SHA candidates found in a card's comments, NEWEST FIRST (card d7ac3470, card
34e7285e). Reads the /api/kanban/<id>/comments JSON on stdin, prints one candidate per line. The
caller resolves each against git and takes the first that is a real commit -- a card id is also an
8-hex token, so only git can tell a short SHA from a card id.

TWO REAL INCIDENT CLASSES, both fixed here:

(1) RECENCY BEATS WORDING (card d7ac3470, incidents 63e2069c/45331a93/2124e347). The original inline
version collected every `commit <sha>` mention across ALL comments into one list, every bare hex into
another, and tried the whole first list before the second -- so an OLD comment that happens to write
"commit X" beat a NEWER comment naming the fresh sha some other way (e.g. a plain "Javitva: X" follow-
up after a NO-GO, which is exactly the fleet's own correction convention). Fix: sort comments by
`created_at` EXPLICITLY (nothing promises the API's return order; missing timestamp sorts last, never
crashes), and walk them newest-first.

(2) WITHIN one comment, a REVIEW's own later prose can name an UNRELATED commit for context (card
34e7285e, incidents 627ac234/11e87eee): "REVIEW -- @ 481ff958 ... this branches from before my
593743cb landed" -- the old "last mention in a comment wins" rule (meant for self-correcting comments
like "commit X -- javitva: commit Y") let the later, unrelated hash outrank the real subject named up
front. A REVIEW comment front-loads its answer; a later mention in the SAME comment is incidental
context about something else. A plain follow-up comment (no REVIEW prefix) still uses last-mention-
wins, because THAT shape is where a genuine self-correction ends on the answer. So: within a comment
whose (stripped) text starts with "review" (case-insensitive) -> FIRST occurrence wins; every other
comment -> LAST occurrence wins, as before.

Also removed, both incident classes:
  - THE SCRIPT'S OWN OUTPUT. The pre-triage posts a comment naming the sha it triaged; left in the
    corpus that is one more vote for a stale answer on the next run. Excluded by AUTHOR
    (author == "gate-pretriage"), unconditionally -- not by re-detecting the marker string in
    content, which a REAL review that quotes a prior comment (the fleet's own convention when
    responding to/correcting one) would ALSO match, resurrecting the same bug via a different
    trigger (Cybersec, card d7ac3470 follow-up). The MARKER argument is accepted for CLI-compat but
    no longer changes this exclusion -- author is the only signal that cannot be spoofed by content.
  - THE CARD'S OWN ID, which appears in nearly every comment and is 8 hex like any short sha.
"""
import json
import os
import re
import sys

# `commit <sha>` (the REVIEW/JAVITVA convention) is a strong, prefixed mention everywhere. `@ <sha>` /
# `@ `<sha>`` (the "REVIEW -- card @ sha" convention this fleet also uses) is ALSO strong, but ONLY
# inside a REVIEW-prefixed comment -- the pre-triage tool's OWN marker line has the same "@ <sha>"
# shape ("GATE PRE-TRIAGE (...) @ <sha>"), so trusting "@" as strong everywhere lets a REAL comment
# that quotes the marker (to correct/respond to it, the fleet's own convention) have the quoted, stale
# sha outrank its own later, genuine fix mention -- the same class of bug the author-exclusion above
# exists to close, via a different trigger. Measured with a mutation control (someone-else quotes the
# marker, then states the real fix): without this restriction the quoted "@ <sha>" wins; with it, the
# comment is not REVIEW-prefixed so only "commit " counts as strong there, and last-mention-wins
# correctly picks the real, later fix.
COMMIT_PREFIXED = re.compile(r"[Cc]ommit[:\s]+([0-9a-f]{7,40})\b")
REVIEW_PREFIXED = re.compile(r"(?:[Cc]ommit[:\s]+|@\s*`?)([0-9a-f]{7,40})\b")
BARE_HEX = re.compile(r"\b([0-9a-f]{7,40})\b")


def candidates(rows, card_id="", marker=""):
    """Yield candidate SHAs, newest comment first; within a REVIEW-prefixed comment the FIRST
    mention wins, within any other comment the LAST mention wins."""
    del marker  # CLI-compat only (see module docstring) -- the exclusion below is author-only now.
    # Explicit sort; `created_at` missing sorts last (treated as oldest) rather than crashing.
    ordered = sorted(rows, key=lambda c: c.get("created_at") or 0, reverse=True)
    card = (card_id or "").lower()
    out, seen = [], set()
    for c in ordered:
        # Skip the tool's OWN previous output unconditionally by author -- see module docstring.
        if c.get("author") == "gate-pretriage":
            continue
        text = c.get("content") or ""
        is_review = text.strip().upper().startswith("REVIEW")
        pref = (REVIEW_PREFIXED if is_review else COMMIT_PREFIXED).findall(text)
        weak = BARE_HEX.findall(text)
        # A REVIEW comment front-loads its answer -- first mention wins. Any other comment (a plain
        # follow-up/self-correction) ends on its answer -- last mention wins.
        ordered_pref = pref if is_review else list(reversed(pref))
        ordered_weak = weak if is_review else list(reversed(weak))
        for sha in ordered_pref + ordered_weak:  # commit-prefixed first within the comment
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
