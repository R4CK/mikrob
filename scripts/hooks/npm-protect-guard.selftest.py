#!/usr/bin/env python3
"""Self-test for npm-protect-guard.py (card 0e135261).

Run:  python3 scripts/hooks/npm-protect-guard.selftest.py
Exit: 0 = all pass, 1 = at least one case wrong.

The ALLOW half is the half that decides whether this guard survives. A guard that blocks
`npm run build`, or a legitimate install in an agent's OWN worktree, gets switched off within a day
and then protects nothing. Every ALLOW case below is a command the fleet really runs.

WHY A FAKE ROOT
The guard derives the protected checkout from its own location, so the honest way to test it is to
put a COPY of it in a throwaway root and build real directories underneath: a real node_modules, a
worktree that symlinks at it (the fleet's pattern, and the dangerous case), and an independent
project with its own modules. Testing against the live checkout instead would measure this machine's
layout -- and it did: an earlier version of this file "passed" only because the worktree it ran from
happened to symlink node_modules at ANOTHER install, which is exactly the confusion the rule is
about.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REAL_GUARD = Path(__file__).with_name("npm-protect-guard.py")
REAL_ROOT = Path(__file__).resolve().parents[2]

BLOCK = "block"
ALLOW = "allow"


def verdict(guard, cmd, cwd):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": str(cwd)})
    p = subprocess.run([sys.executable, str(guard)], input=payload, capture_output=True, text=True)
    return (BLOCK if p.returncode == 2 else ALLOW), (p.stderr or "").strip()


def build_world(tmp):
    """A self-contained stand-in for the fleet's layout."""
    root = tmp / "fake-root"
    (root / "scripts" / "hooks").mkdir(parents=True)
    guard = root / "scripts" / "hooks" / "npm-protect-guard.py"
    shutil.copy2(REAL_GUARD, guard)
    (root / "package.json").write_text("{}")
    (root / "node_modules").mkdir()
    (root / "src").mkdir()

    linked = tmp / "worktree-symlinked"
    linked.mkdir()
    (linked / "package.json").write_text("{}")
    os.symlink(root / "node_modules", linked / "node_modules")

    private = tmp / "worktree-own-modules"
    private.mkdir()
    (private / "package.json").write_text("{}")
    (private / "node_modules").mkdir()

    outside = tmp / "unrelated-project"
    outside.mkdir()
    (outside / "package.json").write_text("{}")

    return guard, root, linked, private, outside


def main():
    tmp = Path(tempfile.mkdtemp(prefix="npm-guard-selftest-"))
    try:
        guard, root, linked, private, outside = build_world(tmp)
        cases = [
            # ---- the incident: a mutating package-manager command in the shared checkout --------
            (BLOCK, "npm ci", root),
            (BLOCK, "npm install", root),
            (BLOCK, "npm i", root),
            (BLOCK, "npm install --save-dev vitest", root),
            (BLOCK, "pnpm install", root),
            (BLOCK, "yarn install", root),
            (BLOCK, "npm ci --omit=dev", root),
            (BLOCK, "npm update", root),
            # a subdirectory counts: npm walks up to the root package.json
            (BLOCK, "npm ci", root / "src"),
            # one level of wrapper is phrasing, not evasion
            (BLOCK, 'bash -c "npm ci"', root),
            # reaching the shared tree from OUTSIDE it
            (BLOCK, f"cd {root} && npm ci", tmp),
            (BLOCK, f"npm install --prefix {root}", tmp),
            # the delete half
            (BLOCK, "rm -rf node_modules", root),
            (BLOCK, "rm -fr ./node_modules", root),
            (BLOCK, f"rm -rf {root}/node_modules", tmp),
            # ---- the case a cwd-only check would MISS -------------------------------------------
            # A "private" worktree whose node_modules is a SYMLINK into the shared tree. npm follows
            # the link, so this wipes the shared install exactly like running it in the root.
            (BLOCK, "npm ci", linked),
            (BLOCK, "npm install", linked),
            # ---- ALLOW: builds and tests, which the fleet runs constantly -----------------------
            (ALLOW, "npm run build", root),
            (ALLOW, "npm run typecheck", root),
            (ALLOW, "npm test", root),
            (ALLOW, "npx vitest run src/__tests__/x.test.ts", root),
            (ALLOW, "npm ls --depth=0", root),
            (ALLOW, "npm --version", root),
            # ---- ALLOW: an agent installing into its OWN real node_modules ---------------------
            (ALLOW, "npm ci", private),
            (ALLOW, "npm install", private),
            (ALLOW, "rm -rf node_modules", private),
            # ---- ALLOW: an unrelated project with no modules yet -------------------------------
            (ALLOW, "npm install", outside),
            # ---- ALLOW: removing a SYMLINK is not removing the shared tree ---------------------
            (ALLOW, "rm -rf node_modules", linked),
            # ---- ALLOW: the explicit, deliberate escape hatch ----------------------------------
            (ALLOW, "MARVEEN_ALLOW_NPM_WRITE=1 npm ci", root),
            (ALLOW, "MARVEEN_ALLOW_NPM_WRITE=1 rm -rf node_modules", root),
            # ---- ALLOW: the command quoted as DATA, not run ------------------------------------
            (ALLOW, "curl -d '{\"note\":\"never run npm ci in the shared checkout\"}' http://x", root),
            (ALLOW, "echo 'npm install is blocked here'", root),
            (ALLOW, "cat > doc.md <<'EOF'\nNe futtass npm ci-t a kozos fan!\nEOF", root),
            # ...but a real command after a heredoc still blocks
            (BLOCK, "cat > doc.md <<'EOF'\nharmless\nEOF\nnpm ci", root),
            # ---- ALLOW: unrelated commands that merely contain the word ------------------------
            (ALLOW, "grep -rn node_modules .gitignore", root),
            (ALLOW, "ls node_modules | head", root),
            (ALLOW, "rm -rf dist", root),
            (ALLOW, "rm -rf /tmp/some-scratch-dir", root),
        ]

        failures = []
        for expected, cmd, cwd in cases:
            got, msg = verdict(guard, cmd, cwd)
            ok = got == expected
            if not ok:
                failures.append((cmd, str(cwd), expected, got, msg))
            print(f"  [{'ok ' if ok else 'FAIL'}] {expected:5} {cmd!r}")

        # The REAL install must be protected too -- the fake root proves the logic, this proves the
        # wiring (that the shipped copy derives the checkout it actually lives in).
        for expected, cmd in ((BLOCK, "npm ci"), (ALLOW, "npm run build")):
            got, msg = verdict(REAL_GUARD, cmd, REAL_ROOT)
            ok = got == expected
            if not ok:
                failures.append((cmd, str(REAL_ROOT), expected, got, msg))
            print(f"  [{'ok ' if ok else 'FAIL'}] {expected:5} {cmd!r} (live checkout)")

        print()
        if failures:
            print(f"{len(failures)} FAILED:")
            for cmd, cwd, exp, got, msg in failures:
                print(f"  - {cmd!r} (cwd={cwd}): expected {exp}, got {got}. stderr={msg[:140]}")
            return 1
        print(f"All {len(cases) + 2} cases pass.")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
