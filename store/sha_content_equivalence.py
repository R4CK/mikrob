"""Do two shas deliver the SAME content, even when they are not the same token? (card ec34c025,
rescope point 5 of ed332869's shared-contract scope.)

Extracted out of gate-closure-check.py, where this question was answered inline. The entry point
is `content_verdict(judged, declared)`: resolve both sha collections to the one clone that holds
them, diff the files the declared commit touches (minus known per-landing churn -- package.json,
DECISIONS.md, README.md, which move on every landing and between agents regardless of this card's
own content), and say whether what changed is real.

WHY THIS IS SHA EQUIVALENCE, NOT SHA EQUALITY (measured before gate-closure-check.py shipped it,
see that file's own header for the full numbers): of 557 cards gate-closure-check.py called AGREE,
38 had a REVIEW sha differing from the sha the gates judged, and 23 of those 38 were provably
benign -- the work commit versus the landing merge that carried it, or per-landing churn. Comparing
tokens would have cried wolf on 6.8% of closures, three fifths of them falsely.

Every behavioural comment and the exact file list (_SHARED_CHURN) are carried over unchanged from
gate-closure-check.py; this is a house move, not a rewrite -- gate-closure-check.py's own
"no behaviour change" acceptance criterion (card ec34c025) depends on that.
"""
import os
import subprocess

from env_compat_lib import env_compat_get  # noqa: E402  (sits with the constant it defines)

# Files whose diff between two shas of the SAME work says nothing about the work. Every entry is
# earned by measurement over the 37 mismatching cards, and is listed with the count it cleared:
# package.json (5) moves on every landing because marveen-land bumps the version; DECISIONS.md (4)
# and README.md (2) are append-only and other agents append between the work commit and the landing.
# Nothing else reached the list -- no lockfile, no CLAUDE.md -- because nothing else showed up as a
# sole difference, and an unearned entry here is a place the check quietly stops looking.
_SHARED_CHURN = frozenset(("package.json", "DECISIONS.md", "README.md"))

# (name, clone path, the ref that IS the shipped product). A gate-approved commit that is not an
# ancestor of this ref exists only on a branch (card e65c480a).
# MOPSION_MAIN read first (card 22835648 round 4, Cybered NO-GO 28967): this was reading only the
# retired CLEANCORE_MAIN name directly, so a session with only MOPSION_MAIN set decided
# landed/UNLANDED/UNRESOLVED against the default clone while the landing scripts used the real one.
_CLONES = (
    ("marveen", os.environ.get("MARVEEN_MAIN", "/home/neon/marveen"), "origin/develop"),
    ("cleancore", env_compat_get("MOPSION_MAIN", "CLEANCORE_MAIN", "/mnt/h/LM_Studio_Workdir/mopsion"), "origin/main"),
)
# One knob, for replaying a past state (the selftest points this at the sha main stood on when the
# founding case closed) or for a clone whose default branch is named differently. Empty = per-clone
# default above.
_MAIN_REF_OVERRIDE = os.environ.get("GATE_CLOSURE_MAIN_REF", "").strip()
# A closure readout must never become the thing that hangs a closure. git on the CleanCore clone
# lives on /mnt/h (drvfs) and is measurably slow; a wedged call answers UNRESOLVED, not AGREE.
_GIT_TIMEOUT = float(os.environ.get("GATE_CLOSURE_GIT_TIMEOUT", "30"))

_BUMP_SUBJECT_PREFIX = "chore(version): bump"


def _git(repo, *args):
    """(ok, stdout). Any failure -- missing git, missing clone, timeout -- is a plain False."""
    try:
        p = subprocess.run(("git", "-C", repo) + args, capture_output=True, text=True,
                           timeout=_GIT_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return False, ""
    return p.returncode == 0, p.stdout


def shas_agree(a, b):
    """Prefix-compatible, because the board carries both short and long shas for the same commit."""
    return a == b or a.startswith(b) or b.startswith(a)


def sha_sets_agree(a, b):
    """Do these two sha COLLECTIONS name a commit in common (card f53ef8e4)?

    Rule 4b lets one Gate-SHA line carry several commits, and two gates that both delta-gated the
    same pair can legitimately write them in different orders or lead with a different one --
    comparing only the first token of each turned that into a false DISAGREE even though the sets
    intersect on the sha that actually matters. Prefix-compatible per pair, same as shas_agree.
    """
    return any(shas_agree(x, y) for x in a for y in b)


def _clone_holding(*shas):
    """The clone where ALL of these commits exist, or None.

    Lookup, not declaration -- the same choice store/gate-sha-repo.sh made and measured: of 1076
    distinct Gate-SHAs ever posted, 590 resolve in marveen, 481 in CleanCore, five in neither, and
    ZERO in both, so asking is unambiguous and costs nothing a mandated `Gate-repo:` field would
    have saved. Kept inline rather than shelling out to that script because this needs the clone
    PATH for two more git calls anyway, and because it must not depend on the board being up.
    """
    found = _clone_and_ref_holding(*shas)
    return found[0] if found else None


def _clone_and_ref_holding(*shas):
    """(clone path, main ref) for the clone holding ALL of these commits, or None."""
    for _name, path, ref in _CLONES:
        if all(_git(path, "cat-file", "-e", s + "^{commit}")[0] for s in shas):
            return path, (_MAIN_REF_OVERRIDE or ref)
    return None


def _is_version_bump(clone, sha):
    """Does `sha`'s own commit subject say it is a marveen-land version bump? Factored out so the
    EQUAL-sha branch (card cb8ef4f5) can ask it too, without content_verdict ever running."""
    ok, subj = _git(clone, "log", "-1", "--format=%s", sha)
    return ok and subj.strip().startswith(_BUMP_SUBJECT_PREFIX)


def _bump_parent_hint(clone, sha):
    """The bump commit's own first parent, or None. marveen-land.sh commits the version bump
    directly on top of the merge it just landed, so the parent is usually the real landing merge a
    REVIEW should have named instead of the bump (card cb8ef4f5) -- a hint, not a claim: a squashed
    or hand-made bump could have a different parent, so this is offered, never asserted."""
    ok, out = _git(clone, "log", "-1", "--format=%H", sha + "^")
    return out.strip() if ok and out.strip() else None


def content_verdict(judged, declared):
    """Did the gates see this card's work, even though the sha they named is not the declared one?

    `judged` is an ITERABLE of shas (card f53ef8e4: rule 4b lets a verdict name more than one),
    tried against each `declared` sha the same way `declared` was already tried in order -- first
    resolvable pair wins. A single-element `judged` behaves exactly as a single-sha argument did.

    ("same", why) | ("differs", why) | ("unresolved", why)
    """
    for j in judged:
        for d in declared:
            clone = _clone_holding(j, d)
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
                # An empty commit delivers nothing whose content could differ. Saying "same" here
                # would be a vacuous pass, so this is left to the next declared sha / reported as
                # unresolved.
                continue
            ok, out = _git(clone, "diff", "--name-only", j, d, "--", *files)
            if not ok:
                continue
            changed = [f for f in out.split("\n") if f.strip()]
            real = [f for f in changed if os.path.basename(f) not in _SHARED_CHURN]
            # Card 74aa46a5. The `if not files` guard above refuses to call an EMPTY delivery "same",
            # and the churn subtraction on the next line can empty the comparison a second time, at a
            # point that guard no longer covers: when EVERY file the declared commit delivers is one
            # of the churn names, removing them leaves nothing, and "no real difference remains" is
            # then indistinguishable from "nothing was ever compared". Measured on the live board: 14
            # cards answered AGREE that way, four of them (99fccbcf, e5b7ff19, a14812e8, f1b3f2f0)
            # because the REVIEW named a `chore(version)` bump -- a commit that delivers package.json
            # and nothing else, so the subtraction is total by construction.
            #
            # `changed` must be non-empty to reach this: when the churn files are byte-identical too,
            # nothing differs anywhere and "same" is the honest answer, unchanged. And `comparable`
            # must be empty: a card that delivers real files which simply did not differ WAS
            # compared, and keeps its pass.
            comparable = [f for f in files if os.path.basename(f) not in _SHARED_CHURN]
            if not real and changed and not comparable:
                hint = ""
                if _is_version_bump(clone, d):
                    hint = (" -- %s is a version bump, so the REVIEW is naming the develop tip "
                            "instead of the landing merge that carries the work (card 0711c19b)" % d)
                return ("unresolved",
                        "every file %s delivers is per-landing churn (%s), so ignoring it leaves "
                        "nothing to compare%s" % (d, ", ".join(sorted(set(files))), hint))
            if not real:
                skipped = " (ignoring %s)" % ", ".join(sorted(set(changed))) if changed else ""
                return ("same", "%s and %s hold identical content for the %d file(s) %s delivers%s"
                        % (j, d, len(files), d, skipped))
            return ("differs", "%s and %s differ in %s" % (j, d, ", ".join(sorted(real)[:5])))
    return ("unresolved",
            "could not resolve %s and %s to one clone, so the difference could not be judged"
            % ("/".join(judged), "/".join(declared)))
