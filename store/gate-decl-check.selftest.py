#!/usr/bin/env python3
"""Selftest for gate-decl-check.py (card 67a5ee01).

A guard that has never been run against the case that created it is not evidence, so the founding
shapes are pinned here, and this file is auto-discovered by store-selftests-all-run.test.ts.
"""
import json
import os
import subprocess
import sys

CHECK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gate-decl-check.py")
failures = []
n = 0


def run(description, comments):
    p = subprocess.run([sys.executable, CHECK],
                       input=json.dumps({"description": description, "comments": comments}),
                       capture_output=True, text=True)
    return p.stdout.strip().split("|", 1)[0], p.returncode


def c(author, content):
    return {"author": author, "content": content}


def case(label, description, comments, expect_code, expect_exit):
    global n
    n += 1
    code, rc = run(description, comments)
    ok = code == expect_code and rc == expect_exit
    print("%s %-13s <- %-13s exit %d  %s"
          % ("OK  " if ok else "FAIL", expect_code, code, rc, label))
    if not ok:
        failures.append((label, "%s/exit %d" % (expect_code, expect_exit), "%s/exit %d" % (code, rc)))


print("gate-decl-check selftest")

# --- THE FOUNDING CASE -------------------------------------------------------------------------
# 110 cards on this board designate their gates in a MikroB comment only. No scanner reads
# comments, so the designation does not exist for the code that acts on it.
case("designated only in a MikroB comment", "no gate line here",
     [c("mikrob", "Gate: QA + Cybersec")], "COMMENT-ONLY", 1)

# --- THE DANGEROUS DIRECTION -------------------------------------------------------------------
# 23 measured cards. A gate the description omits is told the card is not its own, and skips it.
case("description NARROWER than the latest comment -- the named gate will skip",
     "Gate: QA", [c("mikrob", "Gate: QA + Cybered")], "NARROWER", 1)

# --- THE COSTLY BUT SAFE DIRECTION -------------------------------------------------------------
# 28 measured cards. Reported separately because the failure directions are not symmetric.
case("description WIDER than the latest comment -- one wasted read, nothing missed",
     "Gate: QA + Cybersec", [c("mikrob", "Gate: QA")], "WIDER", 1)

# --- THE HEALTHY SHAPES ------------------------------------------------------------------------
case("description declares and nothing contradicts it", "Gate: QA + Cybersec", [], "OK", 0)
case("description and comment agree", "Gate: QA + Cybersec",
     [c("mikrob", "Gate: QA + Cybersec")], "OK", 0)
case("no designation anywhere is not a finding here",
     "just a normal description", [c("backend2", "REVIEW: kesz")], "NONE", 0)

# --- SIBLING NUMBERING -------------------------------------------------------------------------
# Comparing without normalising reported 2 board cards as disagreeing when the only difference was
# "QA" against "QA + QA2" -- the same role, staffed by its second agent (rule 4 load-balancing).
case("QA2 in the comment is the QA role, not a second gate", "Gate: QA",
     [c("mikrob", "Gate: QA2 + Cybersec")], "NARROWER", 1)  # cybersec is the real difference
case("QA vs QA2 alone is NOT a disagreement", "Gate: QA",
     [c("mikrob", "Gate: QA2")], "OK", 0)
case("...and the same normalisation on the description side", "Gate: QA2 + Cybersec",
     [c("mikrob", "Gate: QA + Cybersec")], "OK", 0)

# --- ONLY MIKROB DESIGNATES --------------------------------------------------------------------
# The card names this reverse risk explicitly: a builder's own "Gate: QA" line is a suggestion, and
# treating it as authority is how a corrected tier gets pinned back to a wrong value.
case("a BUILDER's Gate: line is not a designation and cannot narrow anything",
     "Gate: QA + Cybersec", [c("backend2", "Gate: QA")], "OK", 0)
case("...nor can it stand in for a missing designation",
     "no gate line", [c("backend2", "Gate: QA")], "NONE", 0)

# --- LAST MENTION WINS -------------------------------------------------------------------------
# Matching declared_gate_excludes_me(): scope widens mid-thread when a chained finding pulls
# another gate in, and the newest statement is the current one.
case("the LATEST MikroB designation wins over an earlier one", "Gate: QA + Cybered",
     [c("mikrob", "Gate: QA"), c("mikrob", "Gate: QA + Cybered")], "OK", 0)

# --- A `Gate:` LINE THAT NAMES NO ROLE ---------------------------------------------------------
# Found by running this tool against the real board rather than fixtures: card 67a5ee01's OWN
# description discusses gate designations in prose, GATE_DECL_RX searches instead of anchoring, and
# declared_gate_excludes_me() therefore answers True for qa, cybersec AND cybered -- the card is
# invisible to every scanner. 24 cards board-wide carry the shape.
# Verbatim shape of 67a5ee01's LAST `Gate:` match, which is the one declared_gate_excludes_me()
# uses. Note the first fixture I wrote for this was WRONG in an instructive way: prose reading
# 'a "Gate: QA + X" designacio' does name a role, so it is not this class at all.
case("a Gate: line that names no role at all is not OK, it excludes everyone",
     "MEGOLDAS: (b) MikroB mostantol a Gate: sort description-be irja PUT-tal, nem csak kommentbe.",
     [], "PROSE", 1)
case("...and prose does not become a designation just because a real one follows elsewhere",
     'Gate: QA + Cybersec\nA "Gate: sort description-be irja" reszrol meg beszelunk.', [], "PROSE", 1)
# CONTROL: a real designation that merely CONTAINS extra words is still a designation.
case("CONTROL: a designation with a parenthetical is still a designation",
     "Gate: QA + Cybersec (tartalom-ellenorzes, trust-boundary erintve)", [], "OK", 0)

print()
print("selftest: %d case(s), %s" % (n, "PASS" if not failures else "FAIL"))
for f in failures:
    print("  - %s: expected %s, got %s" % f)
sys.exit(1 if failures else 0)
