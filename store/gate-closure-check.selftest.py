#!/usr/bin/env python3
"""Self-test for gate-closure-check.py (card 1c4f9af1).

THE TWO POPULATIONS THIS MUST SEPARATE, and getting them confused in either direction makes the
check worthless:
  HEALTHY  -- a card whose history holds several shas because a NO-GO was fixed and everyone
              re-gated. Flagging these would hit a third of the board and be ignored within a day.
  HAZARD   -- the latest verdicts of the designated gates name DIFFERENT shas, so "every gate
              passed" is true and "they reviewed the same code" is not.

The synthetic cases below pin the rule; the numbers in the header of gate-closure-check.py come from
running it over the real board, where 10 cards carry mixed shas across their history and only 4 of
them are the hazard.
"""
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile

CHECK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gate-closure-check.py")

failures = []
n = 0


def run(comments, gates=None, expect=None, extra=(), env=None):
    args = [sys.executable, CHECK] + ([gates] if gates else []) \
        + (["--expect", expect] if expect else []) + list(extra)
    e = dict(os.environ)
    # Point the clone lookup at nothing by default, so a case that does not build a repo cannot
    # accidentally read the real marveen/CleanCore checkouts and change answer with the machine.
    e.setdefault("MARVEEN_MAIN", "/nonexistent-marveen")
    e.setdefault("CLEANCORE_MAIN", "/nonexistent-cleancore")
    if env:
        e.update(env)
    p = subprocess.run(args, input=json.dumps({"comments": comments}),
                       capture_output=True, text=True, env=e)
    return p.stdout.strip()


def c(author, content):
    return {"author": author, "content": content}


def case(label, comments, expect_kind, gates=None, expect_sha=None, extra=(), env=None):
    global n
    n += 1
    got = run(comments, gates, expect_sha, extra, env)
    kind = got.split("|", 1)[0]
    ok = kind == expect_kind
    print("%s %-9s <- %-9s %s" % ("OK  " if ok else "FAIL", expect_kind, kind, label))
    if not ok:
        failures.append((label, expect_kind, got))


V = "QA PASS\nGate-SHA: %s"
S = "CYBERSEC GO\nGate-SHA: %s"
D = "CYBERED GO\nGate-SHA: %s"

print("gate-closure-check selftest")

# --- THE HAZARD -------------------------------------------------------------------------------
case("the delta-gate hazard: QA re-ran on the fix, Cybersec did not",
     [c("qa", V % "bbbb2222"), c("cybersec", S % "aaaa1111")], "DISAGREE")
case("...and the same with three gates, one left behind",
     [c("qa", V % "bbbb2222"), c("cybersec", S % "bbbb2222"), c("cybered", D % "aaaa1111")],
     "DISAGREE")

# --- THE HEALTHY SHAPE, which must NOT be flagged ----------------------------------------------
case("a full re-gate after a NO-GO: old verdicts remain, latest agree",
     [c("qa", "QA FAIL\nGate-SHA: aaaa1111"), c("cybersec", "CYBERSEC NO-GO\nGate-SHA: aaaa1111"),
      c("qa", V % "bbbb2222"), c("cybersec", S % "bbbb2222")], "AGREE")
case("one gate verdicted twice on the same sha (a delta review, no new code)",
     [c("qa", V % "bbbb2222"), c("qa", V % "bbbb2222"), c("cybersec", S % "bbbb2222")], "AGREE")
case("short sha in one verdict, long sha in another, same commit",
     [c("qa", V % "bbbb2222"), c("cybersec", S % "bbbb222233334444")], "AGREE")

# --- OUTCOMES THAT ARE NOT ABOUT AGREEMENT -----------------------------------------------------
case("a designated gate never verdicted at all",
     [c("qa", V % "bbbb2222")], "MISSING", "qa,cybersec")
case("no verdict anywhere on the card",
     [c("mikrob", "dispatcheltem a gate-eknek")], "MISSING")
case("the LATEST verdict of a gate is a FAIL, even though an older one passed",
     [c("qa", V % "aaaa1111"), c("qa", "QA FAIL\nGate-SHA: bbbb2222")], "FAILED")
case("an open NO-GO outranks the sha question",
     [c("qa", V % "bbbb2222"), c("cybered", "CYBERED NO-GO\nGate-SHA: bbbb2222")], "FAILED")

# --- THE 8% THAT CARRY NO Gate-SHA -------------------------------------------------------------
# Rule 4b made the line optional and 70 of 76 verdicts on this board have it. A blanket refusal on
# the remaining 8% would train everyone to skip the check, so this is its own answer.
case("a latest verdict with no Gate-SHA cannot be compared, and says so",
     [c("qa", "QA PASS"), c("cybersec", S % "bbbb2222")], "NOSHA")

# --- --expect: AGREEING ON THE WRONG COMMIT ----------------------------------------------------
# Measured in production (c458ba0e/acab6155/f8b52ff2, 2026-09-04). After a card's work is rebuilt,
# rebased or cherry-picked, BOTH old verdicts still name the same OLD sha -- so they agree perfectly
# and this printed AGREE for code that no longer existed anywhere. The original hazard was gates on
# DIFFERENT shas; this is gates on the WRONG one, in agreement, which reads as "safe to close".
case("the gates agree, but on a commit the card no longer delivers",
     [c("qa", V % "aaaa1111"), c("cybersec", S % "aaaa1111")], "STALE",
     gates="qa,cybersec", expect_sha="bbbb2222")
case("...and when the agreed sha IS the delivered one, it is still AGREE",
     [c("qa", V % "aaaa1111"), c("cybersec", S % "aaaa1111")], "AGREE",
     gates="qa,cybersec", expect_sha="aaaa1111")
case("--expect is prefix-compatible, like the agreement check itself",
     [c("qa", V % "aaaa1111"), c("cybersec", S % "aaaa1111")], "AGREE",
     gates="qa,cybersec", expect_sha="aaaa111122223333")

# --expect must NOT outrank the answers that already say "do not close". A FAIL is still a FAIL
# whatever commit it names, and a missing gate is still missing.
case("a FAILING gate outranks --expect, whatever sha is passed",
     [c("qa", V % "aaaa1111"), c("cybersec", "CYBERSEC NO-GO\nGate-SHA: aaaa1111")], "FAILED",
     gates="qa,cybersec", expect_sha="bbbb2222")
case("a MISSING gate outranks --expect too",
     [c("qa", V % "aaaa1111")], "MISSING", gates="qa,cybersec", expect_sha="bbbb2222")
case("NOSHA outranks --expect: an uncomparable verdict cannot be called stale",
     [c("qa", "QA PASS"), c("cybersec", S % "aaaa1111")], "NOSHA",
     gates="qa,cybersec", expect_sha="bbbb2222")

# THE COMPATIBILITY CASE. Rule 4a's documented invocation passes no --expect, and that call must
# behave exactly as it did before this flag existed.
case("WITHOUT --expect the old behaviour is unchanged",
     [c("qa", V % "aaaa1111"), c("cybersec", S % "aaaa1111")], "AGREE", gates="qa,cybersec")

# --- WHAT IS NOT A VERDICT ---------------------------------------------------------------------
case("prose mentioning a verdict mid-sentence is not a verdict",
     [c("mikrob", "A QA PASS majd jon, addig varunk."), c("qa", V % "bbbb2222")], "AGREE")
case("the Gate-SHA header may come FIRST, the verdict second",
     [c("qa", "Gate-SHA: bbbb2222\nQA PASS"), c("cybersec", S % "bbbb2222")], "AGREE")
case("a REVIEW comment from the author is not a gate verdict",
     [c("backend", "REVIEW: kesz.\nGate-SHA: bbbb2222"), c("qa", V % "bbbb2222")], "AGREE")

# --- THE DEFAULT EXPECTATION (card 2003e04b) ---------------------------------------------------
# Cybered demonstrated the flag's flaw minutes after it landed by forgetting to pass it. So the
# expectation now comes from the card when the caller gives none -- and everything below pins the
# two conditions their plan-grilling attached to that, plus what the board measurement added.

R = "REVIEW: kesz.\nGate-SHA: %s"

case("no --expect: the REVIEW's sha is used, and agreeing with it is AGREE",
     [c("backend", R % "aaaa1111"), c("qa", V % "aaaa1111")], "AGREE")
case("no --expect: gates on a sha the REVIEW does not name, unjudgeable -> NOT agree",
     [c("backend", R % "bbbb2222"), c("qa", V % "aaaa1111")], "UNRESOLVED")
case("the LATEST REVIEW wins, so a delta re-declaration is what gets compared",
     [c("backend", R % "aaaa1111"), c("backend", R % "bbbb2222"), c("qa", V % "bbbb2222")],
     "AGREE")
case("a REVIEW naming SEVERAL commits (rule 4b): a verdict on any of them is judging the delivery",
     [c("backend", "REVIEW: kesz.\nGate-SHA: aaaa1111, bbbb2222"), c("qa", V % "bbbb2222")],
     "AGREE")

# Cybered's condition 1: "no expectation" must never be indistinguishable from "expectation met".
case("no REVIEW at all: still AGREE, but the line SAYS the delivered commit is unchecked",
     [c("qa", V % "aaaa1111"), c("cybersec", S % "aaaa1111")], "AGREE", gates="qa,cybersec")
n += 1
_out = run([c("qa", V % "aaaa1111")], None, None)
_ok = "unchecked" in _out
print("%s %-9s <- %-9s %s" % ("OK  " if _ok else "FAIL", "says-so", "says-so" if _ok else "silent",
                              "...and that sentence is actually in the output"))
if not _ok:
    failures.append(("no-review must say so", "contains 'unchecked'", _out))
case("a REVIEW with no Gate-SHA line is the same case: unchecked, and said out loud",
     [c("backend", "REVIEW: kesz, de nincs sha."), c("qa", V % "aaaa1111")], "AGREE")

# Cybered's condition 2: anchored exactly like the verdict, or a comment QUOTING a review supplies
# the expectation -- the mirror image of gate-dispatch-check's documented false-positive class.
case("a comment that merely QUOTES a REVIEW does not declare the expectation",
     [c("mikrob", "Idezem a reviewt:\nREVIEW: kesz.\nGate-SHA: bbbb2222"), c("qa", V % "aaaa1111")],
     "AGREE")

case("--no-expect restores the pre-2003e04b behaviour exactly",
     [c("backend", R % "bbbb2222"), c("qa", V % "aaaa1111")], "AGREE", extra=("--no-expect",))
case("an explicit --expect still outranks the REVIEW's declaration",
     [c("backend", R % "aaaa1111"), c("qa", V % "aaaa1111")], "STALE", expect_sha="cccc3333")

# --- THE VERDICT WORD MUST END, NOT MERELY HIT A WORD BOUNDARY ---------------------------------
# `\b` matched between the S of PASS and the hyphen, so a BUILDER's "QA PASS-eligible" parsed as
# the QA gate's verdict (measured: card 65e0b0d5, author backend2). Four comments in 20121 carry
# the shape; this is the only one whose direction is a false PASS.
case("a builder's 'QA PASS-eligible' is not a QA verdict",
     [c("backend2", "QA PASS-eligible\nGate-SHA: aaaa1111")], "MISSING")
case("nor is 'CYBERSEC GO-ish'",
     [c("backend", "CYBERSEC GO-ish, de meg nem futott")], "MISSING")
case("and a real verdict is still read when the word simply ends",
     [c("qa", V % "aaaa1111")], "AGREE")

# --- THE CONTENT COMPARISON, AGAINST A REAL GIT REPO -------------------------------------------
# The cases above all use shas that resolve nowhere, which exercises the "cannot judge" branch and
# nothing else. The comparison itself -- the part that decides whether a differing sha is benign --
# needs actual commits, so this builds a throwaway repo shaped like the two things the board really
# does: a work commit, the landing that carried it (same code, bumped version, appended log), and a
# genuinely different commit. Hermetic on purpose: pointing this at the real clones would make the
# selftest's answer depend on which machine and which day it ran.

_TMP = tempfile.mkdtemp(prefix="gate-closure-selftest-")


def _g(*args):
    subprocess.run(("git", "-C", _TMP, "-c", "user.email=s@e.lf", "-c", "user.name=selftest") + args,
                   check=True, capture_output=True, text=True)


def _rev(ref="HEAD"):
    return subprocess.run(("git", "-C", _TMP, "rev-parse", ref),
                          capture_output=True, text=True).stdout.strip()


def _write(rel, text):
    path = os.path.join(_TMP, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    io.open(path, "w", encoding="utf-8").write(text)


try:
    _g("init", "-q", "-b", "main")
    _write("src/thing.ts", "export const A = 1\n")
    _write("package.json", '{"version":"1.0.0"}\n')
    _write("DECISIONS.md", "- first\n")
    _g("add", "-A"); _g("commit", "-qm", "work")
    WORK = _rev()

    # The landing: the SAME delivered code, with the two things every landing moves anyway.
    _write("package.json", '{"version":"1.0.1"}\n')
    _write("DECISIONS.md", "- first\n- someone else's entry\n")
    _g("add", "-A"); _g("commit", "-qm", "land")
    LAND = _rev()

    # A genuinely different deliverable.
    _write("src/thing.ts", "export const A = 2\n")
    _g("add", "-A"); _g("commit", "-qm", "different")
    OTHER = _rev()

    # A MERGE commit, because `git show --name-only` prints nothing for one and the file list then
    # comes back empty -- which read as "no files differ", a vacuous pass on 8 of the 37 real cases.
    _g("checkout", "-q", "-b", "side", WORK)
    _write("src/side.ts", "export const B = 1\n")
    _g("add", "-A"); _g("commit", "-qm", "side work")
    _g("checkout", "-q", "main")
    _g("merge", "-q", "--no-ff", "-m", "merge: side into main", "side")
    MERGE = _rev()

    # Card 74aa46a5: the two shapes whose ENTIRE delivery is a churn file, so subtracting churn
    # leaves nothing to compare. The bump is what marveen-land.sh puts on top of every landing;
    # the docs-only commit is the other, rarer way to get there (28 such shas on the live board).
    _write("package.json", '{"version":"1.0.2"}\n')
    _g("add", "-A"); _g("commit", "-qm", "chore(version): bump to 1.0.2+mikrob.1 (marveen-land, selftest)")
    BUMP = _rev()

    _write("DECISIONS.md", "- first\n- someone else's entry\n- a docs-only card\n")
    _g("add", "-A"); _g("commit", "-qm", "docs(decisions): a docs-only card")
    DOCS = _rev()

    # ...and one commit AFTER the docs-only one that leaves DECISIONS.md alone, so a churn-only
    # delivery whose churn file is genuinely IDENTICAL still has somewhere to land as AGREE.
    _write("src/thing.ts", "export const A = 3\n")
    _g("add", "-A"); _g("commit", "-qm", "later work, DECISIONS.md untouched")
    AFTER_DOCS = _rev()

    ENV = {"MARVEEN_MAIN": _TMP, "CLEANCORE_MAIN": "/nonexistent-cleancore"}

    case("a differing sha whose DELIVERED FILES are identical is AGREE, not a false alarm",
         [c("backend", R % WORK), c("qa", V % LAND)], "AGREE", env=ENV)
    n += 1
    _out = run([c("backend", R % WORK), c("qa", V % LAND)], None, None, (), ENV)
    _ok = "package.json" in _out and "DECISIONS.md" in _out
    print("%s %-9s <- %-9s %s" % ("OK  " if _ok else "FAIL", "names-em", "names-em" if _ok else "silent",
                                  "...and it NAMES what it ignored, so the pass is auditable"))
    if not _ok:
        failures.append(("must name the ignored files", "package.json + DECISIONS.md", _out))

    case("a differing sha whose delivered files REALLY differ is STALE",
         [c("backend", R % WORK), c("qa", V % OTHER)], "STALE", env=ENV)
    case("...and that is the shape --expect was built for, still caught when passed explicitly",
         [c("qa", V % OTHER)], "STALE", expect_sha=WORK, env=ENV)
    case("a MERGE commit's file list is not empty, so a landing-shaped REVIEW is really compared",
         [c("backend", R % MERGE), c("qa", V % OTHER)], "STALE", env=ENV)
    case("an unreachable clone cannot turn a mismatch into a pass",
         [c("backend", R % WORK), c("qa", V % OTHER)], "UNRESOLVED",
         env={"MARVEEN_MAIN": "/nonexistent-marveen", "CLEANCORE_MAIN": "/nonexistent-cleancore"})

    # --- card 74aa46a5: the churn subtraction must not empty the comparison into a pass ---------
    case("a REVIEW naming a VERSION BUMP delivers only package.json, so ignoring churn compares "
         "nothing -- that is unresolved, not agreement",
         [c("backend", R % BUMP), c("qa", V % WORK)], "UNRESOLVED", env=ENV)
    n += 1
    _out = run([c("backend", R % BUMP), c("qa", V % WORK)], None, None, (), ENV)
    _ok = "version bump" in _out and "0711c19b" in _out
    print("%s %-9s <- %-9s %s" % ("OK  " if _ok else "FAIL", "says-why", "says-why" if _ok else "bare",
                                  "...and it names the cause, so the reader knows to re-read the REVIEW"))
    if not _ok:
        failures.append(("must name the version-bump cause", "version bump + 0711c19b", _out))

    case("the same hole through the OTHER door: a docs-only delivery is DECISIONS.md and nothing "
         "else, so ignoring it also compares nothing",
         [c("backend", R % DOCS), c("qa", V % WORK)], "UNRESOLVED", env=ENV)

    # The two controls that keep the tightening from becoming a false alarm generator. Both were
    # measured on the live board before this landed: 14 cards change answer, all of them already
    # closed, and NONE of them is either of these shapes.
    case("CONTROL: a churn-only delivery whose churn file is genuinely IDENTICAL is still AGREE -- "
         "nothing differs anywhere, which is a real answer, not an empty one",
         [c("backend", R % DOCS), c("qa", V % AFTER_DOCS)], "AGREE", env=ENV)
    case("CONTROL: a delivery with REAL files that simply did not differ keeps its pass, even "
         "though the churn files moved",
         [c("backend", R % WORK), c("qa", V % LAND)], "AGREE", env=ENV)
finally:
    shutil.rmtree(_TMP, ignore_errors=True)

# --- MALFORMED INPUT ---------------------------------------------------------------------------
n += 1
p = subprocess.run([sys.executable, CHECK], input="not json at all", capture_output=True, text=True)
ok = p.stdout.strip().startswith("UNREADABLE|")
print("%s %-9s <- %-9s %s" % ("OK  " if ok else "FAIL", "UNREADABLE",
                              p.stdout.strip().split("|")[0], "unparseable body is one answer"))
if not ok:
    failures.append(("unparseable body", "UNREADABLE", p.stdout.strip()))

n += 1
p = subprocess.run([sys.executable, CHECK, "qa,notagate"],
                   input=json.dumps({"comments": []}), capture_output=True, text=True)
ok = p.stdout.strip().startswith("UNREADABLE|")
print("%s %-9s <- %-9s %s" % ("OK  " if ok else "FAIL", "UNREADABLE",
                              p.stdout.strip().split("|")[0], "an unknown gate name is refused, not ignored"))
if not ok:
    failures.append(("unknown gate name", "UNREADABLE", p.stdout.strip()))

n += 1
p = subprocess.run([sys.executable, CHECK, "qa,cybersec", "--expect", "nothex"],
                   input=json.dumps({"comments": []}), capture_output=True, text=True)
ok = p.stdout.strip().startswith("UNREADABLE|")
print("%s %-9s <- %-9s %s" % ("OK  " if ok else "FAIL", "UNREADABLE",
                              p.stdout.strip().split("|")[0], "a non-sha --expect is refused, not ignored"))
if not ok:
    failures.append(("bad --expect", "UNREADABLE", p.stdout.strip()))

n += 1
p = subprocess.run([sys.executable, CHECK, "qa,cybersec", "--expect"],
                   input=json.dumps({"comments": []}), capture_output=True, text=True)
ok = p.stdout.strip().startswith("UNREADABLE|")
print("%s %-9s <- %-9s %s" % ("OK  " if ok else "FAIL", "UNREADABLE",
                              p.stdout.strip().split("|")[0], "--expect with no value is refused"))
if not ok:
    failures.append(("empty --expect", "UNREADABLE", p.stdout.strip()))

# --- SIBLING GATE AGENTS (card 67a5ee01) ------------------------------------------------------
# A gate ROLE may be staffed by more than one agent, and rule 4 requires load-balancing between
# them, so only ONE of a pair reviews a given card. Before this, the verdict regex stopped at
# "QA" and the "2" of "QA2 PASS" did not match -- measured on this board, 601 sibling verdicts
# going back to comment 1952 were invisible, and 42 cards read MISSING for a gate that had in
# fact signed off. Cybersec hit it live on three cards while load-balancing qa2 in.
case("QA2 is the QA role, not a fourth gate -- its verdict satisfies a designated qa",
     [c("qa2", "QA2 PASS\nGate-SHA: bbbb2222"), c("cybersec", S % "bbbb2222")], "AGREE", "qa,cybersec")
case("a sibling verdict still has to agree on the SHA",
     [c("qa2", "QA2 PASS\nGate-SHA: aaaa1111"), c("cybersec", S % "bbbb2222")], "DISAGREE", "qa,cybersec")
# The measured direction of change, and the reason it is safe: on all 9 board cards where this
# flips QA from FAIL to PASS, the sibling PASS comes strictly AFTER the FAIL and the card is
# already `done` -- the sibling was re-reviewing the fix, exactly as one gate re-reviewing itself.
case("a sibling PASS after the other sibling's FAIL is a re-review, and closes",
     [c("qa", "QA FAIL\nGate-SHA: aaaa1111"), c("qa2", "QA2 PASS\nGate-SHA: bbbb2222"),
      c("cybersec", S % "bbbb2222")], "AGREE", "qa,cybersec")
# ...and the fail-closed mirror image, which is what keeps the above from being a loophole.
case("a sibling FAIL after the other sibling's PASS still refuses the closure",
     [c("qa2", "QA2 PASS\nGate-SHA: bbbb2222"), c("qa", "QA FAIL\nGate-SHA: bbbb2222"),
      c("cybersec", S % "bbbb2222")], "FAILED", "qa,cybersec")
# ...and the case NEITHER of the two above covers, which was AGREE until card c52e2823 measured it:
# the sibling PASS comes last on the SAME sha. "Re-review" is what makes the different-sha case safe
# -- there the refusal is about code that is gone. On ONE sha there is nothing to re-review: two gate
# agents simply disagree about the same commit, and rule 4a reads AGREE as "safe to close".
case("a sibling PASS on the SAME sha does not bury the other sibling's FAIL",
     [c("qa", "QA FAIL\nGate-SHA: bbbb2222"), c("qa2", "QA2 PASS\nGate-SHA: bbbb2222"),
      c("cybersec", S % "bbbb2222")], "FAILED", "qa,cybersec")
# A refusal that names no commit cannot be shown to be superseded -- and it cannot be shown to still
# stand either. This answered FAILED until card c52e2823 round 2 (MikroB's ruling 21139, folding in
# card e4b7096e): FAILED asserts that the sibling PASS is a disagreement about this same commit,
# when the other reading -- a re-review of a commit that is gone -- fits the same evidence. With no
# sha on either side the tool has no way to choose, so it names the ambiguity instead of guessing.
case("a refusal with NO Gate-SHA is not superseded by a sibling's PASS, and cannot be judged either",
     [c("qa", "QA FAIL\nthe fixture carries no sha"), c("qa2", "QA2 PASS\nGate-SHA: bbbb2222"),
      c("cybersec", S % "bbbb2222")], "UNSUPERSEDED", "qa,cybersec")
# CONTROL. Measured, so it says what it actually catches rather than what it sounds like: this case
# goes red when standing refusals are keyed by the ROLE instead of by the AUTHOR -- the shape where a
# gate can never clear its own FAIL and every self-correction refuses forever. The OTHER over-block
# ("block every standing refusal, sha be damned") is caught by the different-sha re-review case
# above, not by this one. Two mutations, two different cases; neither covers both.
case("CONTROL: a gate that re-checks ITSELF on the same sha still closes",
     [c("qa", "QA FAIL\nGate-SHA: bbbb2222"), c("qa", "QA PASS\nGate-SHA: bbbb2222"),
      c("cybersec", S % "bbbb2222")], "AGREE", "qa,cybersec")
case("the siblings are ONE gate: qa2 alone does not satisfy a designated cybersec",
     [c("qa2", "QA2 PASS\nGate-SHA: bbbb2222")], "MISSING", "qa,cybersec")
# Future siblings are recognised by shape rather than by an enumerated list, so CYBERSEC2/CYBERED2
# work the day they exist. There are ZERO of them on the board today, so unlike QA2 this half is
# pinned by these cases only -- said plainly rather than implied.
case("a future CYBERSEC2 sibling is recognised as the cybersec role",
     [c("qa", V % "bbbb2222"), c("cybersec2", "CYBERSEC2 GO\nGate-SHA: bbbb2222")], "AGREE", "qa,cybersec")
# The guard that stops the digits from swallowing prose: a number must attach to the gate word.
case("'QA 2 PASS' with a detached number is not a verdict",
     [c("qa", "QA 2 PASS\nGate-SHA: bbbb2222"), c("cybersec", S % "bbbb2222")], "MISSING", "qa,cybersec")

case("a DESIGNATION naming the sibling ('qa2,cybersec') is a valid gate set, not UNREADABLE",
     [c("qa2", "QA2 PASS\nGate-SHA: bbbb2222"), c("cybersec", S % "bbbb2222")], "AGREE", "qa2,cybersec")
case("...and a genuinely unknown name is still refused, so the normalisation did not open the door",
     [c("qa", V % "bbbb2222")], "UNREADABLE", "bogus,qa")

# --- EXIT CODE --------------------------------------------------------------------------------
# A readout, never a gate on the gate: it must not be able to stop a closure by crashing.
n += 1
ok = p.returncode == 0
print("%s %-9s <- %-9s %s" % ("OK  " if ok else "FAIL", "exit 0", "exit %d" % p.returncode,
                              "always exits 0 -- the caller decides"))
if not ok:
    failures.append(("exit code", "0", str(p.returncode)))

# --- AUTHOR ATTRIBUTION (card 44849954, Cybered's finding) -------------------------------------
# The tool authenticated a verdict by its TEXT and never by its AUTHOR. Comment authorship on the
# kanban API comes from the request body under one shared token, so the shape check was the only
# thing between a maker and their own sign-off.
SHA_A = "a" * 40
SHA_B = "b" * 40

case("THE DEFECT: a maker's own 'QA PASS' with no verdict from QA is not a sign-off",
     [c("backend2", "REVIEW: kesz\nGate-SHA: " + SHA_A),
      c("backend2", V % SHA_A),
      c("cybersec", S % SHA_A)],
     "UNVERIFIED-AUTHOR", gates="qa,cybersec")

case("FALLBACK: a relayed PASS defers to the gate's OWN earlier verdict, and recovers its sha",
     [c("qa", V % SHA_A),
      c("cybersec", S % SHA_A),
      c("mikrob", "QA PASS -- osszefoglalo, a gate mar zoldre tette")],   # no Gate-SHA of its own
     "AGREE", gates="qa,cybersec", expect_sha=SHA_A)

# THE ASYMMETRY, and the reason this is not a plain "prefer the gate's own comment". Without it,
# preferring QA's older PASS would close a card over a stated refusal -- worse than the bug fixed.
# The asymmetry SURVIVES card c52e2823 round 2 unchanged in its own direction: the answer is still
# not AGREE and the card still does not close. What changed is the word. A relay carrying no sha is
# read as unjudgeable rather than as a refusal, because on this board the same shape is far more
# often an acknowledgement of a refusal the gate has already answered (Cybersec's live count, 21176:
# 18 non-role verdict-shaped comments, 11 of them refusals, on 9 cards).
case("ASYMMETRY: a relayed FAIL is still not overridden by the gate's own earlier PASS",
     [c("qa", V % SHA_A),
      c("cybersec", S % SHA_A),
      c("mikrob", "QA FAIL -- ujranyitva, a gate visszadobta")],
     "UNSUPERSEDED", gates="qa,cybersec")

case("an unattributed FAIL still reads as FAILED, not UNVERIFIED-AUTHOR",
     [c("backend2", "QA FAIL\nGate-SHA: " + SHA_A), c("cybersec", S % SHA_A)],
     "FAILED", gates="qa,cybersec")

# The author fold MIRRORS the verdict-word fold (the note on GATES). Applying it to one side only
# is its own bug: measured, an unfolded author check calls 245 legitimate QA2 verdicts foreign.
case("SIBLING: qa2 speaks for the QA gate, exactly as the verdict word QA2 does",
     [c("qa2", V % SHA_A), c("cybersec", S % SHA_A)],
     "AGREE", gates="qa,cybersec", expect_sha=SHA_A)

case("FUTURE SIBLING: cybersec2 needs no edit here -- trailing digits are stripped by rule",
     [c("qa", V % SHA_A), c("cybersec2", S % SHA_A)],
     "AGREE", gates="qa,cybersec", expect_sha=SHA_A)

case("ALIAS: the subagent_type name qa-engineer is the same actor as qa",
     [c("qa-engineer", V % SHA_A), c("cybersec", S % SHA_A)],
     "AGREE", gates="qa,cybersec", expect_sha=SHA_A)

case("CONTROL: an ordinary pair of gate-authored verdicts is untouched",
     [c("qa", V % SHA_A), c("cybersec", S % SHA_A)],
     "AGREE", gates="qa,cybersec", expect_sha=SHA_A)

case("CONTROL: attribution does not mask a real sha DISAGREEMENT between two gates",
     [c("qa", V % SHA_A), c("cybersec", S % SHA_B)],
     "DISAGREE", gates="qa,cybersec")

case("CONTROL: a gate that never posted at all is MISSING, not UNVERIFIED-AUTHOR",
     [c("qa", V % SHA_A)],
     "MISSING", gates="qa,cybersec")

# --- WHO MAY BLOCK, AND WHEN IT CANNOT BE JUDGED (card c52e2823, round 2) ----------------------
# QA measured the regression the first round shipped (21135) and Cybersec reproduced it independently
# and wider (21176): the standing-refusal rule read EVERY author, so any sentence of verdict shape
# from anyone stood in permanently for a refusal. Two failure directions have to be pinned here, and
# a suite that pins only one is green while the check is absent -- so every author class below gets
# BOTH: a real refusal that must block, and a relay/quote that must not.
#
# The three author classes exist because the population differs, not for symmetry: the coordinator's
# "<GATE> <VERDICT> ELFOGADVA" is the routine fleet shape, and Cybersec measured a BUILDER's quote
# ("QA FAIL elfogadva, javitottam") doing the same thing on the same run.
RELAY = "CYBERED NO-GO ELFOGADVA (21038), vissza in_progress-be."
QUOTE = "QA FAIL elfogadva, javitottam."

# THE MEASURED DEFECT (QA 21135, Cybersec case A). The gate itself refused, was answered, and passed
# on the delivered sha. Only the coordinator's acknowledgement in between made this FAILED.
case("a coordinator's acknowledgement BEFORE the gate's own later GO does not block",
     [c("cybered", "CYBERED NO-GO\nGate-SHA: " + SHA_A), c("mikrob", RELAY),
      c("cybered", "CYBERED GO\nGate-SHA: " + SHA_B), c("qa", V % SHA_B)],
     "AGREE", gates="qa,cybered", expect_sha=SHA_B)
# CONTROL for it: the same history with the acknowledgement removed. Without this, the case above
# passing would not tell us the acknowledgement was the cause.
case("CONTROL: the same history without the acknowledgement -- the relay was the only difference",
     [c("cybered", "CYBERED NO-GO\nGate-SHA: " + SHA_A),
      c("cybered", "CYBERED GO\nGate-SHA: " + SHA_B), c("qa", V % SHA_B)],
     "AGREE", gates="qa,cybered", expect_sha=SHA_B)
# THE OTHER DIRECTION, and the reason the fix is not simply "ignore non-gate authors": if the relay
# is the LAST word on that gate, the gate never answered it, and dropping it would close the card
# over a possibly-open refusal. Cybersec's case C, which also shows why time order is load-bearing:
# the two cases above and below differ ONLY in where the same line sits.
case("...but the SAME acknowledgement AFTER the gate's GO cannot be judged, and does not close",
     [c("cybered", "CYBERED NO-GO\nGate-SHA: " + SHA_A),
      c("cybered", "CYBERED GO\nGate-SHA: " + SHA_B), c("qa", V % SHA_B), c("mikrob", RELAY)],
     "UNSUPERSEDED", gates="qa,cybered", expect_sha=SHA_B)

# THE BUILDER CLASS, measured by Cybersec in the same run (case G) and NOT covered by the
# coordinator cases: the fix filters by ROLE, not by name, so a maker's quote behaves identically.
case("a builder's quote of an old FAIL before the gate's PASS does not block",
     [c("backend", QUOTE), c("qa", V % SHA_A), c("cybersec", S % SHA_A)],
     "AGREE", gates="qa,cybersec", expect_sha=SHA_A)
case("...and after the gate's PASS it is unjudgeable, exactly as the coordinator's is",
     [c("qa", V % SHA_A), c("backend", QUOTE), c("cybersec", S % SHA_A)],
     "UNSUPERSEDED", gates="qa,cybersec", expect_sha=SHA_A)

# FAIL-CLOSED PRECONDITIONS. These two are what stop the new word from becoming a way through, and
# each removes a different half of the reasoning:
#   - nothing attributable to weigh the relay against -> it keeps blocking, unchanged;
#   - the refusal names a commit -> it is judgeable, so it is judged, unchanged.
case("FAIL-CLOSED: a relayed refusal with no verdict from that gate at all still blocks",
     [c("mikrob", "QA FAIL -- a gate visszadobta"), c("cybersec", S % SHA_A)],
     "FAILED", gates="qa,cybersec")
case("FAIL-CLOSED: a non-gate refusal that NAMES a sha is judgeable, and still blocks",
     [c("backend2", "QA FAIL\nGate-SHA: " + SHA_A), c("cybersec", S % SHA_A)],
     "FAILED", gates="qa,cybersec")
# ...and the same WITH the gate's own PASS present, which is what actually exercises the sha guard.
# Measured: without this case, dropping `v[2] is not None` from the relay rule leaves the suite
# green -- the case above cannot catch it, because there the rule is already stopped one step
# earlier by having no gate verdict to fall back to. Two guards, two cases; neither covers both.
case("FAIL-CLOSED: a non-gate refusal naming the PASSED sha blocks even with the gate's PASS present",
     [c("qa", V % SHA_A), c("cybersec", S % SHA_A),
      c("backend2", "QA FAIL\nGate-SHA: " + SHA_A)],
     "FAILED", gates="qa,cybersec")
# THE GATE'S OWN REFUSAL IS NEVER UNJUDGEABLE, whatever it omits. A sha makes a refusal checkable by
# a stranger; the gate's own name makes it checkable by asking the gate. Only the second is missing
# in the relay case, so the new word must not reach here. This case is deliberately kept even though
# the code carries no line dedicated to it: the property is delivered by the fallback precondition
# (a gate's own last refusal IS its role's last verdict, so there is no passing verdict to fall back
# to), and a behaviour that holds only as a side effect is exactly the kind that a later, innocent
# refactor drops.
case("a gate's OWN later refusal blocks even with no Gate-SHA on it",
     [c("qa", V % SHA_A), c("cybersec", S % SHA_A), c("qa", "QA FAIL\nujranyitva, nincs sha")],
     "FAILED", gates="qa,cybersec")
# PRECEDENCE. A readable refusal outranks an unreadable one: a card carrying both is bounced on the
# one a human can act on, not parked.
case("a real refusal on one gate outranks an unjudgeable one on another",
     [c("qa", V % SHA_A), c("mikrob", "QA FAIL -- relay, no sha"),
      c("cybersec", "CYBERSEC NO-GO\nGate-SHA: " + SHA_A)],
     "FAILED", gates="qa,cybersec")

# BYTE-FOR-BYTE REGRESSION CONTROLS (MikroB's acceptance condition, 21177). Not "still FAILED" and
# "still AGREE" -- the whole line, because a new branch that reworded an existing answer would pass
# a kind-only assertion while breaking every reader of the output.
for label, comments, gates_, expect_, want in [
    ("a lone real QA FAIL", [c("qa", "QA FAIL\nGate-SHA: " + SHA_A), c("cybersec", S % SHA_A)],
     "qa,cybersec", None, "FAILED|QA=FAIL"),
    ("a clean pass", [c("qa", V % SHA_A), c("cybersec", S % SHA_A)], "qa,cybersec", SHA_A,
     "AGREE|%s|QA=%s; CYBERSEC=%s" % (SHA_A, SHA_A, SHA_A)),
]:
    n += 1
    got = run(comments, gates_, expect_)
    ok = got == want
    print("%s %-9s <- %-9s %s" % ("OK  " if ok else "FAIL", "verbatim", "verbatim" if ok else "differs",
                                  "UNCHANGED, byte for byte: " + label))
    if not ok:
        failures.append((label, want, got))

print()
print("selftest: %d case(s), %s" % (n, "PASS" if not failures else "FAIL"))
for f in failures:
    print("  - %s: expected %s, got %s" % f)
sys.exit(1 if failures else 0)
