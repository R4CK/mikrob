#!/usr/bin/env python3
"""Selftest for scripts/name-pattern-tool.py (card 98dbbcc9).

Runs the tool as a SUBPROCESS over its real stdin/stdout protocol rather than importing it,
because the contract the dashboard depends on is the process contract (exit 0 + a JSON verdict),
not the function signatures.

The ACCEPT half is drawn from what a Hungarian operator would actually type -- accented names,
apostrophes, parentheses, an optional-suffix regex -- not only from the threat model. A guard
whose cases all come from the attack side blocks its own users; that lesson cost this fleet a
wedged agent once already.
"""
import json
import os
import subprocess
import sys

TOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "name-pattern-tool.py")

fails = 0


def run(req, timeout=15):
    p = subprocess.run(
        [sys.executable, TOOL],
        input=json.dumps(req), capture_output=True, text=True, timeout=timeout,
    )
    if p.returncode != 0:
        return {"ok": False, "error": f"<tool exited {p.returncode}>", "_rc": p.returncode}
    try:
        return json.loads(p.stdout)
    except Exception:
        return {"ok": False, "error": f"<unparseable stdout: {p.stdout[:80]!r}>"}


def t(name, got, want):
    global fails
    if got != want:
        fails += 1
        print(f"FAIL {name}\n  got : {got!r}\n  want: {want!r}")
    else:
        print(f"ok   {name}")


def accepts(name, req, expect_pattern=None):
    r = run(req)
    if not r.get("ok"):
        t(name, f"REJECTED: {r.get('error')}", "accepted")
        return
    if expect_pattern is not None:
        t(name, r.get("pattern"), expect_pattern)
    else:
        t(name, True, True)


def rejects(name, req):
    r = run(req)
    t(name, bool(r.get("ok")), False)


# --- ACCEPT: the shapes a real operator types -------------------------------------------
accepts("literal: plain name", {"op": "prepare", "patterns": [], "value": "Kovacs", "mode": "literal"}, "Kovacs")
accepts("literal: accented name survives unescaped-letter rules",
        {"op": "prepare", "patterns": [], "value": "Nagyné Kovács", "mode": "literal"})
accepts("literal: apostrophe + parens are escaped, not rejected",
        {"op": "prepare", "patterns": [], "value": "O'Brien (Jr.)", "mode": "literal"})
accepts("literal: a metachar-only value is legal once escaped",
        {"op": "prepare", "patterns": [], "value": "(", "mode": "literal"})
accepts("regex: optional Hungarian suffix",
        {"op": "prepare", "patterns": [], "value": "Kovács(né)?", "mode": "regex"}, "Kovács(né)?")
accepts("regex: python-only construct is NOT falsely rejected",
        {"op": "prepare", "patterns": [], "value": "(?P<n>Kovacs)", "mode": "regex"})
accepts("regex: python-only inline comment is NOT falsely rejected",
        {"op": "prepare", "patterns": [], "value": "(?#c)Kovacs", "mode": "regex"})
accepts("adding onto an existing list", {"op": "prepare", "patterns": ["Elso", "Masodik"], "value": "Harmadik", "mode": "literal"}, "Harmadik")
accepts("validate: an existing healthy list", {"op": "validate", "patterns": ["Kovacs", "Nagy(né)?"]})
accepts("validate: the deliberate empty list", {"op": "validate", "patterns": []})

# --- REJECT: the cases that would take the gate down ------------------------------------
rejects("the crash case: unterminated subpattern",
        {"op": "prepare", "patterns": [], "value": "unclosed(", "mode": "regex"})
rejects("node-accepts-python-crashes: (?<n>x)",
        {"op": "prepare", "patterns": [], "value": "(?<n>x)", "mode": "regex"})
rejects("node-accepts-python-crashes: \\p{L}",
        {"op": "prepare", "patterns": [], "value": "\\p{L}", "mode": "regex"})
rejects("catastrophic backtracking is refused, not merely slow",
        {"op": "prepare", "patterns": [], "value": "(a+)+$", "mode": "regex"})
rejects("empty value", {"op": "prepare", "patterns": [], "value": "   ", "mode": "regex"})
rejects("duplicate", {"op": "prepare", "patterns": ["Kovacs"], "value": "Kovacs", "mode": "regex"})
rejects("unknown mode", {"op": "prepare", "patterns": [], "value": "x", "mode": "wildcard"})
rejects("unknown op", {"op": "destroy", "patterns": []})
rejects("over-long pattern", {"op": "prepare", "patterns": [], "value": "a" * 201, "mode": "regex"})
rejects("too many patterns", {"op": "prepare", "patterns": ["p%d" % i for i in range(200)], "value": "one-more", "mode": "literal"})
rejects("patterns is not a list", {"op": "validate", "patterns": "nope"})
rejects("a poisoned EXISTING list is caught by validate",
        {"op": "validate", "patterns": ["fine", "unclosed("]})

# --- the property that matters most: an accepted result actually loads in the hook -------
r = run({"op": "prepare", "patterns": ["Kovács(né)?"], "value": "O'Brien (Jr.)", "mode": "literal"})
if r.get("ok"):
    joined = "|".join(["Kovács(né)?", r["pattern"]])
    probe = subprocess.run(
        [sys.executable, "-c", "import re,sys; re.compile(sys.stdin.read()); print('LOADS')"],
        input=joined, capture_output=True, text=True,
    )
    t("an accepted pattern still compiles JOINED, the way the hook compiles it",
      probe.stdout.strip(), "LOADS")
else:
    t("an accepted pattern still compiles JOINED", f"prepare rejected: {r.get('error')}", "accepted")

print()
print(f"{'FAILED' if fails else 'PASSED'} -- {fails} failure(s)")
sys.exit(1 if fails else 0)
