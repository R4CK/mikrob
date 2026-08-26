#!/usr/bin/env python3
"""Cross-check a full-value-audit inventory against a repomix pack manifest (card 95f861f1).

WHY THIS EXISTS. repomix was adopted on 2026-07-31 and gated behind store/repomix.sh, and then the
output directory did not move again: one 3.7 KB smoke pack, nothing since. A tool that is installed,
wrapped and documented but never invoked is the same class as a detection with no consumer -- it
looks like a capability on the board and is not one.

The consumer this wires it to is a rule the audit skills already carry and cannot currently enforce:

    "Nothing is implicit. Anything not on the inventory and not tested is treated as BROKEN.
     No silent gaps: if you did not test something, list it explicitly as NOT tested / why."

That is honour-based prose. A repomix pack is a mechanical, complete manifest of every source file
in the tree, so the two together make the rule checkable: every file in the pack must be MENTIONED
somewhere in the audit report -- as tested, or explicitly as not-tested-because. A file nobody
mentioned is a silent gap, which is exactly what the rule forbids.

WHAT THIS PROVES, AND WHAT IT DOES NOT. It proves no source file went unmentioned. It does NOT prove
the inventory is complete WITHIN a file: an audit report can name PublicScanPage.tsx and still miss
three of its buttons. This is the mechanical floor under the rule, not the rule itself -- and saying
so matters, because a control we wrongly believe is closed is worse than one with a known gap (the
same reasoning store/repomix.sh states about its own secret scan).

USAGE
    store/audit-pack-coverage.py <inventory-file> --pack <pack.xml>
    store/audit-pack-coverage.py <inventory-file> --repo <repo-path>   # packs it first

Exit: 0 every packed file is mentioned | 1 silent gaps found | 2 usage/setup failure
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import typing
from collections import Counter

FILE_ATTR_RE = re.compile(r'<file\s+path="([^"]+)"')
REPOMIX_SH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "repomix.sh")


def die(msg: str) -> "typing.NoReturn":
    """Setup/usage failures exit 2, never 1 -- 1 means "the check ran and found gaps". A caller that
    cannot tell a missing pack from a failing audit will wire this into CI and read every red as a
    gap list."""
    print(f"audit-pack-coverage: {msg}", file=sys.stderr)
    sys.exit(2)


def parse_pack(pack_path: str) -> list[str]:
    """Every file path the pack carries, in pack order."""
    try:
        with open(pack_path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError as err:
        die(f"cannot read pack {pack_path}: {err}")
    return FILE_ATTR_RE.findall(text)


def build_pack(repo: str) -> str:
    """Run the GATED wrapper, never repomix directly -- the wrapper is where the secret-scan and the
    forbidden-flag refusals live (card b41c3dd3). Its output path is derived the same way it does."""
    if not os.path.isdir(repo):
        die(f"not a directory: {repo}")
    proc = subprocess.run(
        ["bash", REPOMIX_SH, "pack", repo], capture_output=True, text=True, check=False
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        die(
            f"repomix.sh pack failed (exit {proc.returncode}). "
            "A refusal here is the wrapper doing its job -- read its message before retrying."
        )
    # Take the path from the wrapper's OWN report line, never re-derive it. repomix.sh writes to an
    # ABSOLUTE out-dir, so deriving it relative to this script is correct in the main clone and
    # silently wrong from an agent worktree -- it would look for the pack in a directory the wrapper
    # never writes to. Asking the tool where it put the file cannot drift from where it put it.
    for line in reversed((proc.stdout + proc.stderr).splitlines()):
        m = re.search(r"pack written to (\S+)", line)
        if m:
            return m.group(1)
    die(
        "repomix.sh reported success but no 'pack written to <path>' line -- refusing to guess the "
        "output path (its out-dir is absolute and need not sit beside this script)."
    )


def _named(needle: str, inventory: str) -> bool:
    r"""`needle` appears in `inventory` as a whole filename, not as part of a longer one.

    A PLAIN SUBSTRING TEST IS WRONG HERE, and my own selftest caught it doing exactly the damage
    this script exists to prevent: `money.ts` is a substring of `xmoney.ts`, so a report that
    mentioned only the latter marked the former covered. Same shape for `money.ts` inside
    `money.tsx`. An over-reporting coverage check is worse than no check, because its output is read
    as evidence that nothing was skipped.

    So both ends are bounded: nothing filename-ish may sit immediately before or after the match.
    A trailing `.` is allowed (a sentence can end on the name), which is why the right-hand class is
    word-characters and `-` rather than `\b`.

    Card c93b42a8 (Cybersec 95f861f1): the right-hand bound alone let a SIBLING FILE'S EXTENSION
    read as coverage -- "src/index.ts.bak" or "src/index.ts.map" both matched needle "src/index.ts"
    unbounded, because a `.` satisfies neither `\w` nor `-`. A naive fix (moving the `.` into the
    lookahead class) was measured to cost 2 real cases (a sentence ending "src/index.ts." would then
    fail the lookahead too). The asymmetric fix instead: still allow a bare trailing `.`, but refuse
    one immediately followed by ANOTHER word character -- that shape is a file extension
    (.bak/.map/.snap/.example), never a real sentence terminator (those end in end-of-string,
    whitespace, a comma, or a closing punctuation mark, none of which are `\w`)."""
    return re.search(rf"(?<![\w/.-]){re.escape(needle)}(?![\w-])(?!\.\w)", inventory) is not None


def mentioned(path: str, inventory: str, ambiguous_basenames: set[str]) -> bool:
    """A file counts as covered when the report names it.

    The full repo-relative path always counts. A BARE BASENAME counts only when it is unique in the
    pack: `index.ts` appears in a dozen packages, so accepting it would mark eleven other files
    covered because someone audited the twelfth."""
    if _named(path, inventory):
        return True
    base = os.path.basename(path)
    if base in ambiguous_basenames:
        return False
    return _named(base, inventory)


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True, description=__doc__.split("\n")[0])
    ap.add_argument("inventory", help="the audit report / inventory file to check")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--pack", help="an existing repomix pack .xml")
    src.add_argument("--repo", help="a repo to pack first, through store/repomix.sh")
    ap.add_argument(
        "--max-listed",
        type=int,
        default=40,
        help="cap on how many gaps are printed (the COUNT is always exact and always reported)",
    )
    args = ap.parse_args()

    try:
        with open(args.inventory, encoding="utf-8", errors="replace") as fh:
            inventory = fh.read()
    except OSError as err:
        die(f"cannot read inventory {args.inventory}: {err}")

    pack_path = args.pack if args.pack else build_pack(args.repo)
    paths = parse_pack(pack_path)

    # ANTI-VACUITY, and the whole reason this check can be trusted. With an empty manifest every
    # loop below is a no-op and the script would report "0 gaps" -- a clean bill of health produced
    # by measuring nothing. A wrong pack path, a renamed attribute in a future repomix, or a pack of
    # an empty subtree all land here. Fail loudly instead.
    if not paths:
        print(f"audit-pack-coverage: pack {pack_path} lists NO files.", file=sys.stderr)
        print(
            "  That is not a pass: an empty manifest makes this check vacuous. Check the pack path, "
            "and that the packed tree is not entirely gitignored.",
            file=sys.stderr,
        )
        return 2

    counts = Counter(os.path.basename(p) for p in paths)
    ambiguous = {b for b, n in counts.items() if n > 1}

    gaps = [p for p in paths if not mentioned(p, inventory, ambiguous)]
    covered = len(paths) - len(gaps)

    print(f"pack:      {pack_path}")
    print(f"inventory: {args.inventory}")
    print(f"files in pack: {len(paths)}   mentioned: {covered}   SILENT GAPS: {len(gaps)}")
    if ambiguous:
        print(
            f"note: {len(ambiguous)} basename(s) are not unique in the pack "
            f"(e.g. {', '.join(sorted(ambiguous)[:3])}) -- those need the FULL path in the report."
        )
    if not gaps:
        print("OK -- every packed file is named somewhere in the inventory.")
        print(
            "LIMIT: this proves no FILE went unmentioned. It does not prove the inventory is "
            "complete within a file (a named page can still be missing three of its buttons)."
        )
        return 0

    print("\nFiles the inventory never mentions -- each is a silent gap the audit rule forbids:")
    for p in gaps[: args.max_listed]:
        print(f"  {p}")
    if len(gaps) > args.max_listed:
        print(f"  ... and {len(gaps) - args.max_listed} more (count above is exact)")
    print("\nFix: test them and add them, or list them explicitly as NOT tested + why.")
    return 1


# ---------------------------------------------------------------------------------------------
# SELFTEST. Run by src/__tests__/graph-tooling-selftests.test.ts on every change, for the reason
# this whole card exists: a check nobody invokes is documentation, not a control -- and shipping an
# un-run selftest ON THIS CARD would be the exact defect it was opened to fix.
# ---------------------------------------------------------------------------------------------
def _selftest() -> int:
    import tempfile

    passed, failed = 0, 0

    def check(name: str, got: object, want: object) -> None:
        nonlocal passed, failed
        if got == want:
            passed += 1
        else:
            failed += 1
            print(f"FAIL: {name}\n  got:  {got!r}\n  want: {want!r}")

    def pack_xml(paths: list[str]) -> str:
        body = "\n".join(f'<file path="{p}">contents</file>' for p in paths)
        return f"<files>\n{body}\n</files>\n"

    def run(inventory: str, paths: list[str], extra: list[str] | None = None) -> tuple[int, str]:
        with tempfile.TemporaryDirectory() as tmp:
            inv = os.path.join(tmp, "inv.md")
            pk = os.path.join(tmp, "p-pack.xml")
            with open(inv, "w", encoding="utf-8") as fh:
                fh.write(inventory)
            with open(pk, "w", encoding="utf-8") as fh:
                fh.write(pack_xml(paths) if paths else "<files></files>")
            proc = subprocess.run(
                [sys.executable, os.path.abspath(__file__), inv, "--pack", pk] + (extra or []),
                capture_output=True, text=True, check=False,
            )
            return proc.returncode, proc.stdout + proc.stderr

    # --- the two verdicts ---
    code, out = run("- src/a.ts tested\n- src/b.ts tested\n", ["src/a.ts", "src/b.ts"])
    check("complete inventory exits 0", code, 0)
    check("complete inventory reports no gaps", "SILENT GAPS: 0" in out, True)

    code, out = run("- src/a.ts tested\n", ["src/a.ts", "src/b.ts"])
    check("a silent gap exits 1", code, 1)
    check("the gap is named", "src/b.ts" in out, True)
    check("the gap count is exact", "SILENT GAPS: 1" in out, True)

    # --- ANTI-VACUITY: an empty manifest must never read as a pass ---
    code, out = run("- anything\n", [])
    check("an empty manifest exits 2, not 0", code, 2)
    check("and says why", "vacuous" in out, True)

    # --- setup failures are 2, distinguishable from a gap list (1) ---
    proc = subprocess.run(
        [sys.executable, os.path.abspath(__file__), "/nonexistent-inv", "--pack", "/nonexistent.xml"],
        capture_output=True, text=True, check=False,
    )
    check("missing inventory exits 2, not 1", proc.returncode, 2)

    with tempfile.TemporaryDirectory() as tmp:
        inv = os.path.join(tmp, "i.md")
        with open(inv, "w", encoding="utf-8") as fh:
            fh.write("x")
        proc = subprocess.run(
            [sys.executable, os.path.abspath(__file__), inv, "--pack", "/nonexistent.xml"],
            capture_output=True, text=True, check=False,
        )
        check("missing pack exits 2, not 1", proc.returncode, 2)

    # --- how a file counts as mentioned ---
    code, _ = run("- src/deep/nested/a.ts tested\n", ["src/deep/nested/a.ts"])
    check("full path counts", code, 0)

    code, _ = run("- a.ts tested\n", ["src/deep/nested/a.ts"])
    check("unique basename counts", code, 0)

    # THE over-reporting guard. index.ts exists in every package; if a bare basename counted while
    # ambiguous, auditing ONE index.ts would mark every other one covered.
    code, out = run("- index.ts tested\n", ["a/index.ts", "b/index.ts"])
    check("ambiguous basename does NOT count", code, 1)
    check("both ambiguous files are gaps", "SILENT GAPS: 2" in out, True)
    check("and the report says the full path is needed", "FULL path" in out, True)

    code, _ = run("- a/index.ts tested\n- b/index.ts tested\n", ["a/index.ts", "b/index.ts"])
    check("ambiguous files DO count when given in full", code, 0)

    # CONTROL for the two cases above: without it, "ambiguous never counts" and "ambiguous always
    # counts" would both satisfy a single-direction test.
    code, _ = run("- a/index.ts tested\n", ["a/index.ts", "b/index.ts"])
    check("one of two ambiguous files named in full leaves exactly one gap", code, 1)

    # --- substring false positives: a longer name must not cover a shorter one ---
    code, _ = run("- src/moneybox.ts tested\n", ["src/money.ts"])
    check("moneybox.ts does not cover money.ts", code, 1)
    code, _ = run("- xmoney.ts tested\n", ["money.ts"])
    check("xmoney.ts does not cover money.ts", code, 1)
    code, _ = run("- see money.ts, tested\n", ["money.ts"])
    check("a basename in prose still counts", code, 0)
    # The .ts / .tsx pair is the realistic version of the same trap in this tree.
    code, _ = run("- src/Page.tsx tested\n", ["src/Page.ts"])
    check("Page.tsx does not cover Page.ts", code, 1)
    code, _ = run("- src/money.ts.\n", ["src/money.ts"])
    check("a name ending a sentence still counts", code, 0)

    # --- card c93b42a8: a sibling file's EXTENSION must not read as coverage of the real file ---
    code, _ = run("- Reviewed src/index.ts.bak\n", ["src/index.ts"])
    check("a .bak sibling does not cover the real file", code, 1)
    code, _ = run("- src/index.ts.map was regenerated\n", ["src/index.ts"])
    check("a .map sibling does not cover the real file", code, 1)
    # CONTROL: the fix must not regress the ordinary sentence-terminal `.` case above, nor these
    # other real, non-extension continuations right after the name.
    code, _ = run("- see src/index.ts, tested\n", ["src/index.ts"])
    check("a comma-terminated mention still counts", code, 0)
    code, _ = run("- see `src/index.ts` tested\n", ["src/index.ts"])
    check("a backtick-terminated mention still counts", code, 0)

    # --- an explicit NOT-tested listing is coverage: that is the rule, not a loophole ---
    code, _ = run("- src/a.ts -- NOT tested (config only, no runtime behaviour)\n", ["src/a.ts"])
    check("an explicit NOT-tested entry counts as mentioned", code, 0)

    # --- the print cap must not shrink the reported COUNT ---
    many = [f"src/f{i}.ts" for i in range(10)]
    code, out = run("nothing here\n", many, ["--max-listed", "3"])
    check("capped listing still exits 1", code, 1)
    check("the exact count survives the cap", "SILENT GAPS: 10" in out, True)
    check("and the cap announces what it dropped", "and 7 more" in out, True)

    print(f"{passed}/{passed + failed} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    sys.exit(main())
