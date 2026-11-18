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

WHY `--expect` EXISTS, measured in production (cards c458ba0e/acab6155/f8b52ff2, 2026-09-04). This
script asks ONE question -- do the designated gates agree with EACH OTHER? -- and after a card's work
is rebuilt, rebased or cherry-picked, BOTH old verdicts still name the same OLD sha. They agree
perfectly, so this printed `AGREE|6bb97eba` for code that no longer existed anywhere, while the
rebuilt deliverable was 80de05f5. The original hazard was gates judging DIFFERENT shas; this is gates
judging the WRONG one in agreement -- and rule 4a's closure step reads AGREE as "safe to close".
The script was not lying, it answered a narrower question than the caller was really asking.

WHY `--expect` IS NOW A DEFAULT, NOT A FLAG (card 2003e04b). Cybered demonstrated the flaw within
minutes of the flag landing: they ran the check WITHOUT `--expect` on e80c011a and got a false AGREE
on a sha the card had already moved off. A protection that only protects the callers who remember it
is not a protection. So when the caller passes no `--expect`, the expectation is read from the card
itself: the LATEST comment that opens with `REVIEW` and carries a `Gate-SHA:` line. Explicit
`--expect` still wins; `--no-expect` restores the pre-2003e04b behaviour exactly.

WHY THE COMPARISON IS NOT SHA EQUALITY, measured over the whole board before building it. Cybered's
plan-grilling offered two ways to compute the default and predicted that reading it from the REVIEW
would need no further care ("definicio szerint egyezik a verdiktekkel, nincs hamis STALE"). Measured,
that is not so. Of 557 cards this script calls AGREE today, 38 have a latest-REVIEW sha that differs
from the sha the gates judged -- and 23 of those 38 are provably benign:

  10  the two shas hold byte-identical content for every file the card delivered
  13  they differ ONLY in package.json (every landing bumps the version), DECISIONS.md or README.md
      (append-only, and other agents append between the work commit and the landing)
  14  a real difference in the card's own files  <- the only population worth a human
   1  neither sha resolves in either clone any more

Shipping sha equality would therefore have cried wolf on 6.8% of closures, three fifths of them
falsely, which is how an alarm gets trained away. So a mismatch is not the answer -- it is the
QUESTION, and it is answered the way Cybered's second option said to answer it: resolve both shas to
a clone (store/gate-sha-repo.sh, by lookup, not by declaration) and compare the CONTENT of the files
the declared commit touched. Identical means the gates saw this card's work whatever the sha was
called. A commit that cannot be resolved is its own answer, never a silent AGREE.

WHY A MULTI-SHA `Gate-SHA:` LINE COMPARES BY SET, NOT BY FIRST TOKEN (card f53ef8e4, Cybersec).
Rule 4b lets one line name several commits ("<sha>, <sha>"), and this script used to keep only the
FIRST one a verdict wrote. Two gates that both delta-gated the same pair but wrote the tokens in a
different order, or led with a different one, got a false DISAGREE even though their sets actually
intersected on the sha that mattered -- fail-closed direction (never a false AGREE), but a false
block on real fleet infrastructure that lives in this same file, the population the c52e2823 round
already closed for a different reason. `verdict_of()` now keeps every token on the line as a tuple;
`sha_sets_agree()` treats two verdicts as agreeing if ANY pair of their tokens is prefix-compatible.
The sibling tool (`landing-gate-verdict-parse.py`, `shas_in()`) already collected every token this
way for its own per-sha check -- this file just did not.

WHY A NON-REVIEW COMMENT'S Gate-SHA CAN STILL SINK AN AGREE (card 3e4dc2c3, Cybered). declared_shas()
deliberately reads ONLY the latest `REVIEW`-opening comment, because sourcing it from any Gate-SHA
line nets zero (fixes 8 cards, breaks 8 -- see that function's own docstring). But a builder's
routine "<finding> JAVITVA -- delta-gate kell" declares a newer commit WITHOUT the word REVIEW, so
declared_shas() correctly never sees it -- and if no designated gate verdicts on that newer sha
either, the default AGREE (built from the OLD REVIEW's sha, which is genuinely all declared_shas()
can see) is checking code nobody who matters has reviewed. Measured: 8 of 14 cards with this shape
read AGREE by default while `--expect <the newer sha>` on the SAME card answers STALE -- the
default answers a narrower question than the caller is asking, without saying so, the exact failure
shape `--expect` itself exists to close (see that section above). `undeclared_post_review_shas()`
answers the narrower question explicitly: a sha declared after the latest REVIEW that neither that
REVIEW nor any gate verdict in the same span names turns the REVIEW-sourced default into STALE
rather than a silent AGREE. Deliberately scoped to the default path only -- an explicit `--expect`
is the caller's own assertion and is not second-guessed by this.

WHY AN INFERRED GATE SET IS NEVER TRUSTED OVER A STATED ONE, AND NEVER OMITS QA (card 864351a9,
Cybersec). When the caller passes no gate list, this script has always inferred one from whichever
verdicts are PRESENT (`sorted(latest.keys())`) -- and a lone security-gate verdict then read as
"every designated gate agrees", a verdict agreeing with itself, because rule 4's QA-is-mandatory
requirement was never enforced on the INFERRED side. Measured live: 2 of 307 `done` cards closed
this way, on a gate that was not even the one MikroB actually designated -- the designation was
right there on the card, in a `MikroB GATE-KIJELOLES: <gates> (<n>-gate) -- <reason>` comment
(the live convention, comments 19882/19898), unread by this file. Two independent fixes, not one:
`stated_designation()` reads that comment and, when present, OUTRANKS inference entirely (the same
precedence a stated `Gate-SHA:` already has over a guessed one); and when there is genuinely no
stated designation, the inferred set is now seeded with QA even if no QA verdict exists, so a
QA-less inferred set answers MISSING rather than a self-agreeing AGREE.

WHY AGREEING VERDICTS ARE NOT ENOUGH: THE WORK MUST BE ON THE MAIN BRANCH (card e65c480a, founding
case measured 2026-09-12 on card 667e809b). Every question above is about the CONSISTENCY of the
verdicts -- with each other, and with the sha the card declares. None of them asks whether that sha
ever shipped. 667e809b was closed on a perfectly consistent QA PASS whose commit (be6964eb) was not
an ancestor of origin/main: the fix lived only on a branch, and main stayed red on the very defect
the card had just closed -- measured, not inferred, by a full suite that finished after the closure
and reported that exact one failure. This is RELATED TO BUT NOT THE SAME AS the STALE check: STALE
catches a verdict aimed at an OLDER sha than the card now delivers; here the verdict named exactly
the right sha, and that sha simply never reached main. The test is `merge-base --is-ancestor`, never
sha equality: both landers merge --no-ff, so a correctly landed commit is an ANCESTOR of the branch
tip and never equal to it.

Input:  the card's comments JSON on stdin (the /api/kanban/<id>/comments shape).
        Optional argv[1]: comma-separated designated gates, e.g. "qa,cybersec".
        Optional --expect <sha>: the commit this card delivers NOW. Omitted -> taken from the
        card's latest REVIEW `Gate-SHA:` line; `--no-expect` disables the check entirely.
        Optional --no-landed: skip the "is it on the main branch" check (card e65c480a). For a
        caller that has no clones, or is deliberately asking only about verdict consistency.
        Optional --card <id>: also check card_landings for an authoritative row naming the judged
        sha (card 634a188c). Omitted -> only the git-ancestry check runs, exactly as before this
        card. A card whose latest REVIEW/comment carries a line-initial `Landing: n/a` is exempt
        from BOTH the card_landings and the git-ancestry checks (no code to land).
        Optional argv[1] gates omitted -> inferred from the verdicts present, and the output says
        so, because an UNSTATED designation is exactly how a missing third gate goes unnoticed.
Output: exactly one line.
        AGREE|<sha>|<details>        every designated gate's latest verdict passes, on one sha
        DISAGREE|<details>           the delta-gate hazard: latest verdicts name different shas
        FABRICATED|<sha>|<why>       (--card-id/--db only) the REVIEW's declared sha does not
                                     exist as a commit object in any known repo at all -- not a
                                     checkpoint gap (CHECKPOINT_FAIL), a hand-typed or
                                     hallucinated sha that was never a real commit anywhere
                                     (card 14bfc893).
        FAILED|<details>             a designated gate's latest verdict is a FAIL/NO-GO
        MISSING|<details>            a designated gate has no verdict at all
        NOSHA|<details>              a latest verdict carries no Gate-SHA, so agreement is unprovable
        UNSUPERSEDED|<gates>|<whos>|<details>
                                     a refusal stands that carries no Gate-SHA, so no later PASS can
                                     be shown to supersede it: either a relayed refusal still open,
                                     or an acknowledgement of one the gate has since answered. The
                                     tool cannot tell, and says so instead of guessing. Neither
                                     closable (AGREE) nor automatically bounced (FAILED) -- MikroB or
                                     a human decides. Gates and speakers pair up by position.
        UNVERIFIED-AUTHOR|<details>  a gate's PASS was written by someone other than that gate, and
                                     that gate never posted one itself
        STALE|<sha>|<expected>|<why> the gates AGREE, but on a commit whose content differs from the
                                     one this card now declares -- OR (card 3e4dc2c3) a non-REVIEW
                                     comment after the latest REVIEW declared a newer commit that no
                                     designated gate ever verdicted on; <expected> then lists the
                                     undeclared sha(s) instead of a single REVIEW-declared one
        UNRESOLVED|<sha>|<expected>|<why>
                                     the shas differ and the difference could NOT be judged (a clone
                                     is missing, a commit was pruned, git failed). Deliberately not
                                     AGREE: "cannot check" is not "checked and fine".
        UNLANDED|<sha>|<why>         the gates agree on a commit that is NOT an ancestor of the
                                     clone's main branch, so the approved work exists only on a
                                     branch -- or the question could not be answered at all (no
                                     clone holds the commit, the ref does not resolve, git failed),
                                     which is fail-closed for the same reason UNRESOLVED is. The
                                     `why` says which of the two. `--no-landed` disables the check.
        NOT-LANDED|<sha>|<why>       (needs --card) card_landings carries no row for this card
                                     naming the judged sha -- either no row at all, or rows exist
                                     for other work. Stronger than UNLANDED: nothing but a real
                                     marveen-land.sh/mopsion-land.sh run writes a row, so this
                                     cannot be fooled by a sha that merely happens to resolve in a
                                     clone. Checked BEFORE the git-ancestry check and short-circuits
                                     it; a `landed` row does not skip the git check that follows.
        UNREADABLE|<why>
Exit:   0 always. The caller decides -- this is a readout, not a gate on the gate.
"""
import json
import os
import re
import subprocess
import sys

# The role names and the author->role fold both live in gate_author_role.py, so that the tool
# which PERMITS a landing and this one, which only advises, cannot drift apart (card 48b0dd36).
from gate_author_role import GATE_ROLES, author_role, canonical_gate  # noqa: E402  (sits with the constants it defines)
# Card ec34c025 (ed332869 rescope point 5): the verdict-token vocabulary (VERDICT_RE, PASSING) and
# the sha-equivalence machinery (content_verdict + its clone/git helpers) used to be defined inline
# here; both now live in their own modules so a future importer (the heartbeat sweeps already get
# this one via subprocess; the other verdict-token copies named in that module's own docstring are
# separate, later cards) reads the SAME source instead of growing another copy.
from gate_verdict_tokens import VERDICT_RE as _VERDICT, PASSING  # noqa: E402
from sha_content_equivalence import (  # noqa: E402
    _SHARED_CHURN, _MAIN_REF_OVERRIDE, _git, _CLONES, _GIT_TIMEOUT,
    shas_agree, sha_sets_agree, _clone_holding, _clone_and_ref_holding,
    _is_version_bump, _bump_parent_hint, content_verdict,
)

GATES = GATE_ROLES

# A gate ROLE may be staffed by more than one agent. Rule 4 requires load-balancing between
# same-capability gate siblings (today QA/QA2; CYBERSEC2/CYBERED2 are named as future ones), and
# only ONE of a pair reviews a given card. So a sibling's verdict IS that role's verdict, and the
# trailing digits are dropped rather than producing a separate gate key -- keying "QA2" apart from
# "QA" would report the QA gate MISSING on every card QA2 signed off, which is the bug being fixed.


# The verdict must be the comment's OPENING word (rule 4c), with the `Gate-SHA:` header allowed to
# come first -- both orders exist on the board and both are legitimate. Prose that merely MENTIONS
# "QA PASS" mid-sentence is not a verdict, which is why this anchors rather than searches.
#
# `Skills:` is ALSO skipped (card 507e8167 round 2, CYBERSEC NO-GO 29485 point 1). The karpathy
# loop convention (backend CLAUDE.md step 8) puts `Gate-SHA:` first, `Skills:` second, THEN the
# REVIEW text -- measured live on 0120d19a/4f3c0287 (comments 29254/29461: "Gate-SHA: ...\nSkills:
# karpathy-guidelines\n\nREVIEW for ..."). Without this, `_REVIEW_OPEN` landed on the literal
# string "Skills: ..." after the Gate-SHA line was skipped, never matched, and declared_shas()
# silently returned [] for exactly these REVIEWs -- this file's own `main()` happens to fall back
# to the gate verdicts' own Gate-SHA in that case (see the `if not declared` branch), which is why
# it was never noticed here; a caller with no verdict to fall back to (card 507e8167's new
# landing-review-gate-sha-parse.py) has nothing to fall back to and got a bare NONE instead. Never
# applies to `verdict_of()`'s match: rule 4c fixes the verdict word as the comment's absolute first
# line, so a verdict comment never has `Skills:` before it.
_LEAD_SKIP = re.compile(r"^(?:\s*Gate-SHA:[^\n]*\n|\s*Skills:[^\n]*\n|\s*\n)*", re.IGNORECASE)
#
# `(?![-\w])` rather than `\b`: `\b` matches between the S of PASS and the hyphen of
# "QA PASS-eligible", so a BUILDER's own "QA PASS-eligible" line parsed as the QA gate's verdict.
# Measured over 20121 comments, four carry the shape and only one is in the unsafe direction
# (card 65e0b0d5, backend2) -- the others are "QA FAIL-re reagalva" and "CYBERED NO-GO-FELTETEL",
# which parse as FAIL/NO-GO and so err toward refusing a closure. No card's readout changes: on
# 65e0b0d5 the real `qa` verdict follows and latest_per_gate takes the last one. It is fixed because
# the failure direction is a false PASS, not because it has bitten yet.
# WHITEHAT/REDHAT (card cf0a8c0b): display-name aliases for CYBERSEC/CYBERED, folded to the
# canonical role by canonical_gate() in verdict_of() below -- the regex only needs to CAPTURE the
# token, not normalise it.
# F2 MEDIUM (card 1e763f16, WhiteHat comment 21917): same root as the TS guard's F1 -- two
# adjacent `\s*` groups separated only by an optional element give cubic backtracking on a long
# whitespace run with no verdict character after it (measured on this fork's regex: "QA" + 800
# spaces + "x" 2.2s, 1600 spaces 17.3s). Lower blast radius than the TS guard (this runs as a
# subprocess invoked at closure time, not on the dashboard's event loop), but it is the same
# shared rule the card asked for, so it gets the identical fix: `[ \t]*` instead of `\s*`, and
# each colon folded into its own optional group with its trailing space.
#
# Card ec34c025: this regex (and PASSING below) now live in gate_verdict_tokens.py, imported as
# `_VERDICT` at the top of this file -- the history above explains why it is shaped the way it is.
# Trailing sibling digits on a gate NAME, e.g. the "2" of "qa2". Anchored to the end so it cannot
# eat digits from the middle of a word.
_SIBLING_SUFFIX = re.compile(r"\d+$")
# MikroB's stated gate designation (card 864351a9), e.g. "MikroB GATE-KIJELOLES: QA (1-gate) --
# <reason>" or "MikroB GATE-KIJELOLES: QA + Cybersec (2-gate) -- <reason>" -- the LIVE convention
# already in use (comments 19882, 19898), just never read by this file. Plain ASCII, matching this
# board's own `Gate-SHA:`-style technical markers (no accented "KIJELÖLÉS").
_GATE_DESIGNATION_LINE = re.compile(r"^\s*MikroB\s+GATE-KIJELOLES\s*:\s*(.+)$", re.IGNORECASE | re.MULTILINE)
_GATE_NAME_TOKEN = re.compile(r"\b(QA|CYBERSEC|WHITEHAT|CYBERED|REDHAT)(\d*)\b", re.IGNORECASE)
# Every `Gate-SHA:` line (rule 4b: line-initial, not necessarily comment-initial -- a line can sit
# anywhere in the comment), because rule 4b lets a line name several commits ("<sha>, <sha>") and 68
# cards on this board do. A verdict naming ANY of them is judging this card's delivery.
_GATE_SHA_LINE = re.compile(r"^\s*Gate-SHA\s*:\s*(.+)$", re.IGNORECASE | re.MULTILINE)
_SHA_TOKEN = re.compile(r"\b[0-9a-fA-F]{7,40}\b")

# THE TOKEN FILTER BELOW IS PORTED, NOT RE-DERIVED (card f53ef8e4, backend2's own request in comment
# 21435): src/web/kanban-gate-completeness-guard.ts's extractGateShas() solved this exact problem
# for a sibling consumer of the same `Gate-SHA:` convention, refined three times against real
# incidents (d0b4f003, 4ae2d3f5, a20f0aa7) and measured on 3301+ real lines. Card 4a6c47f0 is this
# file's own live instance: `Gate-SHA: d49e9c7a... (CleanCore, ág feat/tenant-auth-ip-coarsen-
# 4a6c47f0, ...)` embeds the CARD'S OWN ID in the branch name, and a card id is a valid 7-40 hex
# string -- naive scanning of the whole line picked it up as a second "sha" and turned a real
# content DISAGREE into a false AGREE, the exact failure direction this file exists to prevent.
# Only the field NAME differs between the two files' minimum sha length (this file's OWN `_SHA_TOKEN`
# was already {7,40} everywhere, matching git's default abbreviation; the TS reference uses {6,40}
# for its own consumer) -- kept at {7,40} here for consistency with the rest of this file, not
# widened to match the port.
_PARENT_MARKED_SHA = re.compile(
    r"\b(?:szulo|szülő|parent|merge-base)[\s:]+[0-9a-fA-F]{7,40}\b", re.IGNORECASE
)
_HEX_ONLY_SEGMENT = re.compile(r"^[0-9a-fA-F]{7,40}$")

# GENERATED-COMMENT AUTHORS (card e7f91eb9, WhiteHat2 L1 on 1aeae282's own gate). post_draft_comment
# interpolates the local-llm model's raw output into a comment body with no fencing, so whatever the
# model happens to write -- including a line that LOOKS like "Gate-SHA: <sha>" or opens with "REVIEW"
# -- lands verbatim and is NOT trustworthy input to declared_shas()/undeclared_post_review_shas(): a
# draft that cites a different Gate-SHA than the real round makes an already-verdicted card read
# STALE or UNRESOLVED. Same set `kanban-landed-guard.ts` exports as GENERATED_COMMENT_AUTHORS (and
# `gate-dispatch-check.sh` already mirrors) -- this mirrors that list rather than inventing a second
# one. Case-insensitive on purpose (card e7f91eb9 INFO): author comparisons elsewhere in this file
# already lowercase/strip before comparing (e.g. stated_designation()'s "mikrob" check); this one
# follows the same convention so a differently-cased author string is not a silent bypass.
GENERATED_COMMENT_AUTHORS = {"local-llm", "gate-pretriage"}


def _is_generated_author(c):
    return ((c or {}).get("author") or "").strip().lower() in GENERATED_COMMENT_AUTHORS


def _is_path_token(tok):
    """A '/'-bearing token is a branch name or a path, not a sha citation -- ONLY when some
    slash-separated segment is not itself a bare hex run, so the fleet's "A/B" short/long
    both-commits idiom (card 67807f6f) is not swallowed along with a real branch name."""
    if "/" not in tok:
        return False
    stripped = tok.strip("`'\"(),;")
    segments = [s for s in stripped.split("/") if s]
    return any(not _HEX_ONLY_SEGMENT.match(s) for s in segments)
# Anchored exactly like the verdict, and for the same reason in mirror image: a comment that QUOTES a
# REVIEW must not be able to supply the expected sha. `_LEAD_SKIP` is shared so the two orders rule
# 4b/4c allow -- verdict first or `Gate-SHA:` first -- work here too.
_REVIEW_OPEN = re.compile(r"^\s*REVIEW\b", re.IGNORECASE)

# A STATED "n/a" ON THE LATEST REVIEW RESETS THE EXPECTATION, IT DOES NOT FALL BACK TO AN OLDER
# ONE (card 1aeed1ca, WhiteHat2 L1). CLAUDE.md rule 4e's config-only convention is a REVIEW line
# `Gate-SHA: n/a` -- `_line_shas()` only ever collects hex tokens, so that line produces [] the
# same way a REVIEW with no Gate-SHA line at all does, and the old loop's `if not shas: continue`
# treated both the same way: skip this REVIEW, keep whatever an EARLIER REVIEW declared. That is
# right for "this REVIEW said nothing about a sha" but wrong for "this REVIEW explicitly says there
# is none" -- a rebuilt-with-no-commit round would then still check the gates' latest AGREE against
# the stale OLD sha, exactly the hazard `--expect`/declared_shas() exists to close one door over.
_NA_GATE_SHA = re.compile(r"^\s*n/a\b", re.IGNORECASE)


def _is_na_gate_sha_line(content):
    """Does this REVIEW's Gate-SHA line(s) read as 'n/a' (rule 4e) and NOTHING ELSE?

    CYBERED NO-GO on 1aeed1ca, F1: the first version matched if ANY Gate-SHA line started with
    'n/a', so one extra line "Gate-SHA: n/a" next to a real sha -- or a single line like
    "Gate-SHA: n/a <B>" -- wiped the real sha out of declared_shas() entirely. A card whose Gate-SHA
    line(s) name no hex sha ANYWHERE is the only case this must fire for: if `_line_shas()` finds a
    real sha on any Gate-SHA line of this same comment, n/a is not a declaration of "nothing to
    check", it is at most a stray/explanatory line next to the actual one.
    """
    if not any(_NA_GATE_SHA.match(line.strip()) for line in _GATE_SHA_LINE.findall(content)):
        return False
    return not _line_shas(content)


# A machine-readable retraction marker (card 84fed4ee, Cybered's finding on 101f1702): a builder who
# posts a second REVIEW and then reverts the branch back to the first sha, with only a prose comment
# explaining it, leaves declared_shas() no way to tell the two REVIEWs apart -- it always takes the
# LATEST one, so the withdrawn sha becomes the default --expect and three verdicts that correctly
# judged the ORIGINAL sha read STALE. Line-initial, like Gate-SHA itself (rule 4b's kimondott-ertek
# principle): the builder says which sha is dead, instead of this file guessing it from prose.
_RETRACTION_LINE = re.compile(r"^\s*(?:VISSZAVONVA|RETRACTED)\s*:\s*(.+)$", re.IGNORECASE | re.MULTILINE)

# _SHARED_CHURN and PASSING (card ec34c025) now live in sha_content_equivalence.py and
# gate_verdict_tokens.py respectively, imported at the top of this file.

# `Landing: n/a` (card 634a188c): the same documented spelling rule 4e already established for
# `Gate-SHA: n/a (config-only)` -- a card with no code to land (config-only, research) has nothing
# a card_landings row or a git-ancestry check could ever confirm, and both checks below must be
# told so explicitly rather than guessing from an empty result. Line-initial, same convention.
_LANDING_LINE = re.compile(r"^\s*Landing\s*:\s*(.+)$", re.IGNORECASE | re.MULTILINE)


def _landing_exempt(comments):
    """Does the comment `declared_shas()` itself would read the judged Gate-SHA from -- the latest,
    not-retracted, REVIEW-shaped comment that carries a Gate-SHA line -- ALSO carry a line-initial
    `Landing: n/a`? Skips BOTH the card_landings and the git-ancestry landed checks for this card,
    the same way `--no-landed` does for the caller.

    QA FAIL (comment 31861, card 634a188c): the first version of this function scanned EVERY
    comment on the card, from ANY author, which let anyone who can post a kanban comment exempt a
    real, declared, never-landed Gate-SHA from NOT-LANDED/UNLANDED forever, just by posting one
    throwaway comment reading "Landing: n/a" anywhere on the card.

    Cybersec2 NO-GO round 2 (comment 31869): the first fix narrowed the scan to "the latest
    REVIEW-shaped comment", but that selection did not require a Gate-SHA line -- so a LATER,
    unrelated comment that merely started with the word "REVIEW" (e.g. "REVIEW (addendum)\n
    Landing: n/a", no Gate-SHA at all) still won the "latest REVIEW" slot and exempted a REAL,
    earlier-declared, unlanded sha it says nothing about. Fixed by reusing declared_shas()'s own
    comment-selection helper verbatim (not a second regex that can drift from it): the exemption
    can now only ever come from the exact comment whose Gate-SHA line supplies the judged sha. A
    comment with no Gate-SHA line never wins that selection, so it can never carry the exemption
    either -- consistent with the fact that an exemption on a card with NO declared sha at all
    never reaches this code anyway (NOSHA fires first).
    """
    found = _latest_declaring_review(comments)
    if found is None:
        return False
    _, content = found
    for m in _LANDING_LINE.finditer(content):
        if m.group(1).strip().lower().startswith("n/a"):
            return True
    return False


def _line_shas(content):
    """Every hex token cited on the comment's `Gate-SHA:` line(s), lowercased, in written order and
    deduplicated, [] if there is no such line (card f53ef8e4, Cybersec's finding).

    Shared by verdict_of() and declared_shas() so a VERDICT's multi-commit Gate-SHA (rule 4b:
    "<sha>, <sha>") is read the same way a REVIEW's already was -- one token collector, not two
    that can silently drift apart. Excludes parent/ancestor references and branch/path-embedded
    lookalikes the same way kanban-gate-completeness-guard.ts's extractGateShas() does (see the
    filter constants above) -- a plain "take every hex run on the line" would also re-admit the
    card-id-in-a-branch-name class that filter exists to keep out.
    """
    out = []
    for line in _GATE_SHA_LINE.findall(content):
        blanked = _PARENT_MARKED_SHA.sub(lambda m: " " * len(m.group(0)), line)
        for tok in blanked.split():
            if _is_path_token(tok):
                continue
            for m in _SHA_TOKEN.finditer(tok):
                sha = m.group(0).lower()
                if sha not in out:
                    out.append(sha)
    return out


def verdict_of(content):
    """(gate, outcome, shas) for a comment that OPENS with a verdict, else None.

    `shas` is a TUPLE of every hex token on the Gate-SHA line (order preserved), or None if the
    comment carries no such line -- None, not (), so the NOSHA/`is None` checks elsewhere are
    unchanged by this becoming a collection instead of a single value (card f53ef8e4). Before this,
    only the FIRST token of a multi-sha line was kept, so two gates that both used the documented
    "<sha>, <sha>" form but wrote the tokens in a different order, or led with a different one, got
    a false DISAGREE even though their sets actually intersected on the delivered commit.
    """
    if not isinstance(content, str):
        return None
    body = content[_LEAD_SKIP.match(content).end():]
    m = _VERDICT.match(body)
    if not m:
        return None
    shas = _line_shas(content)
    outcome = m.group(3).upper()
    # group(2) is the sibling number and is deliberately discarded: see the note on GATES.
    # canonical_gate() folds WHITEHAT/REDHAT to CYBERSEC/CYBERED (card cf0a8c0b) so every reader
    # downstream of this function keeps comparing against the same GATE_ROLES names it always has.
    return (canonical_gate(m.group(1)), "NO-GO" if outcome == "NO-GO" else outcome,
            tuple(shas) if shas else None)


def _latest_declaring_review(comments):
    """(index, content) of the LATEST, NOT-RETRACTED, REVIEW-shaped comment that carries a Gate-SHA
    line, or None if no comment qualifies. The single shared selection both declared_shas() (which
    sha is judged) and _landing_exempt() (which comment's `Landing: n/a`, if any, applies to that
    sha) must agree on -- card 634a188c, Cybersec2 NO-GO round 2 (comment 31869): an exemption read
    from a DIFFERENT comment than the one supplying the judged sha let an unrelated, Gate-SHA-less
    "REVIEW (addendum)" comment exempt a real sha it never declared.

    Not "the latest Gate-SHA anywhere": measured both ways over the board, sourcing it from any
    non-verdict comment fixes 8 cards and breaks 8 others, so it buys nothing and loosens the rule.

    A REVIEW is skipped if a LATER comment carries a line-initial `VISSZAVONVA:`/`RETRACTED:` marker
    naming one of its shas (card 84fed4ee): the 101f1702 incident was a second REVIEW followed by a
    branch revert back to the first REVIEW's sha, described only in prose -- this used to always
    take the newest REVIEW regardless, so the withdrawn sha became the default --expect and three
    verdicts that correctly judged the ORIGINAL sha read STALE. "Later" is comment order, the same
    convention `_gate_state` already documents for this file -- a retraction cannot apply to a REVIEW
    that has not been posted yet.

    A REVIEW whose Gate-SHA line reads literally `n/a` (rule 4e, config-only work) RESETS this to
    [] rather than being skipped like a REVIEW with no Gate-SHA line at all (card 1aeed1ca): the
    explicit n/a is itself a declaration, just an empty one, and must not leave an earlier REVIEW's
    sha standing as the default expectation.
    """
    found = None
    for i, c in enumerate(comments):
        if _is_generated_author(c):
            continue
        content = (c or {}).get("content")
        if not isinstance(content, str):
            continue
        if not _REVIEW_OPEN.match(content[_LEAD_SKIP.match(content).end():]):
            continue
        if _is_na_gate_sha_line(content):
            # Explicit "nothing to check" (card 1aeed1ca, L1): resets any earlier REVIEW's sha
            # rather than leaving it standing, so a later gate AGREE is never silently checked
            # against content this REVIEW said does not exist.
            found = []
            continue
        shas = _line_shas(content)
        if not shas:
            continue
        if sha_sets_agree(shas, _retraction_shas_after(comments, i)):
            continue
        found = (i, content)
    return found


def declared_shas(comments):
    """The shas the LATEST, NOT-RETRACTED `REVIEW` comment says this card delivers, [] if none says.
    See _latest_declaring_review() for the selection rule."""
    found = _latest_declaring_review(comments)
    return _line_shas(found[1]) if found else []


def _latest_review_is_na(comments):
    """Does the single LATEST `REVIEW` comment (declared_shas()'s own notion of "latest") declare
    its Gate-SHA as n/a (rule 4e)?

    CYBERED NO-GO on 1aeed1ca, F2: `declared_shas()` returning [] is ambiguous on its own -- it means
    either "no REVIEW ever named a sha" (silence) or "the latest REVIEW explicitly says there is no
    commit" (a declaration). `check()`'s default-AGREE path must tell these apart: silence keeps the
    existing "unchecked, but AGREE" caveat, but an explicit n/a is a stated claim that MISMATCHES a
    gate verdict naming a real commit -- that must never read as AGREE (see F2's fixture: REVIEW A,
    gates PASS/GO on A, then the builder posts a REVIEW with Gate-SHA: n/a for the SAME rebuilt
    code -- the gates judged a real commit, the REVIEW says none exists).
    """
    for c in reversed(comments):
        if _is_generated_author(c):
            continue
        content = (c or {}).get("content")
        if not isinstance(content, str):
            continue
        if not _REVIEW_OPEN.match(content[_LEAD_SKIP.match(content).end():]):
            continue
        return _is_na_gate_sha_line(content)
    return False


def _retraction_shas_after(comments, index):
    """Every hex token named on a `VISSZAVONVA:`/`RETRACTED:` line in any comment AFTER `index`."""
    out = []
    for later in comments[index + 1:]:
        content = (later or {}).get("content")
        if not isinstance(content, str):
            continue
        for m in _RETRACTION_LINE.finditer(content):
            for sha in _SHA_TOKEN.findall(m.group(1)):
                sha = sha.lower()
                if sha not in out:
                    out.append(sha)
    return out


def stated_designation(comments):
    """The gate set MikroB's LATEST `MikroB GATE-KIJELOLES: ...` comment names, or None if no such
    comment exists (card 864351a9, Cybersec's finding).

    A STATED designation outranks inference from present verdicts, the same reason a stated
    `Gate-SHA:` outranks a guessed one (rule 4b): root CLAUDE.md's 4a already documents the
    inferred set as a fallback for an UNSTATED designation, and two live `done` cards (e96b06e7,
    89f4c28d) closed on a verdict from a gate MikroB never designated while the actual designation
    sat right there on the card, in a comment this file never read.

    AUTHOR-FILTERED (Cybersec HIGH, same card, round 2). The first version of this function accepted
    the "MikroB GATE-KIJELOLES: ..." line from ANY comment's content, never checking who wrote it --
    unlike the rest of this file, which explicitly checks authorship for every other claim it trusts
    (verdict attribution's `author_role(who) == v[0]`, the line ~700 comment on self-declared
    authorship). Proven live: a builder's own REVIEW comment quoting/forging a narrower
    "MikroB GATE-KIJELOLES: QA (1-gate) -- ..." line, posted AFTER MikroB's real wider designation,
    silently overrode it and produced a QA-only AGREE with Cybersec/Cybered skipped entirely -- the
    exact rule-4 protection this whole function exists to make load-bearing. Designation is
    MikroB's alone per root CLAUDE.md rule 4 ("MikroB TTE-feladata... kártyánként kiválasztani/
    váltogatni a gate-tagokat"), so the check is the literal author, not `author_role` (which has no
    entry for MikroB -- it answers "who speaks for a GATE", a different question).
    """
    found = None
    for c in comments:
        content = (c or {}).get("content")
        if not isinstance(content, str):
            continue
        if (c.get("author") or "").strip().lower() != "mikrob":
            continue
        m = _GATE_DESIGNATION_LINE.search(content)
        if not m:
            continue
        names = []
        for name, _digits in _GATE_NAME_TOKEN.findall(m.group(1)):
            u = canonical_gate(name)
            if u not in names:
                names.append(u)
        if names:
            found = names
    return found


def undeclared_post_review_shas(comments):
    """Shas any comment AFTER the latest `REVIEW` declares on a Gate-SHA line, that are covered by
    NEITHER that REVIEW's own declared set NOR any gate-verdict comment in the same span (card
    3e4dc2c3, Cybered's board-wide finding).

    Rule 4a's default expectation comes from the latest REVIEW comment (card 2003e04b) -- correctly
    NOT from any comment with a Gate-SHA line, per declared_shas()'s own measurement above (sourcing
    it from any comment fixes 8 cards and breaks 8). But a non-REVIEW comment can still declare a
    NEWER commit without the word REVIEW -- the routine shape is a builder's own "<finding> JAVITVA
    -- delta-gate kell", which this file's own README-adjacent convention never required to open
    with REVIEW. If no gate verdict ANYWHERE in that span names the newer sha either, the tool's
    default AGREE (built from the OLD REVIEW's sha, because that is genuinely all declared_shas() can
    see) is silently checking a commit nobody designated has reviewed. Measured on the live board: 8
    of 14 cards with this shape read AGREE by default while `--expect <the newer sha>` on the SAME
    card answers STALE -- the check answers a narrower question than the default caller is asking,
    the same failure shape `--expect` itself was built to close (see the header).

    A gate verdict's OWN Gate-SHA line does not count as an "undeclared" citation -- it is exactly
    the citation this function is checking FOR, not a stray one to flag.
    """
    review_idx = None
    for i, c in enumerate(comments):
        if _is_generated_author(c):
            continue
        content = (c or {}).get("content")
        if isinstance(content, str) and _REVIEW_OPEN.match(content[_LEAD_SKIP.match(content).end():]):
            review_idx = i
    if review_idx is None:
        return []
    review_shas = set(declared_shas(comments))
    gate_shas = set()
    candidates = []
    for c in comments[review_idx + 1:]:
        if _is_generated_author(c):
            continue
        content = (c or {}).get("content")
        if not isinstance(content, str):
            continue
        v = verdict_of(content)
        if v is not None:
            if v[2]:
                gate_shas.update(v[2])
            continue
        for sha in _line_shas(content):
            if sha not in candidates:
                candidates.append(sha)
    covered = review_shas | gate_shas
    return [s for s in candidates if not any(shas_agree(s, c) for c in covered)]


# The author->role fold that used to live here is now gate_author_role.author_role, imported at
# the top: the landing gate needs the SAME table, and a second copy of it is a divergence
# waiting for the next alias (card 48b0dd36). The measurements that shaped the rule moved
# with it.


def latest_per_gate(comments):
    """The LAST verdict each gate gave. Order is the board's own comment order."""
    return _gate_state(comments)[0]


def unsuperseded_gates(comments):
    """Gates carrying a refusal that no later verdict can be SHOWN to supersede.

    Separate from `latest_per_gate` for the same reason `unattributed_gates` is: "this gate refused"
    and "this gate's refusal cannot be judged" are different statements, and collapsing them into
    one dict is how the second one gets answered with the first one's word.

    Returns {gate: (who said it, verdict word)}.
    """
    return _gate_state(comments)[1]


def _gate_state(comments):
    """(latest verdict per gate, undecidable refusals per gate). Order is the board's own.

    Deliberately not "the highest id" or a timestamp: the caller hands us the list the API returned,
    and re-sorting it here would invent an ordering the board never promised.
    """
    latest, latest_author, latest_by_role, latest_by_author, undecidable = {}, {}, {}, {}, {}
    for c in comments:
        c = c or {}
        v = verdict_of(c.get("content"))
        if not v:
            continue
        who = (c.get("author") or "").strip().lower()
        latest[v[0]] = v
        latest_author[v[0]] = who
        # ONLY A GATE-ROLE AUTHOR ENTERS THE PER-AUTHOR TABLE (card c52e2823, round 2, QA's finding
        # 21135 and Cybersec's independent repro 21176). The sibling rule below reads this table, and
        # keyed by EVERY author it let a non-gate sentence of verdict SHAPE -- MikroB's routine
        # "CYBERED NO-GO ELFOGADVA, vissza in_progress-be", or a builder's "QA FAIL elfogadva,
        # javitottam" -- stand in permanently for a refusal the gate itself had already withdrawn.
        # Measured by QA on the landed file: a real NO-GO, that acknowledgement, then the gate's own
        # later GO and a QA PASS on the delivered sha answered FAILED, where the same input one
        # commit earlier answered AGREE. The mirror of this table, `latest_by_role`, has filtered by
        # role since it was written; only this one did not.
        if author_role(who) == v[0]:
            latest_by_role[v[0]] = v
            latest_by_author[(v[0], who)] = v

    # AN UNATTRIBUTABLE PASS IS NOT A PASS; AN UNATTRIBUTABLE REFUSAL IS STILL A REFUSAL.
    #
    # The directions are not symmetric, which is why this is not a plain "prefer the gate's own
    # comment". Discarding a relayed FAIL in favour of an older gate-authored PASS would let a card
    # close over a stated refusal -- strictly worse than the bug being fixed. So a failing verdict
    # stands whoever wrote it, and only a PASSING one has to be attributable.
    #
    # Falling back to the role's own last verdict is Cybered's remedy, and measured over the board
    # it is a strict improvement rather than a trade: of the 104 pairs where it applies, it RECOVERS
    # a `Gate-SHA:` in 30 (MikroB's summaries usually carry none, so those gates read NOSHA today
    # and become checkable), loses one in ZERO, and changes no sha that both sides state.
    for gate, v in list(latest.items()):
        if v[1] not in PASSING:
            continue
        if gate in latest_by_role:
            latest[gate] = latest_by_role[gate]

    # A REFUSAL NOBODY CAN BE HELD TO, WITH NO COMMIT TO CHECK IT AGAINST (card c52e2823, round 2).
    #
    # The block above keeps an unattributable refusal standing, and that rule is right in its own
    # direction: dropping it would close a card over a stated refusal. But it answers FAILED to a
    # sentence it cannot read -- and on this board the sentence is almost always a RELAY. Cybersec
    # measured the population from the live board: 615 verdict-shaped comments, 18 from an author
    # who does not hold that gate's role, 11 of those refusals, on 9 cards. The routine shape is
    # MikroB's own "<GATE> <VERDICT> ELFOGADVA, vissza in_progress-be" acknowledgement, which by
    # design carries no Gate-SHA because it is not a verdict of its own.
    #
    # So this case has TWO readings and no evidence to choose between them: either a real refusal
    # someone else wrote down (it stands), or an acknowledgement of one the gate has since answered
    # (it is spent). FAILED asserts the first and UNSUPERSEDED says the truth -- not closable, not
    # automatically bounced, a human decides. What it must never become is AGREE, which is why the
    # gate's own passing verdict is a PRECONDITION here rather than a fallback: with nothing
    # attributable to weigh against, the refusal keeps blocking exactly as it does today.
    # A GATE'S OWN REFUSAL NEVER REACHES HERE, and it is worth saying WHY rather than guarding for it
    # twice: if the gate's last word is its own refusal, then `latest_by_role` holds that same
    # refusal (both dicts are written in the same pass, keyed by the same gate), so the passing
    # precondition below already declines. Mutating an explicit author check away left all 83 cases
    # green -- not a hole in the suite, a branch that cannot be taken. The behaviour it looks like it
    # protects is pinned by a case of its own regardless of which line delivers it.
    for gate, v in list(latest.items()):
        if v[1] in PASSING or v[2] is not None:
            continue
        role_v = latest_by_role.get(gate)
        if role_v is None or role_v[1] not in PASSING:
            continue
        latest[gate] = role_v
        undecidable[gate] = (latest_author.get(gate) or "?", v[1])

    # A STANDING REFUSAL FROM A SIBLING IS STILL A REFUSAL (card c52e2823).
    #
    # A role may be staffed by two agents, and the dict above keys on the ROLE, so within one role
    # the LAST comment won whoever wrote it. Measured on this file as it stood: `QA FAIL` followed by
    # `QA2 PASS` on the SAME sha answered AGREE, and rule 4a's closure step reads AGREE as "safe to
    # close" -- a card could close over a stated refusal, which is the direction this whole tool
    # exists to prevent. The control that proves the harness was not simply blind: a lone `QA FAIL`
    # answered FAILED all along.
    #
    # This is the asymmetry two comments up, one dimension over. There it was about WHO wrote the
    # verdict; here it is about WHICH of two siblings did. Same rule: a refusal stands, and only a
    # PASS may be superseded.
    #
    # SUPERSEDED BY A NEW SHA, NOT BY A SIBLING. A refusal only blocks when it concerns the same
    # commit the passing verdict names -- the ordinary flow (qa fails sha X, the builder fixes it,
    # qa2 delta-gates sha Y and passes) must not be blocked by a refusal about code that is gone.
    # A refusal naming NO sha does block, because "an unattributable refusal is still a refusal"
    # cannot mean anything else here.
    for gate, v in list(latest.items()):
        if v[1] not in PASSING:
            continue
        for (g, who), fv in latest_by_author.items():
            if g != gate or fv[1] in PASSING:
                continue
            if fv[2] is not None and v[2] is not None and sha_sets_agree(v[2], fv[2]):
                latest[gate] = fv
                undecidable.pop(gate, None)
                break
            if fv[2] is None:
                # NAMES NO COMMIT, SO NOTHING CAN BE SHOWN TO SUPERSEDE IT (card c52e2823, round 2,
                # MikroB's ruling 21139 case (b), which is card e4b7096e folded in here). Until now
                # this blocked outright, and that is one of two guesses dressed as an answer: the
                # sibling PASS may be a re-review of a fixed commit (then the refusal is gone) or a
                # disagreement about this one (then it stands), and with no sha on either side the
                # tool cannot tell which. FAILED asserts the second; AGREE asserts the first. The
                # honest answer names the ambiguity and hands it to a human.
                undecidable.setdefault(gate, (who, fv[1]))
    return latest, undecidable


def unattributed_gates(comments):
    """Gates whose latest verdict PASSES but which never posted a verdict themselves.

    Separate from `latest_per_gate` so the verdict a gate is credited with and the question of
    whether anyone can be held to it stay independently readable. `check` turns this into
    UNVERIFIED-AUTHOR rather than a silent AGREE: "nobody I can name said this passed" is not the
    same statement as "it passed", and this tool's whole job is to keep those apart.
    """
    seen, by_role = {}, set()
    for c in comments:
        c = c or {}
        v = verdict_of(c.get("content"))
        if not v:
            continue
        seen[v[0]] = v
        if author_role(c.get("author")) == v[0]:
            by_role.add(v[0])
    return {g for g, v in seen.items() if v[1] in PASSING and g not in by_role}


def _fmt_shas(shas):
    """Render a verdict's sha tuple for an output line: '-' for None/empty, else the shas in the
    order the verdict wrote them, comma-joined. A single-sha tuple renders identically to the bare
    string this file used to carry, so every existing byte-for-byte output is unchanged."""
    return ",".join(shas) if shas else "-"


# shas_agree/sha_sets_agree/_git/_CLONES/_MAIN_REF_OVERRIDE/_GIT_TIMEOUT/_clone_holding/
# _clone_and_ref_holding/_is_version_bump/_bump_parent_hint (card ec34c025) now live in
# sha_content_equivalence.py, imported at the top of this file.


def landed_verdict(candidates):
    """Is ANY of these commits on the shipped branch? None when yes, a `(sha, ref, why)` when not.

    CARD e65c480a, FOUNDING CASE MEASURED 2026-09-12 on card 667e809b. Everything this file asked
    until now is about whether the VERDICTS are consistent -- with each other, and with the sha the
    card declares. Not one branch asks whether that sha ever reached the main branch. 667e809b was
    closed on a perfectly consistent QA PASS whose commit (be6964eb) was not an ancestor of
    origin/main; the fix existed only on a branch, and main stayed red on the very defect the card
    had closed. Reconstructed here from the real history, both ways: be6964eb is NOT an ancestor of
    9e426ef6 (where main stood at closing time) and IS an ancestor of origin/main today.

    ANCESTOR, NEVER EQUALITY. Both landers merge --no-ff, so the gated commit becomes an ANCESTOR of
    the main branch, never equal to its tip -- and a version bump usually sits on top of the merge
    besides. Comparing tips would call every correctly landed card unlanded.

    ANY candidate, not all. A card's delivery can legitimately be named by more than one sha (rule
    4b allows a multi-commit `Gate-SHA:`, and the gates' sha and the REVIEW's sha are often the work
    commit versus the landing that carried it -- 38 such cards on this board, 23 of them benign).
    If any one of them is on the branch, the work shipped, so the question is answered.

    FAIL-CLOSED when it cannot be answered: no clone holds the commit, the ref does not resolve, or
    git failed. "I could not check" is not "I checked and it is fine" -- the same rule UNRESOLVED
    already applies one door over. The caller is told WHICH of the two it got.
    """
    seen = [c for c in dict.fromkeys(candidates) if c]
    if not seen:
        return None
    why = []
    for sha in seen:
        found = _clone_and_ref_holding(sha)
        if not found:
            why.append("%s is in no known clone, so it cannot be checked" % sha)
            continue
        clone, ref = found
        if not _git(clone, "rev-parse", "--verify", "--quiet", ref + "^{commit}")[0]:
            why.append("%s: %s does not resolve in %s, so it cannot be checked" % (sha, ref, clone))
            continue
        if _git(clone, "merge-base", "--is-ancestor", sha, ref)[0]:
            return None
        # NOT AN ANCESTOR IS NOT YET AN ANSWER, and this is the whole difficulty of the card.
        # Measured over the whole board before shipping: of 123 cards this file calls AGREE, 5 have
        # a gated commit off the branch -- and ONE of them (ba82df9d) had shipped: every line it
        # added to apps/superadmin/src/api/types.ts is on origin/main, under a different sha,
        # with the file having moved on since. Answering UNLANDED on ancestry alone accuses that
        # card falsely, and a fifth of an alarm being wrong is how the whole alarm gets ignored --
        # the same measurement that decided sha equality was the wrong test for STALE (see header).
        #
        # So two more questions before accusing, cheapest first:
        #   1. PATCH IDENTITY. `git cherry <ref> <sha> <sha>^` asks about this ONE commit (the
        #      three-argument form keeps it O(1) instead of patch-id-ing the whole branch) and
        #      answers `-` when an equivalent patch is already upstream -- exactly the cherry-pick /
        #      rebase / re-commit shape. Measured on all five: `-` for ba82df9d's commit, `+` for
        #      the other three, and empty for the control that was a plain ancestor.
        #   2. CONTENT. Kept after it, because a squash or a reword changes the patch-id while the
        #      delivered bytes still arrive.
        ok, cherry = _git(clone, "rev-parse", "--verify", "--quiet", sha + "^")
        if ok and cherry.strip():
            ok, out = _git(clone, "cherry", ref, sha, sha + "^")
            if ok and any(l.startswith("-") for l in out.splitlines()):
                return None
        kind, detail = _content_on_branch(clone, ref, sha)
        if kind == "same":
            return None
        why.append("%s is not an ancestor of %s and %s" % (sha, ref, detail))
    return seen[0], "; ".join(why)


def _content_on_branch(clone, ref, sha):
    """Do the files `sha` delivers hold the same content on `ref`? ("same"|"differs"|"unresolved").

    The same comparison content_verdict() makes between two shas, with the branch ref standing in
    for the second one, and the same per-landing churn subtracted (package.json / DECISIONS.md /
    README.md move on every landing and on other agents' landings, so they can never be identical
    and would make every answer "differs").

    `log -1 --name-only --first-parent`, not `show`: `git show --name-only` prints nothing at all
    for a merge commit, and a Gate-SHA naming a landing merge is one of the two shapes this board
    uses -- an empty file list would then read as "nothing differs", a vacuous pass on exactly the
    cards this exists for.

    SYNC MERGES ARE THE MIRROR IMAGE OF LANDING MERGES, AND `--first-parent` CANNOT TELL THEM APART
    (card 88e2ffe1, measured live on 555419a8 at 14:31: fe136e6e read "same"/AGREE while the card's
    own real work commit, d1634b47, correctly read "differs" -- the false AGREE won only because it
    was the one the gates had actually verdicted on). A LANDING merge (card branch merged --no-ff
    INTO develop) has first parent = develop-before, second parent = card tip, so its first-parent
    diff IS the card's own contribution -- exactly what this function is built to check. A SYNC
    merge (develop merged INTO the card's own branch, the routine "rebase onto latest develop
    before landing" step) has first parent = card-before, second parent = develop tip, so its
    first-parent diff is mostly DEVELOP'S OWN content flowing onto the card branch -- "every added
    line is present on develop" is then close to vacuously true, because most of those lines CAME
    from develop, and the card's actual, still-unlanded work (which predates the sync and so never
    shows up in a first-parent diff against it) is never examined at all. The tell: a sync merge's
    SECOND parent is already reachable from `ref`; a landing merge's second parent (the unlanded
    card tip) normally is not. Caught here and refused rather than risked as a false "same" --
    fail-closed, like every other unanswerable case in this function.
    """
    ok, parents = _git(clone, "log", "-1", "--format=%P", sha)
    if ok:
        parent_shas = parents.split()
        for other_parent in parent_shas[1:]:
            if _git(clone, "merge-base", "--is-ancestor", other_parent, ref)[0]:
                return ("unresolved",
                        "%s is a merge whose parent %s already includes %s's own content, so its "
                        "first-parent diff is mostly %s's own content flowing onto the other side, "
                        "not this card's contribution, and cannot be trusted either way"
                        % (sha, other_parent, ref, ref))
    ok, out = _git(clone, "log", "-1", "--name-only", "--format=", "--first-parent", sha)
    if not ok:
        return "unresolved", "its file list could not be read"
    files = [f for f in out.split("\n") if f.strip()]
    if not files:
        return "unresolved", "it delivers no files, so nothing can be compared"
    comparable = [f for f in files if os.path.basename(f) not in _SHARED_CHURN]
    if not comparable:
        # Card 74aa46a5's shape, one door over: subtracting churn can empty the comparison, and
        # "nothing differs" would then mean "nothing was compared".
        return ("unresolved",
                "every file it delivers is per-landing churn (%s), so ignoring it leaves nothing "
                "to compare" % ", ".join(sorted(set(files))))
    ok, out = _git(clone, "diff", "--name-only", sha, ref, "--", *comparable)
    if not ok:
        return "unresolved", "the content comparison against %s failed" % ref
    changed = [f for f in out.split("\n") if f.strip()]
    if not changed:
        return "same", "but every file it delivers is byte-identical on %s" % ref
    # BYTE-IDENTITY IS SUFFICIENT EVIDENCE OF LANDING, NOT NECESSARY. Measured on card 58e6fe06:
    # every line its commit added to PublicHeader.containing-block.test.ts is on origin/main, but
    # the file is not byte-identical because main moved on past it -- and its patch-id differs too,
    # because the same commit also touched DECISIONS.md. Stopping at byte-identity accuses that card
    # falsely. The weaker, still one-directional question: is every line this commit ADDED present
    # in the branch's copy of the same file? If so the change arrived, whatever else happened after.
    landed_by_lines, why_lines = _added_lines_present(clone, ref, sha, comparable)
    if landed_by_lines:
        return "same", why_lines
    return "differs", "%s still differ%s there%s" % (
        ", ".join(sorted(changed)[:5]), "" if len(changed) > 1 else "s",
        ("; " + why_lines) if why_lines else "")


# A one-character or punctuation-only added line ("})", "]") occurs everywhere, so finding it proves
# nothing. Only lines with real content are asked about, and there must be enough of them for the
# answer to mean something -- "all zero of the added lines are present" is the vacuous pass this
# whole file exists to refuse.
_MIN_LANDED_LINES = 3

# The same "too common to mean anything" reasoning applies to DELETED lines, but a length cutoff is
# the wrong tool there: a short, substantive deletion -- a one-line bypass/wildcard entry like
# `"*",` (4 characters) -- is exactly what a bypass-removal commit's deleted line looks like, and a
# len>=8 filter skipped it, so that deletion was never checked for absence and a still-present
# bypass read as landed (card eea8a2cb, Cybersec R1 on e21b816b). This matches purely structural
# bracket/closer noise ("})", "];", "),") instead, which filters out the vacuous case without
# blinding the check to short-but-real deletions. Known fail-closed cost (RedHat NO-GO F1, card
# eea8a2cb, 5239502b): a common short deleted line ("else:", "fi") that recurs elsewhere in the same
# file can now make a genuinely-landed commit read UNLANDED. Accepted on purpose -- a human looks
# before closing either way, and the alternative (the original len>=8 filter) silently missed real
# bypass removals instead.
_BRACKET_NOISE_RE = re.compile(r"^[()\[\]{};,]+$")


def _is_bracket_noise(l):
    return bool(_BRACKET_NOISE_RE.match(l))


def _line_set(text):
    """Trimmed, non-blank lines of `text` as a set -- exact membership, not a substring test."""
    return {l.strip() for l in text.split("\n") if l.strip()}


def _added_lines_present(clone, ref, sha, files):
    """(True, why) when every substantive line `sha` ADDS to `files` is in `ref`'s copy of that
    file, AND every substantive line it DELETES is absent there (card e21b816b, Cybersec F-1).

    THE DELETION-BLIND SPOT THIS CLOSES. The added-lines side alone can only ever turn a suspected
    UNLANDED back into AGREE, which is right for a commit whose substance is an ADDITION -- but a
    commit whose substance is a REMOVAL (stripping a bypass, dropping a deny-block) can carry only
    incidental added lines (a doc comment, a changelog note). Checking presence of those and never
    checking absence of what it deleted let such a commit read as landed while the thing it removed
    was still sitting on the main branch untouched. Measured same-day sibling: 42938a74, -14 lines
    in settings.json.template (a deny-block removed) plus doc additions -- the doc side alone would
    have satisfied the old check.

    Both directions share the same discipline: exact (trimmed) line-set membership rather than a
    substring test over the whole file (a short line could otherwise match INSIDE an unrelated
    longer one), and a combined minimum count before either direction means anything -- "zero
    substantive lines checked" is the vacuous pass this file exists to refuse.
    """
    total = 0
    for f in files:
        ok, patch = _git(clone, "show", "--format=", "--first-parent", sha, "--", f)
        if not ok:
            return False, "the added/deleted lines of %s could not be read" % f
        added = [l[1:].strip() for l in patch.split("\n")
                 if l.startswith("+") and not l.startswith("+++")]
        added = [l for l in added if len(l) >= 8]
        deleted = [l[1:].strip() for l in patch.split("\n")
                   if l.startswith("-") and not l.startswith("---")]
        # `l and ...`: a deleted BLANK line strips to "", and the bracket-noise regex requires 1+
        # chars so it never matches "" -- an empty deleted line slipped through as "substantive"
        # and could satisfy _MIN_LANDED_LINES on blank-line count alone, with the presence-check
        # silently vacuous (a blank line is never in _line_set's non-blank set either way, card
        # eea8a2cb, RedHat NO-GO B1 on 5239502b).
        deleted = [l for l in deleted if l and not _is_bracket_noise(l)]
        if not added and not deleted:
            continue
        ok, blob = _git(clone, "show", "%s:%s" % (ref, f))
        if not ok:
            return False, "%s does not exist on %s" % (f, ref)
        blob_lines = _line_set(blob)
        if added:
            missing = [l for l in added if l not in blob_lines]
            if missing:
                return False, "%d of the %d line(s) it adds to %s are absent on %s" % (
                    len(missing), len(added), f, ref)
        if deleted:
            still_there = [l for l in deleted if l in blob_lines]
            if still_there:
                return False, "%d of the %d substantive line(s) it deletes from %s are STILL " \
                    "present on %s" % (len(still_there), len(deleted), f, ref)
        total += len(added) + len(deleted)
    if total < _MIN_LANDED_LINES:
        return False, ("too few substantive added/deleted lines (%d) to conclude anything from "
                       "their presence/absence" % total)
    return True, ("but every substantive line it adds is present, and every substantive line it "
                  "deletes is absent, on %s (%d line(s) checked) -- so the work arrived under a "
                  "different sha" % (ref, total))


def _unlanded_line(verdict):
    """UNLANDED|<sha>|<why>. One word for both halves on purpose: whether the commit is provably
    off the branch or merely uncheckable, the reader's next action is the same -- go look before
    closing -- and the `why` says which one it is."""
    sha, why = verdict
    return "UNLANDED|%s|the gates agree, but the delivery is not on the main branch (%s)" % (sha, why)


# Card 634a188c (F2.1's authoritative record, F2 Fazis: "Landed state from git, not from the
# agent"). card_landings is written by marveen-land.sh/mopsion-land.sh ONLY after a verified push
# (src/card-landing-ancestry.ts re-verifies server-side before the row is written), so a row naming
# the judged sha is stronger evidence than the UNLANDED check above -- that one can only ask git
# ABOUT a sha a human or an agent typed, never whether a land SCRIPT actually ran. The row's absence
# closes the gap the Fazis context names directly: "cards close on Gate-SHAs typed into comments;
# marveen-land.sh prints a sha but does not write it anywhere authoritative" -- a post-/compact
# fabricated landing sha (measured live, 2026-11-01) can still happen to resolve in a clone and pass
# the ancestry check below; it cannot also have a card_landings row, because nothing but a real
# land-script run writes one.
_DEFAULT_LANDINGS_DB = os.environ.get("GATE_CLOSURE_DB", "/home/neon/marveen/store/claudeclaw.db")


def _card_landing_rows(card_id, db_path=None):
    """[(work_sha, merge_sha), ...] recorded for `card_id`, or None if the table could not be read
    AT ALL (missing db file, missing table, sqlite error) -- distinct from an empty list, which
    means the table WAS read and genuinely holds no row for this card yet."""
    import sqlite3 as _sqlite3
    path = db_path or _DEFAULT_LANDINGS_DB
    if not path or not os.path.exists(path):
        return None
    try:
        conn = _sqlite3.connect("file:%s?mode=ro" % path, uri=True, timeout=5)
    except _sqlite3.Error:
        return None
    try:
        cur = conn.execute("SELECT work_sha, merge_sha FROM card_landings WHERE card_id = ?", (card_id,))
        return [(r[0], r[1]) for r in cur.fetchall()]
    except _sqlite3.Error:
        return None
    finally:
        conn.close()


def _db_landed_verdict(card_id, candidates, db_path=None):
    """('landed'|'not-landed'|'unresolvable', why|None) for whether card_landings backs up one of
    `candidates` (the judged shas) for `card_id`.

    MikroB's own requirement on this card (comment 28281, a8a83d48's Cybersec2 GO): never accept a
    row on card_id alone -- a commit subject merely MENTIONING a card ("see card ffffffff") used to
    mint a row for it before the write side closed that hole, so a row's presence for this card_id
    is checked FURTHER, against the sha the gates actually judged, not trusted on its own.
    """
    rows = _card_landing_rows(card_id, db_path)
    if rows is None:
        return "unresolvable", "card_landings could not be read"
    if not rows:
        return "not-landed", (
            "no card_landings row exists for card %s -- marveen-land.sh/mopsion-land.sh have not "
            "recorded a verified push for it yet" % card_id)
    for work_sha, merge_sha in rows:
        # QA FAIL 31861, LOW: shas_agree(x, "") is True for any x (empty string is a prefix of
        # everything), so an empty/blank work_sha or merge_sha must never reach it -- not exploitable
        # via the only real writer today (card-landings.ts rejects empty shas with 400), but a future
        # direct-sqlite3 writer or test fixture could otherwise defeat this check silently.
        if any(((work_sha or "").strip() and shas_agree(cand, work_sha))
               or ((merge_sha or "").strip() and shas_agree(cand, merge_sha))
               for cand in candidates):
            return "landed", None
    recorded = ", ".join(sorted({s for pair in rows for s in pair}))
    return "not-landed", (
        "card_landings has %d landing(s) for card %s but none name the judged sha(s) %s "
        "(recorded: %s)" % (len(rows), card_id, ",".join(candidates), recorded))


def _not_landed_line(sha, why):
    """NOT-LANDED|<sha>|<why>. Distinct from UNLANDED: this is the card_landings table saying so,
    not a git-ancestry guess."""
    return "NOT-LANDED|%s|%s" % (sha, why)


def _landed_or(enabled, candidates, agree_line, card_id=None, comments=None):
    """AGREE only survives if the delivery is actually on the main branch (card e65c480a) AND,
    when a card id is given, if card_landings backs that up (card 634a188c).

    Card e21b816b, Cybersec F-2: with the check skipped (`--no-landed`) an AGREE used to come out
    byte-identical to one that actually verified the branch, and a non-default `GATE_CLOSURE_MAIN_REF`
    (global, so it silently affects every clone's lookup, not just the one it was set for) left no
    trace either -- a reader could not tell "verified on the branch" from "the question was never
    asked" or "asked against some other ref than the usual one". Both now say so in the AGREE line
    itself, not in a side channel the caller has to know to check.

    THE DB CHECK RUNS FIRST AND CAN SHORT-CIRCUIT, THE GIT CHECK CANNOT BE SHORT-CIRCUITED BY IT.
    A `not-landed` DB verdict is authoritative (nothing but a real land-script run writes a row) and
    returns immediately. A `landed` DB verdict does NOT skip the existing git-ancestry check below --
    this file's own established pattern (UNRESOLVED/UNLANDED) is fail-closed when a check cannot be
    made, so an `unresolvable` DB verdict (no `--card`, missing db, sqlite error) falls through to the
    unchanged git check rather than silently blocking or silently passing.
    """
    if not enabled:
        return agree_line + " [landed-check skipped: --no-landed]"
    if comments is not None and _landing_exempt(comments):
        return agree_line + " [landed-check skipped: Landing: n/a]"
    if card_id:
        state, why = _db_landed_verdict(card_id, candidates)
        if state == "not-landed":
            return _not_landed_line(candidates[0], why)
    verdict = landed_verdict(candidates)
    if verdict is not None:
        return _unlanded_line(verdict)
    if _MAIN_REF_OVERRIDE:
        return agree_line + " [main-ref=%s]" % _MAIN_REF_OVERRIDE
    return agree_line


# content_verdict (card ec34c025) now lives in sha_content_equivalence.py, imported at the top of
# this file -- it is the "same delivered content, not same sha" question this file's own header
# (see "WHY THE COMPARISON IS NOT SHA EQUALITY") already explains at length.


def check(comments, designated=None, expect=None, use_declared=True, check_landed=True, card_id=None):
    latest, undecidable = _gate_state(comments)
    unverified = unattributed_gates(comments)
    inferred = designated is None
    source_note = ""
    if inferred:
        stated = stated_designation(comments)
        if stated:
            # A STATED designation OUTRANKS inference (card 864351a9): it is not a guess needing a
            # caveat, so `inferred` goes false and it takes the CALLER-provided path below.
            designated, inferred = stated, False
            source_note = " (gate designation stated by MikroB)"
        else:
            designated = sorted(latest.keys())
            if not designated:
                return "MISSING|no gate verdict on this card at all"
            # QA IS NEVER OPTIONAL IN AN INFERRED SET (card 864351a9, Cybersec's finding). Rule 4
            # makes QA mandatory on every card; an inferred set built purely from whichever verdicts
            # happen to be present can therefore never legitimately omit it. Before this, a single
            # security-gate verdict with no QA at all read as "every designated gate agrees" -- a
            # verdict agreeing with itself. Measured live: 2 of 307 done cards closed exactly this
            # way, on a gate that was never even the one MikroB actually designated.
            if "QA" not in designated:
                designated = sorted(designated + ["QA"])
            source_note = " (gates inferred from the verdicts present)"
    designated = [g.upper() for g in designated]

    missing = [g for g in designated if g not in latest]
    if missing:
        return "MISSING|%s has no verdict%s" % (", ".join(missing), source_note)

    failed = ["%s=%s" % (g, latest[g][1]) for g in designated if latest[g][1] not in PASSING]
    if failed:
        return "FAILED|" + "; ".join(failed)

    # A REFUSAL THAT CANNOT BE SHOWN SUPERSEDED IS NOT A PASS AND NOT A FAIL (card c52e2823, round
    # 2, MikroB's ruling 21139). Placed AFTER the FAILED block on purpose: a refusal this tool can
    # actually read outranks one it cannot, and a card that has both should be bounced on the
    # readable one. Placed BEFORE the attribution and sha questions for the reason the FAILED block
    # gives -- if a stated refusal may still be open, which commit it judged is the second question.
    if any(g in undecidable for g in designated):
        gates = [g for g in designated if g in undecidable]
        return "UNSUPERSEDED|%s|%s|%s -- no Gate-SHA on the refusal, so it cannot be shown to be " \
               "about code that is gone; not closable and not automatically bounced, a human decides" % (
                   ",".join(gates),
                   ",".join(undecidable[g][0] for g in gates),
                   "; ".join("%s=%s by %s, latest verdict %s" % (
                       g, undecidable[g][1], undecidable[g][0], latest[g][1]) for g in gates))

    # NOBODY I CAN NAME SAID THIS PASSED (card 44849954). Placed after FAILED, because a refusal
    # already blocks the closure and naming it is more useful, and BEFORE the sha questions,
    # because if no gate can be held to the verdict then which sha it judged is moot.
    unattributed = sorted(g for g in designated if g in unverified)
    if unattributed:
        return ("UNVERIFIED-AUTHOR|%s passed, but no comment from that gate says so -- the verdict "
                "was written by someone else and comment authorship is self-declared, so this is "
                "not a sign-off anyone can be held to" % ", ".join(unattributed))

    nosha = [g for g in designated if latest[g][2] is None]
    if nosha:
        return "NOSHA|%s gave no Gate-SHA, so agreement cannot be checked (%s)" % (
            ", ".join(nosha),
            "; ".join("%s=%s" % (g, _fmt_shas(latest[g][2])) for g in designated))

    shas = [latest[g][2] for g in designated]
    detail = "; ".join("%s=%s" % (g, _fmt_shas(latest[g][2])) for g in designated)
    for other in shas[1:]:
        if not sha_sets_agree(shas[0], other):
            return "DISAGREE|the latest verdicts judge different shas: " + detail
    suffix = source_note

    # The gates agree. Whether they agree about the code THIS CARD NOW DELIVERS is a second question,
    # and card 2003e04b is the finding that it must be asked WITHOUT being asked for -- the caller who
    # forgets `--expect` is exactly the caller the check was built to protect.
    if expect:
        declared, source = [expect], "--expect"
    elif use_declared:
        declared, source = declared_shas(comments), "the latest REVIEW"
        # CARD 3e4dc2c3 (Cybered): a non-REVIEW comment after the latest REVIEW can declare a NEWER
        # commit ("<finding> JAVITVA -- delta-gate kell") that declared_shas() correctly does not
        # pick up (see its own docstring), but that no designated gate has verdicted on either. The
        # default AGREE below would then be checking a sha nobody who matters has reviewed. This is
        # deliberately scoped to the REVIEW-sourced default only -- an explicit `--expect` is the
        # caller's own assertion and is not second-guessed here (see the header's `--expect` note).
        orphans = undeclared_post_review_shas(comments)
        if orphans:
            return "STALE|%s|%s|a newer sha was declared in a non-REVIEW comment after the latest " \
                   "REVIEW and no designated gate ever verdicted on it (%s)" % (
                       _fmt_shas(shas[0]), ",".join(orphans), detail)
    else:
        declared, source = [], "--no-expect"

    if not declared:
        # CYBERED NO-GO on 1aeed1ca, F2: an explicit n/a on the latest REVIEW is a STATED claim
        # ("no commit was delivered"), not silence -- and every designated gate, at this point in
        # the function, has already been shown to have verdicted on a real commit (the NOSHA check
        # above would have caught a gate with no sha of its own). That is a mismatch, not an
        # agreement, so it must never take the same AGREE path plain silence does.
        if source == "the latest REVIEW" and _latest_review_is_na(comments):
            return "STALE|%s|n/a|the latest REVIEW declares Gate-SHA: n/a (no commit delivered), " \
                   "but the designated gate(s) verdicted on a real commit: %s" % (_fmt_shas(shas[0]), detail)
        # Cybered's plan-grilling condition, and the one that keeps this honest: "no expectation"
        # must never read as "expectation met". It is said out loud instead, in the same place the
        # unstated gate designation is said out loud.
        why = ("no --expect given" if source == "--no-expect"
               else "no REVIEW comment declares a Gate-SHA, so the delivered commit is unchecked")
        return _landed_or(check_landed, shas[0],
                          "AGREE|%s|%s%s (%s)" % (_fmt_shas(shas[0]), detail, suffix, why),
                          card_id, comments)

    if sha_sets_agree(shas[0], declared):
        # CARD cb8ef4f5: the EQUAL-sha branch never asked content_verdict's question at all, because
        # there is nothing to diff when the shas are the same token -- but "the same token" can still
        # be a version-bump commit that carries no card content, the exact 74aa46a5 hazard one door
        # over (there the REVIEW and a gate name DIFFERENT shas and content_verdict catches it; here
        # everyone names the SAME bump sha, so content_verdict never even runs). Measured: 82 distinct
        # bump-sha Gate-SHA lines across 51 cards on this board -- the common shape, not the rare one.
        agreed = next((s for s in shas[0] if any(shas_agree(s, d) for d in declared)), shas[0][0])
        clone = _clone_holding(agreed)
        if clone and _is_version_bump(clone, agreed):
            hint = _bump_parent_hint(clone, agreed)
            hint_s = (" the landing merge is likely %s -- " % hint) if hint else " "
            return "BUMPSHA|%s|%s is a version-bump commit carrying no card content, so nobody can " \
                   "say what it was reviewed for even though every side names it;%sre-check against " \
                   "the real landing merge (card 0711c19b eliminated this shape at the source, so a " \
                   "NEW REVIEW should not produce it going forward)" % (
                       _fmt_shas(shas[0]), agreed, hint_s)
        return _landed_or(check_landed, list(shas[0]) + list(declared),
                          "AGREE|%s|%s%s" % (_fmt_shas(shas[0]), detail, suffix),
                          card_id, comments)

    # The sha differs from the declared one. On this board that is usually benign -- a work commit
    # versus the landing that carried it -- so the difference is judged by CONTENT before it is
    # called stale. See the header for the 38 cases this was measured against.
    kind, why = content_verdict(shas[0], declared)
    joined = ",".join(declared)
    if kind == "same":
        return _landed_or(check_landed, list(shas[0]) + list(declared),
                          "AGREE|%s|%s%s (differs from %s per %s, but %s)" % (
                              _fmt_shas(shas[0]), detail, suffix, joined, source, why),
                          card_id, comments)
    if kind == "differs":
        # Deliberately NOT "the gates are stale". Measured on card edd4c3bf, the opposite happens
        # too: the deliverable moved on in an INFO-ONLY comment that says "nem uj REVIEW", the gates
        # correctly judged the NEWER sha, and it is the REVIEW that is behind. The two commits
        # differ and here are the files -- which of them is the stale one is the reader's call.
        return "STALE|%s|%s|the gates judged a commit whose content differs from the declared one: %s (%s)" % (
            _fmt_shas(shas[0]), joined, why, detail)
    # Unjudgeable, and the right answer depends on WHO said what the card delivers. An explicit
    # `--expect` is the caller ASSERTING it, and rule 4a's documented use is exactly the case where
    # the old sha no longer resolves (rebuilt, rebased, pruned) -- answering UNRESOLVED there would
    # retract a protection the caller asked for by name. A DERIVED expectation is this script's own
    # hypothesis, and it must not accuse a gate on a hypothesis it could not check.
    if source == "--expect":
        return "STALE|%s|%s|the gates agree, but on a commit this card no longer delivers (%s)" % (
            _fmt_shas(shas[0]), joined, detail)
    return "UNRESOLVED|%s|%s|%s (%s)" % (_fmt_shas(shas[0]), joined, why, detail)


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
    argv = sys.argv[1:]
    expect = None
    use_declared = True
    check_landed = True
    # Distinct from `card_id` below (--card-id, the unrelated checkpoint-coverage feature, card
    # <checkpoint>): this one feeds the card_landings-backed NOT-LANDED check (card 634a188c).
    landing_card_id = None
    if "--no-landed" in argv:
        check_landed = False
        argv = [a for a in argv if a != "--no-landed"]
    if "--card" in argv:
        i = argv.index("--card")
        if i + 1 >= len(argv) or not argv[i + 1].strip():
            print("UNREADABLE|--card needs a card id")
            return
        landing_card_id = argv[i + 1].strip()
        del argv[i:i + 2]
    if "--no-expect" in argv:
        use_declared = False
        argv = [a for a in argv if a != "--no-expect"]
    if "--expect" in argv:
        i = argv.index("--expect")
        if i + 1 >= len(argv) or not argv[i + 1].strip():
            print("UNREADABLE|--expect needs a sha")
            return
        expect = argv[i + 1].strip().lower()
        if not re.fullmatch(r"[0-9a-f]{7,40}", expect):
            print("UNREADABLE|--expect is not a sha: %s" % argv[i + 1].strip())
            return
        del argv[i:i + 2]
    card_id = None
    db_path = None
    if "--card-id" in argv:
        i = argv.index("--card-id")
        if i + 1 < len(argv) and argv[i + 1].strip():
            card_id = argv[i + 1].strip()
        del argv[i:i + 2]
    if "--db" in argv:
        i = argv.index("--db")
        if i + 1 < len(argv) and argv[i + 1].strip():
            db_path = argv[i + 1].strip()
        del argv[i:i + 2]
    if card_id and not db_path:
        db_path = os.environ.get("MARVEEN_DB") or os.path.join(
            os.environ.get("MARVEEN_MAIN", "/home/neon/marveen"), "store", "claudeclaw.db"
        )
    designated = None
    if argv and argv[0].strip():
        designated = [g for g in re.split(r"[,\s]+", argv[0].strip()) if g]
        # A designation may name the SIBLING that actually reviewed ("qa2,cybersec"): the board's
        # own `Gate:` lines do, now that rule 4 load-balances the QA role. Normalise it to the role
        # the same way a verdict is normalised, or the caller who copies the card's designation
        # verbatim gets UNREADABLE for a perfectly valid gate set.
        # canonical_gate() also folds a WHITEHAT/REDHAT spelling here (card cf0a8c0b), so a caller
        # that copies the card's own display-name designation verbatim does not get UNREADABLE.
        designated = [canonical_gate(_SIBLING_SUFFIX.sub("", g)) for g in designated]
        unknown = [g for g in designated if g.upper() not in GATES]
        if unknown:
            print("UNREADABLE|not a gate name: %s" % ", ".join(unknown))
            return

    result = check(comments, designated, expect, use_declared, check_landed, landing_card_id)

    if card_id and db_path:
        rev_shas = declared_shas(comments)
        if rev_shas:
            check_sha = next(iter(rev_shas))
            # F1.3 (card 14bfc893): a checkpoint gap (CHECKPOINT_FAIL) means "this is a real
            # commit, just not one of this card's recorded checkpoints" -- a sha that is not a
            # commit object ANYWHERE is a different, worse problem (hand-typed or hallucinated),
            # and must say so distinctly rather than read as the same ordinary coverage gap.
            #
            # Card 06334c7d (CYBERED C1 on 14bfc893's own GO): the old `any_clone_reachable =
            # any(...)` only required ONE clone directory to exist, so a real commit that lives
            # ONLY in the second clone was reported FABRICATED whenever that second clone was
            # unmounted (or its own git call simply timed out) -- "I could not check the clone
            # this commit actually lives in" was misread as "I checked every clone and found
            # nothing".
            #
            # Three outcomes now, by how much was actually checked:
            #   - NO clone reachable at all: unchanged fail-open fallthrough (the original, most
            #     common case -- a dev box with no clones configured) -- same as always.
            #   - SOME but not ALL clones reachable, and the reachable one(s) answer "not found":
            #     UNRESOLVED, not FABRICATED -- the unreachable clone could still hold it, so
            #     "not found where I could look" is not "does not exist anywhere" (the actual
            #     finding: the old code reported FABRICATED here).
            #   - EVERY clone reachable: a timeout on any of them is UNRESOLVED (the same
            #     fail-closed-to-UNRESOLVED convention `check()` already uses elsewhere in this
            #     file for "cannot check"); every one genuinely answering "absent" is FABRICATED.
            # CYBERED C1 condition 2 (card 06334c7d NO-GO 32965): two refinements over the first
            # cut. (a) A reachable clone that ANSWERS "exists" settles the question on its own --
            # it must not be outranked by a DIFFERENT, unreachable configured clone, which says
            # nothing either way. (b) A clone path that exists on disk but is not a usable repo
            # (empty mountpoint, corrupt object store, dubious-ownership refusal) must count as
            # "unreachable", not "absent" -- `git cat-file -e <missing>` and `git -C <non-repo>
            # cat-file ...` both exit 128, so rc alone cannot distinguish "answered no" from
            # "could not answer"; _cat_file_commit_status now checks repo validity first.
            clone_paths = [p for _n, p, _r in _CLONES]
            statuses = [_cat_file_commit_status(p, check_sha) for p in clone_paths]
            reachable_statuses = [s for s in statuses if s != "unreachable"]
            if not reachable_statuses:
                covered, reason = _checkpoint_coverage(card_id, check_sha, db_path)
                if not covered:
                    result = "CHECKPOINT_FAIL|%s|%s" % (check_sha, reason)
            elif any(s == "timeout" for s in reachable_statuses):
                result = "UNRESOLVED|%s|%s|a git call timed out while checking whether this " \
                    "commit exists (--card-id/--db FABRICATED check)" % (check_sha, check_sha)
            elif any(s == "exists" for s in reachable_statuses):
                covered, reason = _checkpoint_coverage(card_id, check_sha, db_path)
                if not covered:
                    result = "CHECKPOINT_FAIL|%s|%s" % (check_sha, reason)
            elif len(reachable_statuses) < len(clone_paths):
                result = "UNRESOLVED|%s|%s|not found in the %d reachable clone(s), but %d " \
                    "configured clone(s) could not be reached -- cannot confirm it does not " \
                    "exist there" % (check_sha, check_sha, len(reachable_statuses),
                                      len(clone_paths) - len(reachable_statuses))
            elif all(s == "absent" for s in reachable_statuses):
                # LOW-2 (CYBERSEC on the same GO): name the limitation, not just the verdict --
                # this only means "not found in the configured clones", never "proven to never
                # have existed anywhere" (an unreachable or unconfigured repo would say so).
                result = "FABRICATED|%s|does not exist as a commit object in any of the %d " \
                    "configured clones searched (%s) -- advisory only, not proof it was never " \
                    "a real commit anywhere" % (
                        check_sha, len(_CLONES), ", ".join(nm for nm, _p, _r in _CLONES))

    print(result)


def _cat_file_commit_status(repo, sha):
    """('exists' | 'absent' | 'timeout' | 'unreachable') for whether `sha^{commit}` resolves in
    `repo`. Deliberately separate from sha_content_equivalence.py's own `_git` (card 06334c7d,
    CYBERED C1): that helper's documented contract is "any failure -- missing git, missing clone,
    timeout -- is a plain False", which is the right call for the AGREE/DISAGREE machinery that
    consumes it everywhere else, but conflates "git could not answer" with "git answered no" for
    the ONE caller (the FABRICATED check below) where that distinction is the entire point.
    Narrowly scoped here rather than changing `_git` itself, so every other caller's behaviour is
    unaffected.
    """
    if not os.path.isdir(repo):
        return "unreachable"
    # CYBERED C1 condition 2b (card 06334c7d NO-GO 32965): a path that exists but is not a
    # usable repo (empty mountpoint, corrupt object store, dubious-ownership refusal) must read
    # as "unreachable", not "absent" -- git exits 128 for a missing clone object just the same
    # as it does for a missing object in a real repo, so rc alone cannot separate the two.
    try:
        gd = subprocess.run(("git", "-C", repo, "rev-parse", "--git-dir"),
                             capture_output=True, text=True, timeout=_GIT_TIMEOUT)
    except subprocess.TimeoutExpired:
        return "timeout"
    except (OSError, subprocess.SubprocessError):
        return "unreachable"
    if gd.returncode != 0:
        return "unreachable"
    try:
        p = subprocess.run(("git", "-C", repo, "cat-file", "-e", sha + "^{commit}"),
                            capture_output=True, text=True, timeout=_GIT_TIMEOUT)
    except subprocess.TimeoutExpired:
        return "timeout"
    except (OSError, subprocess.SubprocessError):
        return "unreachable"
    return "exists" if p.returncode == 0 else "absent"


def _checkpoint_coverage(card_id, gate_sha, db_path):
    """Return (covered: bool, reason: str|None).

    covered=True if no checkpoints recorded yet (transitional / no-checkpoint workflow) or if
    gate_sha matches a head_sha in card_checkpoints. covered=False only when at least one
    checkpoint exists for the card but the declared sha is not among them (genuine gap).
    Errors accessing the DB are fail-open to avoid blocking the board on infra issues.
    """
    try:
        import sqlite3 as _sqlite3
        conn = _sqlite3.connect(db_path)
        try:
            row = conn.execute(
                "SELECT COUNT(*) FROM card_checkpoints WHERE card_id = ?", (card_id,)
            ).fetchone()
            count = row[0] if row else 0
            if count == 0:
                return True, None
            sha_norm = gate_sha.lower()[:40]
            match = conn.execute(
                "SELECT n FROM card_checkpoints WHERE card_id = ? AND head_sha = ?",
                (card_id, sha_norm),
            ).fetchone()
        finally:
            conn.close()
        if match:
            return True, None
        return False, (
            "Gate-SHA %s not in any recorded checkpoint for card %s (%d checkpoint(s) exist)"
            % (gate_sha[:12], card_id, count)
        )
    except Exception:  # noqa: BLE001 -- DB missing / locked / corrupt: fail-open
        return True, None


if __name__ == "__main__":
    main()
