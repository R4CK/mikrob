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
import json
import os
import subprocess
import sys

CHECK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gate-closure-check.py")

failures = []
n = 0


def run(comments, gates=None, expect=None):
    args = [sys.executable, CHECK] + ([gates] if gates else []) \
        + (["--expect", expect] if expect else [])
    p = subprocess.run(args, input=json.dumps({"comments": comments}),
                       capture_output=True, text=True)
    return p.stdout.strip()


def c(author, content):
    return {"author": author, "content": content}


def case(label, comments, expect_kind, gates=None, expect_sha=None):
    global n
    n += 1
    got = run(comments, gates, expect_sha)
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
