"""Which gates a card DESIGNATES -- one table, shared by every tool that asks (card acc197c8,
follow-up to 5bc10089).

Split out of `gate-dispatch-check.sh`, which had the only copy of this logic (GATE_LABELS/
GATE_LINE inference, embedded in a `python3 -c` block used only to decide whether to SKIP a passive
gate nudge). MikroB's decision on card acc197c8 (msg 4374, point 1): the same inference must also
run inside `mopsion-land.sh`'s push gate, so a landing can tell whether the card's OWN required-gate
set changed between the start of the landing and the moment it pushes -- and the logic must not be
copied, because a copy drifts (see `gate_author_role.py`'s header for the same argument, made once
already on this board).

TWO SOURCES, in priority order (unchanged from the original):
  1. GATE_LABELS -- the card's own kanban labels (@qa/@qa2/@cybersec/@cybered). Durable, because it
     takes a deliberate act by MikroB to attach one. Authoritative when present.
  2. GATE_LINE -- the card's free-text "Gate: ..." line, when no labels exist yet. Weaker (prose,
     easy to under-specify), used as a fallback until labels are the norm.
Neither present -> None (no exclusion / no designation known).
"""
import re

GATE_AGENTS = ("qa", "qa2", "cybersec", "cybered")


def widen_qa(names):
    """QA and QA2 are capacity twins (CLAUDE.md's own words), not independent roles -- naming one
    designates both."""
    return names | {"qa", "qa2"} if ("qa" in names or "qa2" in names) else names


def designated_from_labels(csv):
    names = {n.strip().lstrip("@").lower() for n in csv.split(",") if n.strip()}
    names = {n for n in names if n in GATE_AGENTS}
    return widen_qa(names) if names else None


def designated_from_gate_line(text):
    # DESIGNATION vs EXPLANATION (card 55af560d): a name-scan over the WHOLE line reads the
    # explanatory parenthetical too, so a card that EXCLUDES a gate by NAMING it in its own
    # exclusion reasoning -- "QA + Cybersec (... trust boundary, ezert Cybersec, nem Cybered)." --
    # would otherwise read as designating the excluded gate too, because its name appears in the
    # text. The fix scans only the OWN designation clause of the gate line, not the whole line.
    #
    # TWO STEPS, AND THE ORDER MATTERS (card aa837c5b): 1. REMOVE parenthesised parts (innermost-
    # first until the text stops changing, so nesting cannot leave a stray fragment behind) rather
    # than truncating at the first "(" -- truncating threw away every name after it, misreading
    # "Gate: QA (functional...), Cybersec (...)" as QA-only. 2. THEN cut at sentence-ending
    # punctuation, for the trailing-sentence exclusion shape ("QA + Cybered (...). Cybersec
    # kimarad: ...").
    for _ in range(8):
        stripped = re.sub(r"\([^()]*\)", "", text)
        if stripped == text:
            break
        text = stripped
    clause_end = re.search(r"[.!?]", text)
    clause = text[: clause_end.start()] if clause_end else text
    low = clause.lower()
    names = set()
    if re.search(r"\bqa2\b", low):
        names.add("qa2")
    if re.search(r"\bqa\b", low):
        names.add("qa")
    # WHITEHAT/REDHAT (card cf0a8c0b): display-name aliases for the same cybersec/cybered roles --
    # a "Gate: QA + WhiteHat" line must designate the cybersec gate exactly like "... + Cybersec".
    if re.search(r"\bcybersec\b", low) or re.search(r"\bwhitehat\b", low):
        names.add("cybersec")
    if re.search(r"\bcybered\b", low) or re.search(r"\bredhat\b", low):
        names.add("cybered")
    return widen_qa(names) if names else None


def designated_gates(gate_labels, gate_line):
    """The card's current designated-gate set, or None if neither source says anything."""
    return designated_from_labels(gate_labels or "") or designated_from_gate_line(gate_line or "")


if __name__ == "__main__":
    import os
    import sys

    labels = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("GATE_LABELS", "")
    line = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("GATE_LINE", "")
    designated = designated_gates(labels, line)
    print(",".join(sorted(designated)) if designated else "")
