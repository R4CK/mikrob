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

# --- EXIT CODE --------------------------------------------------------------------------------
# A readout, never a gate on the gate: it must not be able to stop a closure by crashing.
n += 1
ok = p.returncode == 0
print("%s %-9s <- %-9s %s" % ("OK  " if ok else "FAIL", "exit 0", "exit %d" % p.returncode,
                              "always exits 0 -- the caller decides"))
if not ok:
    failures.append(("exit code", "0", str(p.returncode)))

print()
print("selftest: %d case(s), %s" % (n, "PASS" if not failures else "FAIL"))
for f in failures:
    print("  - %s: expected %s, got %s" % f)
sys.exit(1 if failures else 0)
