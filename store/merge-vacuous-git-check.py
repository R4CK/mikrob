#!/usr/bin/env python3
"""merge-vacuous-git-check.py -- find git commands that answer VACUOUSLY on a merge commit.

WHY THIS EXISTS (card 1d851280, from Cybered's finding on 90eaa6e5, comment 20408). A gate verifies
claims like "the commit contains this test file" or "I did not touch that file" by asking git what a
sha carries. Several of the obvious spellings answer differently -- and wrongly -- when the sha is a
MERGE commit, which on this fleet is the normal shape of a landing.

MEASURED HERE, git 2.53.0, on merge 8c960106 which carries 12 files:

    git show --name-only <merge>            ->  1 file      PARTIAL
    git show --stat <merge>                 -> 12 files     correct
    git show <merge> -- <path>              ->  empty       VACUOUS
    git show --stat <merge> -- <path>       ->  empty       VACUOUS
    git diff <merge>^1 <merge>              -> 12 files     correct
    git diff <merge>^1 <merge> -- <path>    -> the diff     correct

THE CARD'S PREMISE NEEDED CORRECTING, and the correction matters. It said `--name-only` gives an
EMPTY list on a merge. It does not: it gives a PARTIAL one, listing only the files that differ from
ALL parents (the conflict resolutions). That is worse than empty. An empty answer looks broken and
invites a second look; a one-file answer looks like the truth. Measured twice on my own landings
today, where `git show --name-only` on the landing merge reported exactly `DECISIONS.md` -- a
plausible, complete-looking, wrong answer.

Note also that `--stat` and `--name-only` DISAGREE on the same merge, and that adding a pathspec
flips `--stat` from correct to vacuous. Relying on which flag happens to work is not a convention;
`git diff <sha>^1 <sha>` is, and it is identical to `git show` on a non-merge.

Usage:
  merge-vacuous-git-check.py <file> [<file>...]     report vacuous shapes in these files
  merge-vacuous-git-check.py --selftest

Exit: 1 if any vacuous shape was found, else 0.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

# `git show` listing FILE NAMES for a commit. Partial on a merge.
_SHOW_NAMES = re.compile(r"git\s+show\b(?![^\n`]*\bdiff\b)[^\n`]*--name-(?:only|status)")
# `git show` restricted to a PATHSPEC. Empty on a merge, which reads as "this commit does not touch
# the file" -- the direction that confirms a false claim.
_SHOW_PATHSPEC = re.compile(r"git\s+show\b[^\n`]*?\s--\s+\S")

# A line that already names the safe form is not a finding, even if it also quotes the unsafe one:
# that is how the fix gets DOCUMENTED, and flagging it would make the guard un-adoptable.
_SAFE_NEARBY = re.compile(r"git\s+(?:diff|log)\b[^\n]*(?:\^1|--first-parent)")


def findings(text):
    """[(lineno, shape, line)] for each vacuous-on-a-merge git command."""
    out = []
    for i, line in enumerate(text.split("\n"), 1):
        if _SAFE_NEARBY.search(line):
            continue
        if _SHOW_NAMES.search(line):
            out.append((i, "show --name-only", line.strip()))
        elif _SHOW_PATHSPEC.search(line):
            out.append((i, "show <sha> -- <path>", line.strip()))
    return out


def _selftest():
    failures = []
    n = 0

    def case(label, text, expect):
        nonlocal n
        n += 1
        got = len(findings(text))
        if got != expect:
            failures.append("%s: expected %d finding(s), got %d" % (label, expect, got))
            print("FAIL %s" % label)
        else:
            print("OK   %s" % label)

    # THE FOUNDING SHAPES, both measured above.
    case("git show --name-only is partial on a merge", "run `git show --name-only <sha>`", 1)
    case("git show with a pathspec is empty on a merge", "git show <sha> -- apps/api/src/x.ts", 1)
    # THE SAFE FORM must never be flagged, or nobody adopts the guard.
    case("the safe form is clean", "git diff <sha>^1 <sha> --name-only", 0)
    case("the safe form with a pathspec is clean", "git diff <sha>^1 <sha> -- apps/api/src/x.ts", 0)
    case("--first-parent is the other safe spelling",
         "git log -1 --name-only --first-parent <sha>", 0)
    # A line that documents the fix quotes BOTH forms; flagging it would punish the fix itself.
    case("a line naming the safe form alongside the unsafe one is not a finding",
         "NOT `git show --name-only` -- use `git diff <sha>^1 <sha> --name-only`", 0)
    # CONTROLS: reading file CONTENT at a ref is a different command and is unaffected by merges.
    case("CONTROL: git show <ref>:<path> reads content, not a diff", "git show HEAD:package.json", 0)
    case("CONTROL: a bare git show is not a file-list claim", "git show <sha>", 0)
    # CONTROL: --stat without a pathspec measured CORRECT, so it must not be swept up.
    case("CONTROL: git show --stat with no pathspec is correct on a merge", "git show <sha> --stat", 0)

    print()
    print("selftest: %d case(s), %s" % (n, "PASS" if not failures else "FAIL"))
    for f in failures:
        print("  - %s" % f)
    return 1 if failures else 0


def main(argv):
    if "--selftest" in argv or not argv:
        return _selftest()
    total = 0
    for name in argv:
        p = Path(name)
        try:
            rows = findings(p.read_text(encoding="utf-8", errors="replace"))
        except OSError as exc:
            print("SKIP %s: %s" % (name, exc))
            continue
        for lineno, shape, line in rows:
            total += 1
            print("%s:%d: %s is vacuous on a merge commit -- use `git diff <sha>^1 <sha>`"
                  % (name, lineno, shape))
            print("    %s" % line[:110])
    if total:
        print("\n%d vacuous-on-a-merge command(s). On this fleet a landing IS a merge commit, so "
              "these answer about the wrong thing exactly when it matters." % total)
        return 1
    print("OK: no vacuous-on-a-merge git command in %d file(s)" % len(argv))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
