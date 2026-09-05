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

Input:  the card's comments JSON on stdin (the /api/kanban/<id>/comments shape).
        Optional argv[1]: comma-separated designated gates, e.g. "qa,cybersec".
        Optional --expect <sha>: the commit this card delivers NOW. Omitted -> taken from the
        card's latest REVIEW `Gate-SHA:` line; `--no-expect` disables the check entirely.
        Optional argv[1] gates omitted -> inferred from the verdicts present, and the output says
        so, because an UNSTATED designation is exactly how a missing third gate goes unnoticed.
Output: exactly one line.
        AGREE|<sha>|<details>        every designated gate's latest verdict passes, on one sha
        DISAGREE|<details>           the delta-gate hazard: latest verdicts name different shas
        FAILED|<details>             a designated gate's latest verdict is a FAIL/NO-GO
        MISSING|<details>            a designated gate has no verdict at all
        NOSHA|<details>              a latest verdict carries no Gate-SHA, so agreement is unprovable
        STALE|<sha>|<expected>|<why> the gates AGREE, but on a commit whose content differs from the
                                     one this card now declares
        UNRESOLVED|<sha>|<expected>|<why>
                                     the shas differ and the difference could NOT be judged (a clone
                                     is missing, a commit was pruned, git failed). Deliberately not
                                     AGREE: "cannot check" is not "checked and fine".
        UNREADABLE|<why>
Exit:   0 always. The caller decides -- this is a readout, not a gate on the gate.
"""
import json
import os
import re
import subprocess
import sys

GATES = ("QA", "CYBERSEC", "CYBERED")

# The verdict must be the comment's OPENING word (rule 4c), with the `Gate-SHA:` header allowed to
# come first -- both orders exist on the board and both are legitimate. Prose that merely MENTIONS
# "QA PASS" mid-sentence is not a verdict, which is why this anchors rather than searches.
_LEAD_SKIP = re.compile(r"^(?:\s*Gate-SHA:[^\n]*\n|\s*\n)*", re.IGNORECASE)
#
# `(?![-\w])` rather than `\b`: `\b` matches between the S of PASS and the hyphen of
# "QA PASS-eligible", so a BUILDER's own "QA PASS-eligible" line parsed as the QA gate's verdict.
# Measured over 20121 comments, four carry the shape and only one is in the unsafe direction
# (card 65e0b0d5, backend2) -- the others are "QA FAIL-re reagalva" and "CYBERED NO-GO-FELTETEL",
# which parse as FAIL/NO-GO and so err toward refusing a closure. No card's readout changes: on
# 65e0b0d5 the real `qa` verdict follows and latest_per_gate takes the last one. It is fixed because
# the failure direction is a false PASS, not because it has bitten yet.
_VERDICT = re.compile(
    r"^\s*(QA|CYBERSEC|CYBERED)\s*(?:GATE|VERDICT)?\s*:?\s*(PASS|FAIL|GO|NO-GO)(?![-\w])",
    re.IGNORECASE,
)
_SHA_LINE = re.compile(r"^\s*Gate-SHA:\s*([0-9a-fA-F]{7,40})", re.IGNORECASE | re.MULTILINE)
# The whole `Gate-SHA:` value, because rule 4b lets a REVIEW name several commits ("<sha>, <sha>")
# and 68 cards on this board do. A verdict naming ANY of them is judging this card's delivery.
_SHA_VALUES = re.compile(r"^\s*Gate-SHA:\s*(.+)$", re.IGNORECASE | re.MULTILINE)
_SHA_TOKEN = re.compile(r"\b[0-9a-fA-F]{7,40}\b")
# Anchored exactly like the verdict, and for the same reason in mirror image: a comment that QUOTES a
# REVIEW must not be able to supply the expected sha. `_LEAD_SKIP` is shared so the two orders rule
# 4b/4c allow -- verdict first or `Gate-SHA:` first -- work here too.
_REVIEW_OPEN = re.compile(r"^\s*REVIEW\b", re.IGNORECASE)

# Files whose diff between two shas of the SAME work says nothing about the work. Every entry is
# earned by measurement over the 37 mismatching cards, and is listed with the count it cleared:
# package.json (5) moves on every landing because marveen-land bumps the version; DECISIONS.md (4)
# and README.md (2) are append-only and other agents append between the work commit and the landing.
# Nothing else reached the list -- no lockfile, no CLAUDE.md -- because nothing else showed up as a
# sole difference, and an unearned entry here is a place the check quietly stops looking.
_SHARED_CHURN = frozenset(("package.json", "DECISIONS.md", "README.md"))

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


def declared_shas(comments):
    """The shas the LATEST `REVIEW` comment says this card delivers, [] if none says.

    Not "the latest Gate-SHA anywhere": measured both ways over the board, sourcing it from any
    non-verdict comment fixes 8 cards and breaks 8 others, so it buys nothing and loosens the rule.
    """
    found = []
    for c in comments:
        content = (c or {}).get("content")
        if not isinstance(content, str):
            continue
        if not _REVIEW_OPEN.match(content[_LEAD_SKIP.match(content).end():]):
            continue
        m = _SHA_VALUES.search(content)
        if m:
            shas = [s.lower() for s in _SHA_TOKEN.findall(m.group(1))]
            if shas:
                found = shas
    return found


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


_CLONES = (
    ("marveen", os.environ.get("MARVEEN_MAIN", "/home/neon/marveen")),
    ("cleancore", os.environ.get("CLEANCORE_MAIN", "/mnt/h/LM_Studio_Workdir/CleanCore")),
)
# A closure readout must never become the thing that hangs a closure. git on the CleanCore clone
# lives on /mnt/h (drvfs) and is measurably slow; a wedged call answers UNRESOLVED, not AGREE.
_GIT_TIMEOUT = float(os.environ.get("GATE_CLOSURE_GIT_TIMEOUT", "30"))


def _git(repo, *args):
    """(ok, stdout). Any failure -- missing git, missing clone, timeout -- is a plain False."""
    try:
        p = subprocess.run(("git", "-C", repo) + args, capture_output=True, text=True,
                           timeout=_GIT_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return False, ""
    return p.returncode == 0, p.stdout


def _clone_holding(*shas):
    """The clone where ALL of these commits exist, or None.

    Lookup, not declaration -- the same choice store/gate-sha-repo.sh made and measured: of 1076
    distinct Gate-SHAs ever posted, 590 resolve in marveen, 481 in CleanCore, five in neither, and
    ZERO in both, so asking is unambiguous and costs nothing a mandated `Gate-repo:` field would
    have saved. Kept inline rather than shelling out to that script because this needs the clone
    PATH for two more git calls anyway, and because it must not depend on the board being up.
    """
    for _name, path in _CLONES:
        if all(_git(path, "cat-file", "-e", s + "^{commit}")[0] for s in shas):
            return path
    return None


def content_verdict(judged, declared):
    """Did the gates see this card's work, even though the sha they named is not the declared one?

    ("same", why) | ("differs", why) | ("unresolved", why)
    """
    for d in declared:
        clone = _clone_holding(judged, d)
        if clone is None:
            continue
        # `log -1 --first-parent`, not `show`: `git show --name-only` prints NOTHING for a merge
        # commit, and a REVIEW naming the LANDING rather than the work commit is one of the two
        # shapes this board actually uses. Measured: it silently emptied the file list on 8 of the
        # 37 mismatching cards, which then read as "no files differ" -- a vacuous pass on exactly
        # the cards the check exists for. `--first-parent` gives what the landing brought in, and
        # is identical to `show` on an ordinary commit (verified on 5ce2a92b: 6 files either way).
        ok, out = _git(clone, "log", "-1", "--name-only", "--format=", "--first-parent", d)
        if not ok:
            continue
        files = [f for f in out.split("\n") if f.strip()]
        if not files:
            # An empty commit delivers nothing whose content could differ. Saying "same" here would
            # be a vacuous pass, so this is left to the next declared sha / reported as unresolved.
            continue
        ok, out = _git(clone, "diff", "--name-only", judged, d, "--", *files)
        if not ok:
            continue
        changed = [f for f in out.split("\n") if f.strip()]
        real = [f for f in changed if os.path.basename(f) not in _SHARED_CHURN]
        # Card 74aa46a5. The `if not files` guard above refuses to call an EMPTY delivery "same",
        # and the churn subtraction on the next line can empty the comparison a second time, at a
        # point that guard no longer covers: when EVERY file the declared commit delivers is one of
        # the churn names, removing them leaves nothing, and "no real difference remains" is then
        # indistinguishable from "nothing was ever compared". Measured on the live board: 14 cards
        # answered AGREE that way, four of them (99fccbcf, e5b7ff19, a14812e8, f1b3f2f0) because the
        # REVIEW named a `chore(version)` bump -- a commit that delivers package.json and nothing
        # else, so the subtraction is total by construction.
        #
        # `changed` must be non-empty to reach this: when the churn files are byte-identical too,
        # nothing differs anywhere and "same" is the honest answer, unchanged. And `comparable` must
        # be empty: a card that delivers real files which simply did not differ WAS compared, and
        # keeps its pass.
        comparable = [f for f in files if os.path.basename(f) not in _SHARED_CHURN]
        if not real and changed and not comparable:
            hint = ""
            ok_s, subj = _git(clone, "log", "-1", "--format=%s", d)
            if ok_s and subj.strip().startswith("chore(version): bump"):
                hint = (" -- %s is a version bump, so the REVIEW is naming the develop tip instead "
                        "of the landing merge that carries the work (card 0711c19b)" % d)
            return ("unresolved",
                    "every file %s delivers is per-landing churn (%s), so ignoring it leaves "
                    "nothing to compare%s" % (d, ", ".join(sorted(set(files))), hint))
        if not real:
            skipped = " (ignoring %s)" % ", ".join(sorted(set(changed))) if changed else ""
            return ("same", "%s and %s hold identical content for the %d file(s) %s delivers%s"
                    % (judged, d, len(files), d, skipped))
        return ("differs", "%s and %s differ in %s" % (judged, d, ", ".join(sorted(real)[:5])))
    return ("unresolved",
            "could not resolve %s and %s to one clone, so the difference could not be judged"
            % (judged, "/".join(declared)))


def check(comments, designated=None, expect=None, use_declared=True):
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

    # The gates agree. Whether they agree about the code THIS CARD NOW DELIVERS is a second question,
    # and card 2003e04b is the finding that it must be asked WITHOUT being asked for -- the caller who
    # forgets `--expect` is exactly the caller the check was built to protect.
    if expect:
        declared, source = [expect], "--expect"
    elif use_declared:
        declared, source = declared_shas(comments), "the latest REVIEW"
    else:
        declared, source = [], "--no-expect"

    if not declared:
        # Cybered's plan-grilling condition, and the one that keeps this honest: "no expectation"
        # must never read as "expectation met". It is said out loud instead, in the same place the
        # unstated gate designation is said out loud.
        why = ("no --expect given" if source == "--no-expect"
               else "no REVIEW comment declares a Gate-SHA, so the delivered commit is unchecked")
        return "AGREE|%s|%s%s (%s)" % (shas[0], detail, suffix, why)

    if any(shas_agree(shas[0], d) for d in declared):
        return "AGREE|%s|%s%s" % (shas[0], detail, suffix)

    # The sha differs from the declared one. On this board that is usually benign -- a work commit
    # versus the landing that carried it -- so the difference is judged by CONTENT before it is
    # called stale. See the header for the 38 cases this was measured against.
    kind, why = content_verdict(shas[0], declared)
    joined = ",".join(declared)
    if kind == "same":
        return "AGREE|%s|%s%s (differs from %s per %s, but %s)" % (
            shas[0], detail, suffix, joined, source, why)
    if kind == "differs":
        # Deliberately NOT "the gates are stale". Measured on card edd4c3bf, the opposite happens
        # too: the deliverable moved on in an INFO-ONLY comment that says "nem uj REVIEW", the gates
        # correctly judged the NEWER sha, and it is the REVIEW that is behind. The two commits
        # differ and here are the files -- which of them is the stale one is the reader's call.
        return "STALE|%s|%s|the gates judged a commit whose content differs from the declared one: %s (%s)" % (
            shas[0], joined, why, detail)
    # Unjudgeable, and the right answer depends on WHO said what the card delivers. An explicit
    # `--expect` is the caller ASSERTING it, and rule 4a's documented use is exactly the case where
    # the old sha no longer resolves (rebuilt, rebased, pruned) -- answering UNRESOLVED there would
    # retract a protection the caller asked for by name. A DERIVED expectation is this script's own
    # hypothesis, and it must not accuse a gate on a hypothesis it could not check.
    if source == "--expect":
        return "STALE|%s|%s|the gates agree, but on a commit this card no longer delivers (%s)" % (
            shas[0], joined, detail)
    return "UNRESOLVED|%s|%s|%s (%s)" % (shas[0], joined, why, detail)


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
    designated = None
    if argv and argv[0].strip():
        designated = [g for g in re.split(r"[,\s]+", argv[0].strip()) if g]
        unknown = [g for g in designated if g.upper() not in GATES]
        if unknown:
            print("UNREADABLE|not a gate name: %s" % ", ".join(unknown))
            return
    print(check(comments, designated, expect, use_declared))


if __name__ == "__main__":
    main()
