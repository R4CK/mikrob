#!/usr/bin/env python3
"""Read a card's comments (JSON on stdin) and say whether a gate verdict covers a given sha.

Split out of landing-gate-verdict-check.sh rather than inlined as `python3 -c`: the shell there
already pipes the API body in on stdin, and a `python3 -` heredoc would have fought that same
stdin. A file takes the program out of the argument list entirely, and makes the parser testable
without a dashboard.

Usage:  landing-gate-verdict-parse.py <sha> < comments.json
Prints exactly one line: OK|... FAILED|... UNVERIFIED-AUTHOR|... NOQA|... OTHERSHA|...
                         NONE|... UNREADABLE|...
"""
import json
import re
import sys

# WHO MAY SPEAK FOR A GATE. Shared with gate-closure-check.py rather than copied -- see that
# module for the measurements. Imported by name because both files live in store/, which is
# sys.path[0] whenever either is run as a script (and both only ever are).
from gate_author_role import author_role, canonical_gate

# GENERATED-COMMENT AUTHORS (card 60aeca01, F3/F4 -- e7f91eb9/d8d035f8 follow-up). Mirrors
# gate-closure-check.py's own GENERATED_COMMENT_AUTHORS (and kanban-landed-guard.ts's, TS side) --
# duplicated, not imported, same reasoning as that file's own comment on the set. Without this, a
# machine-generated comment (a local-llm draft, or a gate-pretriage candidate note) whose raw,
# unfenced text happens to start with a verdict-shaped first line and carry a Gate-SHA line for
# THIS sha is read by the FAIL branch below exactly like a real gate's refusal -- the FAIL branch
# is deliberately NOT author-role-checked (see its own comment), so nothing else in this file was
# stopping a generated comment from blocking a landing it never actually gated.
GENERATED_COMMENT_AUTHORS = {"local-llm", "gate-pretriage"}


def _is_generated_author(c):
    return ((c or {}).get("author") or "").strip().lower() in GENERATED_COMMENT_AUTHORS

# Rule 4c: the verdict word is the comment's FIRST line. Rule 4b: `Gate-SHA:` is its own line.
#
# `QA2?` -- A GATE ROLE MAY BE STAFFED BY MORE THAN ONE AGENT (card c52e2823). Rule 4 requires
# load-balancing between same-capability gate siblings (today QA/QA2), and only ONE of a pair
# reviews a given card, so a sibling's verdict IS that role's verdict. Without the digit `QA2 PASS`
# matched nothing: every card QA2 gated refused to land with the message "a security gate passed
# this sha but QA did not" -- an assertion that a verdict is absent while it sits on the card.
# Measured on 5433c74c, where all three gates had passed and the landing refused twice.
#
# The digit belongs on FAIL as much as on PASS, and that direction is the sharper one: a `QA2 FAIL`
# the parser cannot see is a REFUSAL that vanishes, and this file's ordering ("a failing verdict for
# THIS sha outranks a passing one") can only rank a refusal it recognises.
# WHITEHAT/REDHAT (card cf0a8c0b): display-name aliases for CYBERSEC/CYBERED, accepted alongside
# the canonical word. The literal `2?` after each word is the SAME sibling-digit tolerance as
# `QA2?` above (only "2" -- the one sibling that actually exists, same as QA/QA2, not an arbitrary
# digit), now also on CYBERSEC/WHITEHAT (card 21abfe0b, the cybersec2/WhiteHat2 sibling): the
# measured incident that forced `QA2?` applies identically if a sibling ever writes "CYBERSEC2 GO"
# literally.
#
# CYBERED/REDHAT deliberately does NOT get the same `2?` (QA caught this, card 21abfe0b comment
# 16214, F2): cybered2/RedHat2 does not exist. store/gate-role.sh has no "redhat2" role, and
# store/gate_scan_lib.py's own CLAIMS-equivalent already stayed narrow for exactly this reason --
# this file drifted from it in the same commit that added the cybersec2 fold. Letting `2?` match
# here meant a forged `{"author":"cybered2","content":"CYBERED2 GO\nGate-SHA: ..."}` comment both
# PASS-matched and claimed_role()=="CYBERED", and author_role("cybered2") (an EARLIER, unrelated
# digit-stripping rule in gate_author_role.py, card cf0a8c0b) already answered "CYBERED" too -- so
# the two agreed and the forged line slipped past the UNVERIFIED-AUTHOR branch into `other_passes`
# as if a real sibling had spoken. Measured NOT to change main()'s push/no-push decision (OK only
# ever depends on qa_passes), so this was a misleading-text risk, not a landing-bypass -- fixed
# anyway, narrowly, rather than left for the day cybered2 is invented for real.
PASS = re.compile(r"^(QA2?\s+PASS|(?:CYBERSEC|WHITEHAT)2?\s+GO|(?:CYBERED|REDHAT)\s+GO)\b", re.I)
FAIL = re.compile(r"^(QA2?\s+FAIL|(?:CYBERSEC|WHITEHAT)2?\s+NO-GO|(?:CYBERED|REDHAT)\s+NO-GO)\b", re.I)
QA = re.compile(r"^QA2?\s+PASS\b", re.I)
# Which gate the verdict WORD claims to be. Same fold as the author side: the sibling digit is
# not a separate gate. claimed_role() below folds a captured WHITEHAT/REDHAT to its canonical name.
CLAIMS = re.compile(r"^(QA)2?\b|^(CYBERSEC|WHITEHAT)2?\b|^(CYBERED|REDHAT)\b", re.I)
GATE_SHA_LINE = re.compile(r"^\s*Gate-SHA:\s*(.+)", re.I)
HEX = re.compile(r"[0-9a-f]{7,40}", re.I)

# SUPERSEDES (card 22c4c31f, MikroB Fix-Direction, msg 21415 + comment 33786 on 055114ee). A gate's
# OWN later verdict on the SAME sha may override its OWN earlier FAIL -- the opt-in the config-only
# re-gate case (rule 4e) needs, since a config-only fix legitimately keeps the same Gate-SHA and the
# old FAIL would otherwise outrank the new PASS forever, and --allow-ungated cannot reach a FAILED
# verdict by design (it only tolerates a MISSING one). Deliberately narrow: this is NOT the same
# fold the author-role check uses elsewhere (QA2's verdict counts as QA's for the mandatory-gate
# check) -- here "qa supersedes qa, qa2 supersedes qa2, never cross-role" per the Fix-Direction
# means the LITERAL author string, because the agent that re-checked and the agent whose earlier
# FAIL is being lifted must be the same one: a sibling did not necessarily re-run the same check.
SUPERSEDES_LINE = re.compile(r"^\s*Supersedes:\s*(.+)", re.I)
COMMENT_ID = re.compile(r"\d+")


def shas_in(text):
    found = set()
    for line in text.split("\n"):
        m = GATE_SHA_LINE.match(line)
        if m:
            for tok in HEX.findall(m.group(1)):
                found.add(tok.lower())
    return found


def supersedes_ids(text):
    ids = set()
    for line in text.split("\n"):
        m = SUPERSEDES_LINE.match(line)
        if m:
            for tok in COMMENT_ID.findall(m.group(1)):
                ids.add(int(tok))
    return ids


def claimed_role(first_line):
    """The gate this verdict SAYS it comes from, or None if the line is not a verdict."""
    m = CLAIMS.match(first_line)
    return canonical_gate(next(g for g in m.groups() if g)) if m else None


# A sha short enough to prefix-match half the repo is not an identification. Git's own short form
# is 7, so that is the floor. The check below rejects anything shorter OUTRIGHT rather than
# comparing with it.
MIN_SHA = 7


def covers(found, sha):
    # Short shas are the norm in these comments, so accept a prefix either way.
    #
    # The guard here used to be `f and ...`, protecting against an empty entry in `found`. That was
    # dead code -- HEX requires 7+ characters, so an entry can never be empty -- and a mutation
    # deleting it changed nothing, which is how the misplacement surfaced. The live danger is the
    # OTHER operand: with an empty `sha`, `f.startswith("")` is True for every verdict on the card,
    # so the check would pass on a completely unrelated commit. That case is rejected before we get
    # here (see main), and this stays a plain comparison.
    s = sha.lower()
    return any(s.startswith(f) or f.startswith(s) for f in found)


def main():
    if len(sys.argv) < 2:
        print("UNREADABLE|no sha given")
        return 0
    sha = sys.argv[1].strip()
    if len(sha) < MIN_SHA:
        # Fail-closed: refuse mode turns UNREADABLE into a refusal, which is the right answer for
        # "I was not told which commit to check".
        print(f"UNREADABLE|sha {sha!r} is shorter than {MIN_SHA} chars -- refusing to prefix-match on it")
        return 0
    try:
        doc = json.load(sys.stdin)
    except Exception as exc:
        print(f"UNREADABLE|{exc}")
        return 0
    comments = doc.get("comments", doc) if isinstance(doc, dict) else doc
    if not isinstance(comments, list):
        print("UNREADABLE|unexpected response shape")
        return 0

    qa_passes, other_passes, unattributed, fails, any_pass = [], [], [], [], False
    # fails_by_id: only FAILs that name THIS sha, keyed by comment id -- the thing a later PASS's
    # Supersedes line can reach. Built incrementally as we scan, so a PASS can only supersede a FAIL
    # that already appears EARLIER in `comments` (condition (c)): if the FAIL comes later in the
    # list it simply is not in this dict yet when the PASS is processed, so nothing matches it.
    fails_by_id = {}
    for c in comments:
        if not isinstance(c, dict):
            continue
        if _is_generated_author(c):
            continue
        text = (c.get("content") or "").strip()
        first = text.split("\n")[0].strip()
        who = c.get("author") or "?"
        cid = c.get("id")
        if PASS.match(first):
            any_pass = True
            if covers(shas_in(text), sha):
                # A PASS MUST COME FROM THE GATE IT CLAIMS TO BE (card 48b0dd36, Cybersec).
                #
                # This tool decides whether a push to origin/develop happens, and until now it
                # authenticated a verdict by its TEXT SHAPE alone: any author whose comment began
                # `QA PASS` and carried a `Gate-SHA:` line satisfied the mandatory QA requirement.
                # A maker could sign off their own work by writing the words.
                #
                # Author checking is not authentication -- the kanban API takes the author from the
                # request body under one shared token -- but a verdict that does not even CLAIM to
                # come from the gate is not that gate's verdict, and that is the cheap half.
                if author_role(who) != claimed_role(first):
                    unattributed.append(f"{who}: {first[:40]}")
                else:
                    # SUPERSEDES opt-in (card 22c4c31f): a LEGITIMATE PASS (author checked above)
                    # may name earlier FAIL comment ids to lift. Condition (b), literal author
                    # match, not the QA/QA2 role-fold -- see the module docstring on SUPERSEDES_LINE.
                    for target_id in supersedes_ids(text):
                        target = fails_by_id.get(target_id)
                        if (target is not None and not target["superseded"]
                                and target["who"].strip().lower() == who.strip().lower()):
                            target["superseded"] = True
                    # Rule 4 makes QA mandatory on EVERY card; a security gate is risk-tiered on
                    # top. So a lone `CYBERSEC GO` is not evidence the card was gated, only that
                    # half of it was -- it is reported, but it does not satisfy the check.
                    if QA.match(first):
                        qa_passes.append(f"{who}: {first[:40]}")
                    else:
                        other_passes.append(f"{who}: {first[:40]}")
        elif FAIL.match(first):
            if covers(shas_in(text), sha):
                # DELIBERATELY NOT AUTHOR-CHECKED, and the asymmetry is the whole design. An
                # unattributable PASS is not a pass; an unattributable REFUSAL is still a refusal.
                # Requiring a role author here would DROP relayed refusals -- MikroB's own
                # "<GATE> <VERDICT> ELFOGADVA" restatement is the routine shape on this board --
                # and let a landing proceed over a stated NO-GO. That is strictly worse than the
                # hole being closed, so a failing verdict stands whoever wrote it. A relayed FAIL's
                # `who` (e.g. "mikrob") can never literal-match a real gate author's Supersedes
                # line, so it stays unsupersedable by construction (Fix-Direction condition (b)).
                entry = {"who": who, "label": f"{who}: {first[:40]}", "superseded": False}
                fails.append(entry)
                if cid is not None:
                    fails_by_id[cid] = entry

    # A failing verdict for THIS sha outranks a passing one: a re-gate after a fix lands a new sha,
    # so a pass and a fail naming the same sha means the fix was never re-gated -- UNLESS that fail
    # was explicitly superseded by the opt-in above.
    active_fails = [f["label"] for f in fails if not f["superseded"]]
    if active_fails:
        print("FAILED|" + "; ".join(active_fails))
    elif qa_passes:
        extra = ("; also " + "; ".join(other_passes)) if other_passes else ""
        print("OK|" + "; ".join(qa_passes) + extra)
    elif unattributed:
        # Ranked above NOQA because it is the more specific complaint: something verdict-shaped
        # names this sha, and the reason it does not count is WHO wrote it. Any kind other than OK
        # refuses in the lander's refuse mode, so a new word here is fail-closed by construction.
        print("UNVERIFIED-AUTHOR|a verdict for this sha was written by someone who does not hold "
              "that gate's role (" + "; ".join(unattributed)
              + ") -- a gate's own PASS is what this check needs")
    elif other_passes:
        print("NOQA|a security gate passed this sha (" + "; ".join(other_passes)
              + ") but QA did not -- rule 4 makes QA mandatory on every card")
    elif any_pass:
        print("OTHERSHA|a gate verdict exists on this card, but none of them names this sha")
    else:
        print("NONE|no QA/Cybersec(WhiteHat)/Cybered(RedHat) verdict on this card at all")
    return 0


if __name__ == "__main__":
    sys.exit(main())
