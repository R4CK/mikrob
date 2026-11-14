#!/usr/bin/env python3
"""Guard: gate-closure-check.py must import the verdict-token list, never redefine it (card
ec34c025, Kesz-ha bullet 2: "a test fails if a second copy of the token list appears in the
repo").

Cases 1-4 (unchanged, kept per Cybersec NO-GO 31111's fix direction "keep the 4 existing cases"):
narrow, name-anchored checks that gate-closure-check.py specifically has no inline `_VERDICT =
re.compile(...)` / `PASSING = {...}` and imports both from gate_verdict_tokens.

Cases 5-7 (new, replacing the single-file scope): a SHAPE-based `store/` ratchet (NOT repo-wide --
see LOW-2 below and the scope paragraph further down). Cybersec NO-GO 31111 on this guard's first
version: it only matched the two EXACT spellings in ONE file, so a differently-named/differently-
spelled copy (`_VERDICT_LOCAL`, `PASSING = set([...])`, an annotated rebinding, or a brand new
file) stayed green. Verified failing: re-adding the exact spellings turned 2/4 red; the four other
mutants (rename, set(), annotated rebind, new file) left the ORIGINAL guard fully green.

Case 8 (new, closes Cybersec GO 31290's MEDIUM-1): cases 1-2 above only match the exact spellings
`PASSING = {`/`(` and `_VERDICT = re.compile`, so a rebind via any OTHER constructor --
`PASSING = set(("PASS","GO"))`, `PASSING = PASSING | {"OK"}`, `PASSING = tuple([...])`,
`PASSING = frozenset(set(PASSING) | {"OK"})` -- stayed green in gate-closure-check.py itself (the
cases 5-7 shape-scan does not look inside that file beyond "does it have the shape at all", and a
rebind of an imported name to the SAME value has no gate-name/outcome-word literal of its own to
catch; `VERDICT_RE = re.compile(...)` stayed red because its own case 1 regex-detector matched
`= re.compile` directly, the gap was only `PASSING`'s own cases). Case 8 is AST-based, not
spelling: it parses gate-closure-check.py and fails on ANY top-level `Assign`/`AnnAssign`/
`AugAssign` whose target is `PASSING`, `VERDICT_RE` or `_VERDICT`, regardless of the right-hand
side's constructor -- the import line itself is a different AST node (`ImportFrom`) and does not
trip it.

The "shape" this matches is the NO-GO's own wording: an OUTCOME word (PASS/FAIL/GO/NO-GO)
together with a GATE name (QA/CYBERSEC/WHITEHAT/CYBERED/REDHAT) inside one regex pattern string
or one named literal (set/frozenset/list/tuple), comments stripped, word-bounded so "FAILSAFE" or
a sentence mentioning "QA" and "GO" six lines apart does not count. A bare list of gate names
alone (no outcome word) does NOT count -- that is a designation/role list (store/gate_author_role.py's
GATE_ROLES), a different, legitimate, unrelated concept this guard must not flag.

The ratchet (cases 5-7) is a `store/` ratchet, NOT repo-wide (Cybersec GO 31290's LOW-2): scoped
to store/*.py and store/*.sh (flat, not recursive -- matches where gate-closure-check.py and
every known copy sit) plus the one TS file the original REVIEW named
(src/web/kanban-gate-completeness-guard.ts). NOT scanned, and a copy there would stay green: the
rest of src/*.ts, scripts/, any store/<subdir>/, a file whose name contains "selftest", a
lowercase-named literal (e.g. a local `passing = {...}` inside a function), lowercase token
spellings, and a bash `case "$1" in PASS|GO)` list. This is disclosed here and in DECISIONS.md --
report it to Peti/MikroB as "store/ ratchet", never "repo-wide". A full recursive scan of src/ is
explicitly NOT attempted here: several other .ts files mention a gate name and an outcome word
(kanban-verdicts.ts, message-router.ts, ...) and triaging each as duplicate-vs-unrelated is its
own investigation, out of scope for this card.

ALLOWLIST was measured by RUNNING this shape-detector against the whole scoped tree, not by
trusting the original REVIEW/NO-GO's own list -- that list named 6 legacy files; the measured
set has 9 (it also found store/cybered-gate-scan.py, store/gate_scan_lib.py, and
store/unlanded-branch-sweep.sh, none of which were named). Mutation-verified (see bottom): a file
entering the scanned set with the shape, or gate-closure-check.py regaining it, turns case 5 red;
removing a file's shape (true migration, F5/F7/F8) without shrinking ALLOWLIST turns case 6 red,
so the allowlist cannot silently go stale in the other direction either.
"""
import ast
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
TARGET = os.path.join(HERE, "gate-closure-check.py")

GATE_TOKEN = r"(?:QA2?|CYBERSEC2?|WHITEHAT2?|CYBERED|REDHAT)"
OUTCOME_TOKEN = r"(?:PASS|FAIL|NO-GO|GO)"
GATE_BOUNDED = re.compile(r"(?<![A-Za-z0-9_])" + GATE_TOKEN + r"(?![A-Za-z0-9_])")
OUTCOME_BOUNDED = re.compile(r"(?<![A-Za-z0-9_-])" + OUTCOME_TOKEN + r"(?![A-Za-z0-9_-])")

# The one TS file named in the original REVIEW/NO-GO. Not a recursive src/ scan -- see docstring.
NAMED_TS_FILE = os.path.join(REPO_ROOT, "src", "web", "kanban-gate-completeness-guard.ts")

# Measured 2026-11-14 by running the shape-detector below against the full scoped tree (see
# docstring). gate_verdict_tokens.py is the one TRUE source and is expected to have the shape;
# every other entry is a pre-existing, out-of-scope-for-this-card legacy copy (F5/F7/F8).
# gate-closure-check.py is deliberately NOT here: this card's whole point is that it has none.
ALLOWLIST = frozenset(
    {
        "store/gate_verdict_tokens.py",
        "store/cybered-gate-scan.py",
        "store/gate-dispatch-check.sh",
        "store/gate-pretriage-candidates.py",
        "store/gate_scan_lib.py",
        "store/heartbeat-scriptfirst.sh",
        "store/landing-gate-verdict-parse.py",
        "store/nmr-rederive.py",
        "store/unlanded-branch-sweep.sh",
        "src/web/kanban-gate-completeness-guard.ts",
    }
)


def _strip_comments(path, text):
    if path.endswith(".py") or path.endswith(".sh"):
        return "\n".join(line.split("#", 1)[0] for line in text.splitlines())
    return "\n".join(re.sub(r"//.*$", "", line) for line in text.splitlines())


def _regex_literals_py(code):
    for m in re.finditer(r"re\.compile\(\s*((?:r?['\"].*?['\"]\s*\n?\s*)+)", code, re.DOTALL):
        yield m.group(1)


def _regex_literals_sh(code):
    for m in re.finditer(
        r"(?:grep\s+-[A-Za-z]*E[A-Za-z]*\s+['\"](.+?)['\"]|=~\s*['\"](.+?)['\"])", code
    ):
        yield m.group(1) or m.group(2)
    for m in re.finditer(r"^\s*[A-Z][A-Z0-9_]*=['\"](.+?)['\"]\s*$", code, re.MULTILINE):
        yield m.group(1)


def _const_literals_py(code):
    for m in re.finditer(
        r"^([A-Z][A-Z0-9_]*)\s*(?::\s*\S+)?\s*=\s*(?:frozenset\(|set\(\[|[\{\[\(])(.*?)"
        r"(?:\)\)|\]\)|[\}\]\)])\s*$",
        code,
        re.MULTILINE | re.DOTALL,
    ):
        yield m.group(1), m.group(2)


def _shape_in_text(text):
    return bool(GATE_BOUNDED.search(text) and OUTCOME_BOUNDED.search(text))


def has_shape(path):
    """True iff `path` contains the verdict-token SHAPE: an outcome word together with a gate
    name in one regex pattern or one named literal, or 2+ outcome words together (a PASSING-like
    set, which carries the vocabulary even with zero gate names in that one literal)."""
    with open(path, encoding="utf-8", errors="ignore") as f:
        raw = f.read()
    code = _strip_comments(path, raw)
    if path.endswith(".py"):
        for lit in _regex_literals_py(code):
            if _shape_in_text(lit):
                return True
        for _name, body in _const_literals_py(code):
            gates = GATE_BOUNDED.findall(body)
            outcomes = OUTCOME_BOUNDED.findall(body)
            if (gates and outcomes) or len(outcomes) >= 2:
                return True
        return False
    if path.endswith(".sh"):
        for lit in _regex_literals_sh(code):
            if _shape_in_text(lit):
                return True
        for lit in _regex_literals_py(code):  # some .sh files embed python heredocs
            if _shape_in_text(lit):
                return True
        return False
    # .ts (only ever called on the one named file here)
    return _shape_in_text(code)


PROTECTED_NAMES = frozenset({"PASSING", "VERDICT_RE", "_VERDICT"})


def _assign_targets(stmt):
    """Names a top-level Assign/AnnAssign/AugAssign in gate-closure-check.py rebinds, whatever
    constructor the right-hand side uses -- case 8 does not care if it's a literal, set(), tuple(),
    a `|` union or a call, only that one of the three protected names is the TARGET."""
    if isinstance(stmt, ast.Assign):
        names = []
        for t in stmt.targets:
            if isinstance(t, ast.Name):
                names.append(t.id)
            elif isinstance(t, (ast.Tuple, ast.List)):
                names.extend(e.id for e in t.elts if isinstance(e, ast.Name))
        return names
    if isinstance(stmt, (ast.AnnAssign, ast.AugAssign)) and isinstance(stmt.target, ast.Name):
        return [stmt.target.id]
    return []


def rebinds_protected_name(path):
    """True iff TARGET's module-level body (not inside a function/class) contains an
    Assign/AnnAssign/AugAssign to PASSING, VERDICT_RE or _VERDICT -- an import (ImportFrom) is a
    different AST node and never trips this, so the normal `from gate_verdict_tokens import ...`
    line stays silent."""
    with open(path, encoding="utf-8") as f:
        tree = ast.parse(f.read(), filename=path)
    for stmt in tree.body:
        for name in _assign_targets(stmt):
            if name in PROTECTED_NAMES:
                return True, name
    return False, None


def scan_tree():
    """Returns the set of repo-relative paths (within the scoped tree) that currently have the
    shape. Scope: store/*.py + store/*.sh (flat), plus the one named TS file -- see docstring."""
    found = set()
    store_dir = os.path.join(REPO_ROOT, "store")
    for fn in os.listdir(store_dir):
        if not (fn.endswith(".py") or fn.endswith(".sh")):
            continue
        if "selftest" in fn:
            continue
        full = os.path.join(store_dir, fn)
        if has_shape(full):
            found.add("store/" + fn)
    if os.path.isfile(NAMED_TS_FILE) and has_shape(NAMED_TS_FILE):
        found.add("src/web/kanban-gate-completeness-guard.ts")
    return found


with open(TARGET, encoding="utf-8") as f:
    # Comments must not trip this: the file's own history (kept above the import line) quotes the
    # regex and the set literal in prose while explaining the move (card ec34c025 again, and the
    # general rule from guards-that-pin-behaviour -- a guard must match the OPERATIVE line, not any
    # line that merely mentions the shape). Strip full-line and trailing comments before scanning.
    lines = []
    for raw in f:
        code = raw.split("#", 1)[0]
        lines.append(code)
    source = "\n".join(lines)

failures = []
n = 0


def check(label, cond):
    global n
    n += 1
    print("%s %s" % ("OK  " if cond else "FAIL", label))
    if not cond:
        failures.append(label)


# --- cases 1-4: unchanged (NO-GO 31111 fix direction: "keep the 4 existing cases") -------------
check(
    "no inline _VERDICT = re.compile(...) in gate-closure-check.py",
    not re.search(r"^_VERDICT\s*=\s*re\.compile", source, re.MULTILINE),
)
check(
    "no inline PASSING = {...} in gate-closure-check.py",
    not re.search(r"^PASSING\s*=\s*[{(]", source, re.MULTILINE),
)
check(
    "gate-closure-check.py imports VERDICT_RE from gate_verdict_tokens",
    bool(re.search(r"^from gate_verdict_tokens import\b.*\bVERDICT_RE\b", source, re.MULTILINE)),
)
check(
    "gate-closure-check.py imports PASSING from gate_verdict_tokens",
    bool(re.search(r"^from gate_verdict_tokens import\b.*\bPASSING\b", source, re.MULTILINE)),
)

# --- case 5+: the allowlist ratchet (new) --------------------------------------------------------
_found = scan_tree()
check(
    "gate-closure-check.py carries no verdict-token shape of its own (shape-based, not spelling)",
    "store/gate-closure-check.py" not in _found,
)
check(
    "the set of files with the verdict-token shape equals the explicit allowlist "
    "(found=%s)" % ",".join(sorted(_found - ALLOWLIST)) if (_found - ALLOWLIST) else
    "the set of files with the verdict-token shape equals the explicit allowlist (no extras)",
    not (_found - ALLOWLIST),
)
check(
    "no allowlisted file has silently lost its shape without the allowlist shrinking "
    "(stale=%s)" % ",".join(sorted(ALLOWLIST - _found)) if (ALLOWLIST - _found) else
    "every allowlisted file still carries the shape (allowlist is not stale)",
    not (ALLOWLIST - _found),
)

# --- case 8: AST rebind guard (Cybersec GO 31290 MEDIUM-1) ---------------------------------------
_rebound, _rebound_name = rebinds_protected_name(TARGET)
check(
    "gate-closure-check.py does not rebind PASSING/VERDICT_RE/_VERDICT by any constructor "
    "(rebound=%s)" % _rebound_name if _rebound else
    "gate-closure-check.py does not rebind PASSING/VERDICT_RE/_VERDICT by any constructor",
    not _rebound,
)

print()
print("selftest: %d case(s), %s" % (n, "PASS" if not failures else "FAIL"))
for f in failures:
    print("  - %s" % f)
sys.exit(1 if failures else 0)
