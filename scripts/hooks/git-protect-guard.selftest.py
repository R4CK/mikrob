#!/usr/bin/env python3
"""Self-test for git-protect-guard.py (card 6b532950).

Run:  python3 scripts/hooks/git-protect-guard.selftest.py
Exit: 0 = all pass, 1 = at least one case wrong.

The FALSE-POSITIVE half matters as much as the block half: a guard that wedges a
legitimate `git reset <file>` or `git checkout <branch>` costs the fleet more than
the footgun it prevents. Every ALLOW case below is a command an agent really runs.
"""
import json
import subprocess
import sys
from pathlib import Path

GUARD = str(Path(__file__).with_name("git-protect-guard.py"))

BLOCK = "block"
ALLOW = "allow"

CASES = [
    # ---- pre-existing rules (regression: extending the guard must not break them) ----
    (BLOCK, "git add -A"),
    (BLOCK, "git add ."),
    (BLOCK, "git add --all"),
    (BLOCK, "git add pnpm-lock.yaml"),
    (BLOCK, "git push --force origin main"),
    (ALLOW, "git add src/foo.ts"),
    (ALLOW, "git add -p"),
    (ALLOW, "git push origin main"),
    (ALLOW, "git push --force origin my-feature-branch"),
    # the documented false positive: the rule text quoted inside another command
    (ALLOW, "curl -d '{\"content\":\"never run git add -A here\"}' http://x"),

    # ---- NEW: destructive whole-tree ops (card 6b532950) ----
    (BLOCK, "git reset --hard"),
    (BLOCK, "git reset --hard HEAD~1"),
    (BLOCK, "git reset --hard origin/main"),
    (BLOCK, "cd /repo && git reset --hard"),
    (BLOCK, "git checkout ."),
    (BLOCK, "git checkout -- ."),
    (BLOCK, "git restore ."),
    (BLOCK, "git stash"),
    (BLOCK, "git stash push"),
    (BLOCK, "git stash -u"),
    (BLOCK, "git clean -fd"),
    (BLOCK, "git clean -f"),
    (BLOCK, "git clean -fdx"),

    # ---- NEW: the safe forms MUST keep working ----
    (ALLOW, "git reset src/foo.ts"),           # unstage one file
    (ALLOW, "git reset"),                       # unstage all -- tree untouched
    (ALLOW, "git reset --soft HEAD~1"),         # keeps tree + index
    (ALLOW, "git reset --mixed HEAD~1"),        # keeps tree
    (ALLOW, "git checkout main"),               # switch branch
    (ALLOW, "git checkout -b feature/x"),       # new branch
    (ALLOW, "git checkout HEAD~1 -- apps/api/src/server.ts"),  # targeted restore (used in real work)
    (ALLOW, "git restore --staged ."),          # unstage only -- does NOT touch the tree
    (ALLOW, "git stash pop"),
    (ALLOW, "git stash apply"),
    (ALLOW, "git stash list"),
    (ALLOW, "git stash show -p"),
    (ALLOW, "git stash drop"),
    (BLOCK, "git checkout -f main"),            # forced switch overwrites local edits
    (BLOCK, "git checkout --force main"),
    (BLOCK, 'bash -c "git reset --hard"'),      # one-level wrapper unwrap
    (BLOCK, "sh -c 'git clean -fd'"),
    (BLOCK, 'eval "git reset --hard"'),
    (ALLOW, "git clean -n"),                    # dry run
    (ALLOW, "git clean --dry-run -d"),
    (ALLOW, "git status"),
    (ALLOW, "git diff"),
    (ALLOW, "git log --oneline -5"),
    # quoted mentions must not trip the new rules either
    (ALLOW, "echo 'do not use git reset --hard in a shared checkout'"),
    (ALLOW, "curl -d '{\"note\":\"git clean -fd wiped the tree\"}' http://x"),
]


def verdict(cmd):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}})
    p = subprocess.run(
        [sys.executable, GUARD], input=payload, capture_output=True, text=True
    )
    return (BLOCK if p.returncode == 2 else ALLOW), (p.stderr or "").strip()


def main():
    failures = []
    for expected, cmd in CASES:
        got, msg = verdict(cmd)
        mark = "ok " if got == expected else "FAIL"
        if got != expected:
            failures.append((cmd, expected, got, msg))
        print(f"  [{mark}] {expected:5} {cmd}")
    print()
    if failures:
        print(f"{len(failures)} FAILED:")
        for cmd, exp, got, msg in failures:
            print(f"  - {cmd!r}: expected {exp}, got {got}. stderr={msg[:120]}")
        return 1
    print(f"All {len(CASES)} cases pass.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
