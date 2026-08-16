#!/usr/bin/env python3
"""Order the commit-SHA candidates found in a card's comments, NEWEST FIRST (card d7ac3470, card
34e7285e). Reads the /api/kanban/<id>/comments JSON on stdin, prints one candidate per line. The
caller resolves each against git and takes the first that is a real commit -- a card id is also an
8-hex token, so only git can tell a short SHA from a card id.

SEVERAL REAL INCIDENT CLASSES, all fixed here:

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

(3) THE "REVIEW"-ONLY CHECK MISSED THE FLEET'S OTHER FRONT-LOADED COMMENTS (card ce159d2b, incident
57112049). QA/Cybersec/Cybered verdicts use the SAME front-loaded "<VERDICT> -- <card> @ `<sha>`"
shape as a REVIEW (e.g. "CYBERSEC GO -- 57112049 @ `fea51c4` ... nem a pretriage altal kiirt
`6199f0b`-t"), but is_review only matched a comment starting with the literal word "review" -- so a
verdict comment fell through to last-mention-wins, and a card-id or unrelated sha named later in the
verdict's own prose (here: 746ea4e4, a DIFFERENT card referenced for context) outranked the real
subject sha named up front. Fix: FRONT_LOADED recognizes the review/QA/Cybersec/Cybered verdict
prefixes as one class -- all front-load their answer, so all get first-mention-wins.

(4) THE CONVENTION ITSELF IS NOT UNIVERSAL (card 2dd93b53, Cybered). REVIEW is this fleet's
convention, but not every engineering agent uses that exact word: card ac7d5530's own REVIEW-
equivalent close was "KÉSZ: 6 US story API-szinten verifikálva ..." -- a real, observed comment, not
a hypothetical -- which FRONT_LOADED (REVIEW-only at the time) missed entirely, falling through to
last-mention-wins and nearly picking an unrelated commit named later in that same comment. Widened to
recognize the fleet's other completion markers as the SAME front-loaded class: KÉSZ/KESZ (accented or
not -- both are seen in the wild), DONE, ELKÉSZÜLT/ELKESZULT, and the BEFEJEZ- stem (BEFEJEZVE,
BEFEJEZTEM, ...). This is a robustness net, not a license to skip the convention: agents should still
use REVIEW so a human scanning the board sees one consistent word; this only means the TOOLING no
longer silently mis-triages a card when someone doesn't.

(5) AN EXPLICIT LABEL LOST TO A WEAKER MENTION, TWICE IN ONE EVENING (card d9a57239). Front-loaded
comments (tier: is_review) used to treat "commit X" and "@ X" as EQUALLY strong, breaking ties by
TEXT POSITION -- so an early, merely-contextual "@ <sha>" (e.g. quoting a past incident's example
sha while explaining a fix) outranked a later, deliberate "Commit: X" trailer (011b3f89: quoted
"cybered GO @596f0f15" from the 25083c6f incident write-up beat the real "Commit: 26ea788").
SEPARATELY, this fleet's own "Commitok: a/b/c." multi-commit trailer (plural, listing several
commits chronologically) never matched the singular-only commit-colon-or-space pattern at all --
"commit" immediately followed by "ok:" is not ":"/whitespace -- so it fell all the way to the
bare-hex tier and picked the FIRST (oldest) commit in the list instead of the last (3f6bcc41:
"Commitok: bbbed68/.../5467c0f." picked bbbed68, the very first WIP commit, not the final one).
Fixed with EXPLICIT_LABEL (tier 1, singular+plural, list-aware -- takes the LAST sha within each
occurrence's own list) that ALWAYS outranks AT_MENTION (tier 2, front-loaded only) and BARE_HEX
(tier 3), regardless of front-loaded status or text position.

(6) A "+"-JOINED TWO-COMMIT MENTION LOST TO ITS OWN FIRST HALF (card bb15a712). This fleet's own
post-gate-fix convention -- a plain follow-up naming two commits without the "Commit:" label, e.g.
"posztoltam ket commitot (e6097b6 + 4152268)" -- used the "+" character to join the two shas, but
EXPLICIT_LABEL's separator class only allowed whitespace/slash/comma between list tokens. "+" broke
the match right after the FIRST sha, so the label only ever captured "e6097b6" and _explicit_label_shas
picked THAT as the answer, even though "4152268" (the real final commit, fixing a regression in the
first) was named later in the very same sentence. Real incident (1f51f050): "commit e6097b6 + 4152268
(a mar attekintett 917fd71 utan)" picked e6097b6, not 4152268. Fixed by adding "+" to the separator
class -- the existing "last token in an explicit-label's own list wins" rule (see incident 5 above)
then does the rest; no new ranking logic needed, just a wider list-separator.

(7) THE STATED "Gate-SHA:" VALUE LOST TO A BARE PROSE MENTION (card 31eaa323, real incident a8b94a18).
The fleet's rule 4b introduced a dedicated "Gate-SHA: <sha>" line, AT THE START OF A LINE, specifically
so the reviewer never has to guess again -- the whole point is that it is a STATED value, not a
heuristic. But this script never recognised "Gate-SHA:" as a label at all, so the sha on that line fell
all the way to BARE_HEX (tier 3, weakest) while an unrelated "commit 99d54d01" named in the SAME
comment's own prose (referring to a completely different, older card, 165ff1af) matched EXPLICIT_LABEL
(tier 1) and outranked it -- the exact opposite of what the stated-value convention was introduced to
guarantee, and a silent false-positive precisely because it LOOKS like the precise sha is being used.
Fixed with GATE_SHA_LINE, a new tier 0 that outranks everything (including EXPLICIT_LABEL) and, per
the card's own instruction, is EXCLUSIVE within a comment where it is present -- every other tier is
skipped for that comment, not merely ranked below it, so a stray "commit X" elsewhere in the same
REVIEW can never leak through. Anchored on `^` (with MULTILINE) so a mid-sentence discussion of the
convention itself ("... a Gate-SHA sor ...") does not accidentally count -- exactly the property rule
4b's own wording relies on ("igy lehet rola beszelni anelkul, hogy gate-et ebresztene").

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

# THREE tiers, strongest first, ALL applied within a comment regardless of whether it is
# front-loaded (see candidates() for how front-loaded vs not changes which OCCURRENCE wins,
# not whether a tier is used at all):
#
# TIER 1 -- EXPLICIT_LABEL: a "commit"/"commitok" (Hungarian plural) label followed by one or
# more sha tokens. This is the strongest, most deliberate signal an agent can give -- and, per
# card d9a57239, it must win even inside a REVIEW/verdict comment where it appears LATER than a
# weaker "@ <sha>" mention. Real incident (011b3f89): "...cybered GO @596f0f15 (quoting an OLD
# incident's example sha, mid-explanation)...Commit: 26ea788." used to pick 596f0f15, because the
# old code treated "@ <sha>" as EQUALLY strong as "Commit: <sha>" and broke ties by position
# within a front-loaded comment. An explicit label now always outranks a bare "@" mention.
#
# When a label is followed by a LIST of shas (this fleet's own multi-commit convention, e.g.
# "Commitok: aaa/bbb/ccc.") the LAST sha in that list is the answer -- commits are listed
# chronologically, oldest first. Real incident (3f6bcc41): "Commitok: bbbed68/.../5467c0f."
# used to pick bbbed68 (the FIRST, earliest commit) because it fell through to the bare-hex tier
# entirely -- "commit" immediately followed by "ok:" (not ":"/whitespace) never matched the old,
# singular-only COMMIT_PREFIXED pattern at all.
#
# Separator class includes "+" (card bb15a712, incident 6 above): this fleet's own post-gate-fix
# comments join two commits with "+" ("commit X + Y"), not just "/"/","/whitespace.
EXPLICIT_LABEL = re.compile(r"\b[Cc]ommit(?:ok)?\b[:\s]+((?:[0-9a-f]{7,40}[\s/,+]*)+)")
SHA_TOKEN = re.compile(r"[0-9a-f]{7,40}")

# TIER 2 -- AT_MENTION: `@ <sha>` / `@ `<sha>`` (the "REVIEW -- card @ sha" convention this fleet
# also uses). Weaker than an explicit label (tier 1), stronger than a bare token (tier 3), and
# ONLY consulted inside a front-loaded comment -- the pre-triage tool's OWN marker line has this
# same "@ <sha>" shape ("GATE PRE-TRIAGE (...) @ <sha>"), so trusting "@" as strong in a PLAIN
# (non-front-loaded) comment lets a REAL comment that quotes the marker (to correct/respond to
# it, the fleet's own convention) have the quoted, stale sha outrank its own later, genuine fix
# mention -- the same class of bug the author-exclusion above exists to close, via a different
# trigger. Measured with a mutation control (someone-else quotes the marker, then states the real
# fix): without this restriction the quoted "@ <sha>" wins; restricted to front-loaded comments,
# a plain follow-up quoting the marker falls to tier 3 (last-mention-wins) and correctly picks the
# real, later fix instead.
AT_MENTION = re.compile(r"@\s*`?([0-9a-f]{7,40})\b")

# TIER 3 -- BARE_HEX: anything else. The weakest signal, used only when tiers 1-2 found nothing.
BARE_HEX = re.compile(r"\b([0-9a-f]{7,40})\b")

# TIER 0 -- GATE_SHA_LINE: the fleet's rule-4b "Gate-SHA: <sha>" line, anchored at the START of a
# line (MULTILINE `^`) so a mid-sentence discussion of the convention never matches (see incident
# class 7 above). Stronger than EXPLICIT_LABEL and, per the dispatching card, EXCLUSIVE within a
# comment where it appears -- see candidates() below. Same list convention as EXPLICIT_LABEL (rule
# 4b: "tobb commitnal `Gate-SHA: <sha>, <sha>`") -- last token in the line's own list wins.
GATE_SHA_LINE = re.compile(
    r"^\s*Gate-SHA:\s*((?:[0-9a-f]{7,40}[\s/,+]*)+)", re.IGNORECASE | re.MULTILINE
)

# The fleet's front-loaded, subject-naming comment shapes -- a REVIEW is only ONE of them. QA/Cybersec/
# Cybered verdicts use the identical "<VERDICT> -- <card> @ `<sha>`" convention (card ce159d2b,
# incident 57112049: "CYBERSEC GO -- 57112049 @ `fea51c4` ... nem a pretriage altal kiirt `6199f0b`-t"
# fell through to last-mention-wins because it does not start with the word "review", so the LATER,
# unrelated-card mention outranked the real subject sha named up front). Anchored at the start (after
# stripping) so a comment merely discussing a past verdict mid-text is not swept in.
#
# ALSO the fleet's OTHER completion markers (card 2dd93b53, Cybered), not just REVIEW: KÉSZ/KESZ (an
# observed real close, card ac7d5530 -- "KÉSZ: 6 US story API-szinten verifikálva ..."), DONE,
# ELKÉSZÜLT/ELKESZULT, and the BEFEJEZ- stem (BEFEJEZVE, BEFEJEZTEM, ...). Same reasoning as the
# verdict class above: whichever word an agent's completion comment actually starts with, that
# comment front-loads its answer, so first-mention-wins applies the same way.
#
# (6) THE BEFEJEZ- STEM ALSO MATCHED ITS OWN NEGATION (card 9a2090eb, Cybered's side-finding on
# 2dd93b53). BEFEJEZ\w* has to end in \w* to cover Hungarian conjugation (BEFEJEZVE, BEFEJEZTEM,
# BEFEJEZTÜK) -- and that same \w* swallowed BEFEJEZETLEN ("unfinished") and BEFEJEZETLENÜL, which
# mean the OPPOSITE of a completion marker. Cybered's own probe: FRONT_LOADED matched
# "Befejezetlen, meg dolgozom rajta -- ne triazsold".
#
# Excluded by DERIVING the family, not by listing words: Hungarian forms this negation with the
# -tlan/-tlen suffix, which on this stem always surfaces as ...ETLEN (befejezETLEN,
# befejezetlenÜL, befejezetlenSÉG, and with the potential suffix befejezhETETLEN). So the lookahead
# rejects any continuation containing ETLEN rather than naming the inflections -- a word list here
# would be incomplete again the first time someone writes a form nobody thought of. No positive
# form of this stem contains ETLEN, so nothing legitimate is lost.
FRONT_LOADED = re.compile(
    r"^(?:REVIEW|QA\s+(?:PASS|FAIL)|CYBER(?:SEC|ED)\s+(?:GO|NO-GO)|"
    r"K[ÉE]SZ|DONE|ELK[ÉE]SZ[ÜU]LT|BEFEJEZ(?!\w*ETLEN)\w*)\b",
    re.IGNORECASE,
)


def _gate_sha_line_shas(text):
    """Resolved sha(s) from every rule-4b 'Gate-SHA:' line in the text, in the order the lines
    appear -- each line resolved to the LAST sha in ITS OWN list, same convention as
    _explicit_label_shas. Non-empty only when the comment actually contains such a line."""
    out = []
    for m in GATE_SHA_LINE.finditer(text):
        tokens = SHA_TOKEN.findall(m.group(1))
        if tokens:
            out.append(tokens[-1])
    return out


def _explicit_label_shas(text):
    """One resolved sha per EXPLICIT_LABEL occurrence, in the order the labels appear in the
    text -- each occurrence already resolved to the LAST sha in ITS OWN list (card d9a57239's
    "commits are listed oldest-first" convention), regardless of front-loaded status."""
    out = []
    for m in EXPLICIT_LABEL.finditer(text):
        tokens = SHA_TOKEN.findall(m.group(1))
        if tokens:
            out.append(tokens[-1])
    return out


def candidates(rows, card_id="", marker=""):
    """Yield candidate SHAs, newest comment first. If a comment contains a rule-4b "Gate-SHA:" line
    (tier 0), that line is the EXCLUSIVE source for the comment (card 31eaa323) -- no other tier is
    even consulted. Otherwise three tiers apply in order (explicit label > @-mention > bare hex --
    see the tier comments above); within a front-loaded comment (REVIEW, or a QA/Cybersec/Cybered
    verdict) the FIRST occurrence of a tier wins, within any other comment the LAST occurrence wins.
    Tier 1 (explicit label) ALWAYS outranks tiers 2-3 regardless of front-loaded status or text
    position (card d9a57239) -- an explicit "Commit: X" is a deliberate statement, not a hash
    mentioned in passing."""
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
        is_review = FRONT_LOADED.match(text.strip()) is not None

        # TIER 0 (card 31eaa323): a stated "Gate-SHA:" line is EXCLUSIVE for this comment -- every
        # other tier is skipped entirely, not merely outranked, so a stray "commit X" elsewhere in
        # the same comment's own prose can never leak through (the a8b94a18 incident).
        gate_sha = _gate_sha_line_shas(text)
        if gate_sha:
            tier_candidates = gate_sha
        else:
            explicit = _explicit_label_shas(text)
            at_mentions = AT_MENTION.findall(text) if is_review else []
            weak = BARE_HEX.findall(text)
            # A front-loaded comment states its answer up front -- first occurrence wins within a
            # tier. Any other comment (a plain follow-up/self-correction) ends on its answer -- last
            # occurrence wins. AT_MENTION is only ever consulted for front-loaded comments (see its
            # own comment above), so it needs no separate branch here.
            ordered_explicit = explicit if is_review else list(reversed(explicit))
            ordered_weak = weak if is_review else list(reversed(weak))
            tier_candidates = ordered_explicit + at_mentions + ordered_weak

        for sha in tier_candidates:  # strongest tier first
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
