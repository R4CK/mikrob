#!/usr/bin/env python3
"""Selftest for store/readme-bullet-union.py (card 8b73953c).

ITS OWN CORPUS, deliberately not a reused DECISIONS.md fixture (plan-grilling verdict item
(a)). The two files have different structure -- DECISIONS.md is a run of dated `## ` entries at
the tail of the file, README's fork section is a run of single-line `- **` bullets in the
MIDDLE, with an intro paragraph before it and a `### ` sub-heading plus a doc table after. A
fixture borrowed from the other file would exercise neither the surround nor the entry form
that this tool actually has to get right.

Every case is asserted on the tool's real return, and each one is checked to be non-vacuous by
`--mutations`, which breaks the tool in named ways and requires the matching case to go red.
"""
import importlib.util, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def load(path=None):
    spec = importlib.util.spec_from_file_location(
        "rbu", path or os.path.join(HERE, "readme-bullet-union.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


# A miniature of the REAL structure: intro prose, a bullet run, a sub-heading, a table.
# Anything the tool does wrong at a boundary shows up as prose or a table row moving.
HEAD = "# MikroB\n\n## Egyedi fork-fejlesztések (amiért külön fork)\n\nA fork saját fejlesztései.\n\n"
TAIL = "\n### Dokumentáció-index\n\n| Funkció | Lap |\n|---|---|\n| Kanban | docs/kanban.md |\n"
A = "- **Kártya-függőségek**: irányított sorrend-él két kanban-kártya között.\n"
B = "- **Worktree-izoláció**: minden ügynök a saját git-worktree-jében dolgozik.\n"


def doc(bullets, head=HEAD, tail=TAIL):
    return head + "".join(bullets) + tail


CASES = []


def case(name, base, ours, theirs, expect, name_arg="README.md", union=None):
    CASES.append((name, base, ours, theirs, expect, name_arg, union))


L = "- **Bal oldali új**: a bal ág fejlesztése.\n"
R = "- **Jobb oldali új**: a jobb ág fejlesztése.\n"

# THE ONE SHAPE THAT ACTUALLY CONFLICTS, measured on real history before this was written:
# insertions far apart merge cleanly, ADJACENT insertions also merge cleanly, only two
# insertions at the SAME point conflict. This is the case the tool exists for.
case("both append at the same point", doc([A, B]), doc([A, B, L]), doc([A, B, R]),
     True, union=doc([A, B, L, R]))

# THE SURROUND MUST BE THE MERGE-BASE. Each of these is a different situation that a landing
# must not auto-resolve, and each would be invisible to a check that only looked at the
# inserted lines.
case("one side also edits the doc table", doc([A, B]), doc([A, B, L]),
     doc([A, B, R], tail=TAIL.replace("Kanban", "Kanban (új)")), False)
case("one side rewords an EXISTING bullet", doc([A, B]),
     doc([A, B.replace("saját", "SAJÁT")], ), doc([A, B, R]), False)
case("one side edits the intro paragraph", doc([A, B]),
     doc([A, B, L], head=HEAD.replace("saját fejlesztései", "fejlesztései")), doc([A, B, R]), False)

# THE MIDDLE MUST BE WHOLE BULLET ENTRIES. The measured corpus has zero indented continuation
# lines, so a continuation here means the region is not what the tool assumes.
case("one side adds prose instead of a bullet", doc([A, B]),
     doc([A, B, L]), doc([A, B]) .replace(TAIL, "\nsima próza sor\n" + TAIL), False)
case("one side adds an indented continuation", doc([A, B]),
     doc([A, B, L]), doc([A, B, R + "  folytatás behúzva\n"]), False)

# THE ALLOWLIST IS THE OUTER GATE. Auto-detecting append-only files was rejected in the
# plan-grilling: a wrong positive silently corrupts a file that is not append-only.
case("a file not on the allowlist", doc([A, B]), doc([A, B, L]), doc([A, B, R]),
     False, name_arg="DECISIONS.md")
case("CHANGELOG.md is not on the allowlist either", doc([A, B]), doc([A, B, L]), doc([A, B, R]),
     False, name_arg="CHANGELOG.md")

# THE SAME PRICE THE DECISIONS UNION PAYS, and it should be paid the same way here: if both
# sides wrote the SAME new bullet and then their own, a machine cannot tell a duplicate from
# two people documenting the same thing, so it refuses rather than guessing.
S = "- **Közös új**: mindkét ág felvette.\n"
case("the same new bullet on both sides", doc([A, B]), doc([A, B, S, L]), doc([A, B, S, R]), False)

# UTF-8 END TO END. The sibling tool lost three review rounds to byte-versus-character
# indexing; this one cannot have that bug by construction, and this case is what proves the
# claim instead of asserting it.
U = "- **Ékezetes**: árvíztűrő tükörfúrógép, őúűéáí ÖÜÓŐÚÉÁŰÍ.\n"
V = "- **Másik ékezetes**: hosszú, ékezetes bejegyzés-szöveg.\n"
case("accented bullets union byte-for-byte", doc([A, B]), doc([A, B, U]), doc([A, B, V]),
     True, union=doc([A, B, U, V]))


def run(mod, verbose=True):
    failed = []
    for name, base, ours, theirs, expect, name_arg, want in CASES:
        ok, reason, union = mod.decide(base, ours, theirs, name_arg)
        bad = None
        if ok != expect:
            bad = "expected %s, got %s (%s)" % (
                "RESOLVED" if expect else "refused", "RESOLVED" if ok else "refused", reason)
        # NOT `want.rstrip()`: the tool round-trips through split("\n")/join("\n"), so a
        # trailing newline survives exactly. Stripping it here made both resolving cases report
        # a mismatch that did not exist -- the assertion was wrong, not the tool.
        elif ok and want is not None and union != want:
            bad = "union mismatch"
        if bad:
            failed.append(name)
            if verbose:
                print("  FAIL %s -> %s" % (name, bad))
        elif verbose:
            print("  ok   %s" % name)
    return failed


# Each mutation names the case it must break. A mutation that breaks nothing means the case
# for it is vacuous; a mutation that breaks a case it does not name means the cases overlap
# more than intended. Both are reported.
# Each mutation names the cases it must break, and the expectations below are MEASURED, not
# intended. The first version of this list asserted that the surround check holds "one side also
# edits the doc table" and "one side edits the intro paragraph"; running it showed both stay red
# with the surround check gone, because an edit outside the insertion point SHRINKS the common
# prefix or suffix, so those lines land in the middle and the ENTRY-FORM check refuses them
# first. Two guards cover them, so no SINGLE mutation can isolate either -- which is why the
# combined mutation exists: a case covered twice still has to be provably non-vacuous.
MUTATIONS = {
    "allowlist accepts anything": (
        lambda m: setattr(m, "ALLOWED_FILES", ("README.md", "DECISIONS.md", "CHANGELOG.md")),
        ["a file not on the allowlist", "CHANGELOG.md is not on the allowlist either"]),
    "surround check removed": (
        lambda m: _patch_surround(m),
        ["one side rewords an EXISTING bullet", "the same new bullet on both sides"]),
    "entry-form check removed": (
        lambda m: setattr(m, "ENTRY_PREFIX", ""),
        ["one side adds prose instead of a bullet", "one side adds an indented continuation"]),
    "BOTH removed (the doubly-covered cases)": (
        lambda m: _patch_both(m),
        ["one side rewords an EXISTING bullet", "the same new bullet on both sides",
         "one side adds prose instead of a bullet", "one side adds an indented continuation",
         "one side also edits the doc table", "one side edits the intro paragraph"]),
}


def _load_patched(replacements):
    src = open(os.path.join(HERE, "readme-bullet-union.py"), encoding="utf-8").read()
    for marker, repl in replacements:
        assert src.count(marker) == 1, marker
        src = src.replace(marker, repl)
    # Written AND CLOSED before loading: importing inside the `with` block read an unflushed,
    # empty file, and the mutated module came back with no `decide` at all.
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as fh:
        fh.write(src)
        path = fh.name
    return load(path)


def _patch_surround(m):
    return _load_patched([("    if surround != b:", "    if False:")])


def _patch_both(m):
    return _load_patched([("    if surround != b:", "    if False:"),
                          ('            if not line.startswith(ENTRY_PREFIX):',
                           '            if False:')])


def mutations():
    problems = 0
    for label, (apply_fn, expect_red) in MUTATIONS.items():
        mod = load()
        maybe = apply_fn(mod)
        if maybe is not None:
            mod = maybe
        red = set(run(mod, verbose=False))
        missing = [c for c in expect_red if c not in red]
        extra = [c for c in red if c not in expect_red]
        # A case red under a mutation that does not name it is not an error by itself -- it
        # means another guard also covers it. Only a MISSING one is a real problem: it says the
        # case cannot tell this mutation from the fixed code.
        status = "ok  " if not missing and not extra else "FAIL"
        if missing or extra:
            problems += 1
        print("  %s mutation %-28s red=%d" % (status, label, len(red)))
        for c in missing:
            print("       MISSING (case is vacuous): %s" % c)
        for c in extra:
            print("       UNEXPECTED red: %s" % c)
    return problems


END_TO_END = r"""
set -e
R="$1/r"; mkdir -p "$R"; git -C "$R" init -q -b main
w() { printf '%b' "$2" > "$R/README.md"; git -C "$R" add README.md; \
      git -C "$R" -c user.email=t@t -c user.name=t commit -q -m "$1"; }
w base '## Fork\n\nintro\n\n- **A**: a.\n- **B**: b.\n\n### Docs\n\n| x |\n'
git -C "$R" branch -q l; git -C "$R" branch -q r
git -C "$R" checkout -q l; w l "$LEFT"
git -C "$R" checkout -q r; w r "$RIGHT"
git -C "$R" checkout -q l
git -C "$R" -c user.email=t@t -c user.name=t merge --no-ff r -m m >/dev/null 2>&1 || true
. "$2/readme-bullet-union.sh"
if try_readme_bullet_union "$R" README.md; then
  echo "RESOLVED"; git -C "$R" diff --cached --name-only
  sed -n '5,9p' "$R/README.md"
else
  echo "refused"
  # UNMERGED is the proof that nothing was staged, and `git diff --cached` is NOT: during an
  # unresolved merge the index holds stages 1/2/3, so --cached lists the file no matter what the
  # tool did. The first version of this check used --cached and reported a staging that never
  # happened -- a bad probe, not a bad wrapper.
  git -C "$R" diff --name-only --diff-filter=U | grep -qx README.md && echo "still-unmerged"
  grep -q '^<<<<<<< ' "$R/README.md" && echo "markers-intact"
fi
"""


def end_to_end():
    """THROUGH A REAL GIT CONFLICT, not just decide(). The cases above prove the decision; this
    proves the wiring -- that the three merge stages are read from the index correctly, that a
    resolution is staged, and that a REFUSAL leaves the conflict intact for manual work and
    stages nothing. Accented content, because the sibling tool's whole history was encoding bugs.
    """
    import subprocess
    problems = 0
    left = '## Fork\n\nintro\n\n- **A**: a.\n- **B**: b.\n- **L**: bal ág: őúű.\n\n### Docs\n\n| x |\n'
    right = '## Fork\n\nintro\n\n- **A**: a.\n- **B**: b.\n- **R**: jobb ág: ÁÉÍ.\n\n### Docs\n\n| x |\n'
    right_bad = '## Fork\n\nintro\n\n- **A**: a.\n- **B**: b.\nsima próza.\n\n### Docs\n\n| y |\n'
    for label, r, expect in (("resolves and stages", right, "RESOLVED"),
                             ("refuses, leaves the conflict", right_bad, "refused")):
        tmp = tempfile.mkdtemp()
        out = subprocess.run(["bash", "-c", END_TO_END, "_", tmp, HERE],
                             capture_output=True, text=True,
                             env={**os.environ, "LEFT": left, "RIGHT": r})
        text = out.stdout
        ok = text.startswith(expect)
        if expect == "RESOLVED":
            ok = ok and "bal ág: őúű" in text and "jobb ág: ÁÉÍ" in text
        else:
            ok = ok and "markers-intact" in text and "still-unmerged" in text
        print("  %s e2e: %s" % ("ok  " if ok else "FAIL", label))
        if not ok:
            problems += 1
            print("       stdout=%r stderr=%r" % (text[:300], out.stderr[:200]))
    return problems


if __name__ == "__main__":
    print("readme-bullet-union selftest")
    fails = run(load())
    print("  --- end to end ---")
    e2e = end_to_end()
    print("  --- mutations ---")
    probs = mutations()
    # THE SUMMARY CARRIES THE COUNT, in the shape src/__tests__/store-selftests-all-run.test.ts
    # already recognises. A bare "selftest: PASS" is what that guard exists to reject: it cannot
    # tell a suite that ran everything from one that ran nothing, which is the exact failure it
    # was written for. Reusing an existing shape rather than adding one keeps that guard tight.
    total = len(CASES) + 2 + len(MUTATIONS)
    failed = len(fails) + e2e + probs
    if failed:
        print("selftest: %d passed, %d failed" % (total - failed, failed))
        sys.exit(1)
    print("selftest: %d passed, 0 failed" % total)
