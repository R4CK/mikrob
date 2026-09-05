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
# UPDATED BY CARD 82fa48b0. This fixture is 67a5ee01's real mid-sentence prose, and it used to be
# read as a designation naming nobody -- the PROSE finding. Anchoring GATE_DECL_RX to a sentence or
# clause start means the parser no longer sees it at all, so the card falls through and surfaces to
# EVERY gate, which is the correct outcome for text that designates nothing. The case is kept
# (rather than deleted) precisely because it is the founding text: it now pins the FIX.
case("founding prose: mid-sentence Gate: talk is no longer read as a designation",
     "MEGOLDAS: (b) MikroB mostantol a Gate: sort description-be irja PUT-tal, nem csak kommentbe.",
     [], "NONE", 0)
case("...and a real designation is no longer shadowed by prose that follows it",
     'Gate: QA + Cybersec\nA "Gate: sort description-be irja" reszrol meg beszelunk.', [], "OK", 0)

# PROSE is still REACHABLE, just narrower: a `Gate:` that DOES start a sentence and still names no
# role. Without this the code path would be dead and nobody would notice.
case("PROSE survives the anchoring: a line-start Gate: naming no role still excludes everyone",
     "Gate: majd eldontjuk kesobb", [], "PROSE", 1)

# The convention-drift report the anchoring makes necessary (card 82fa48b0 DoD). These are the real
# board shapes the anchored regex drops: they are genuine designations, so the tool must SAY so
# rather than let them read as "no designation at all".
case("MID-SENTENCE: a real designation after a closing paren is reported, not silently dropped",
     "... a felbontas szerint; (5) gate: QA + Cybersec szerinti ellenorzes.", [], "MID-SENTENCE", 1)
case("MID-SENTENCE: a real designation after a hyphen is reported",
     "Trust-boundary/access -> 3-gate: QA + Cybersec + Cybered.", [], "MID-SENTENCE", 1)
# Verbatim from c52e2823, one of the four the anchoring drops. Note WHY the old rule read it as a
# designation at all: the role name it picks up ("QA2") appears LATER in the same sentence, not
# before the colon -- so this is prose describing what the QA gate should check, which the old rule
# scored as a gate tier. Dropping it is arguably a fix rather than a loss; it is reported either way.
case("MID-SENTENCE: the real c52e2823 shape is reported, not silently dropped",
     "o a sajat hibaja, o ismeri a kontextust. QA gate: a javitas + mindket eszkoz tesztje "
     "(pozitiv: QA2 PASS/FAIL felismerve).", [], "MID-SENTENCE", 1)
case("CONTROL: mid-sentence prose naming NO role is NOT a MID-SENTENCE finding",
     "MikroB mostantol a Gate: sort description-be irja.", [], "NONE", 0)
case("CONTROL: a properly anchored designation is OK, never MID-SENTENCE",
     "... a felbontas szerint. Gate: QA + Cybersec", [], "OK", 0)
# CONTROL: a real designation that merely CONTAINS extra words is still a designation.
case("CONTROL: a designation with a parenthetical is still a designation",
     "Gate: QA + Cybersec (tartalom-ellenorzes, trust-boundary erintve)", [], "OK", 0)

print()
print("selftest: %d case(s), %s" % (n, "PASS" if not failures else "FAIL"))
for f in failures:
    print("  - %s: expected %s, got %s" % f)
sys.exit(1 if failures else 0)
