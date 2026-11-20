#!/usr/bin/env python3
"""Self-test for live-checkout-write-guard.py (card 0c3b13b5).

Run:  python3 scripts/hooks/live-checkout-write-guard.selftest.py
Exit: 0 = all pass, 1 = at least one case wrong.

WHY A FAKE ROOT (same reasoning as npm-protect-guard.selftest.py): the guard's own
"live checkout" is configurable via MARVEEN_MAIN, so the honest test builds a
throwaway git repo with real tracked/untracked files and a separate worktree
directory, and points the guard at THAT via env, instead of mutating the real
/home/neon/marveen tree.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

GUARD = Path(__file__).with_name("live-checkout-write-guard.py")

BLOCK = "block"
ALLOW = "allow"


def _git(root, *args):
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)


def build_world(tmp):
    root = tmp / "live-checkout"
    root.mkdir()
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "t@example.com")
    _git(root, "config", "user.name", "t")
    (root / "store").mkdir()
    (root / "store" / "fleet-test.sh").write_text("#!/bin/bash\necho hi\n")
    (root / "store" / "untracked-runtime.json").write_text("{}")
    (root / "agents" / "backend3").mkdir(parents=True)
    (root / "agents" / "backend3" / "CLAUDE.md").write_text("notes")
    _git(root, "add", "store/fleet-test.sh", "agents/backend3/CLAUDE.md")
    _git(root, "commit", "-q", "-m", "init")

    worktrees = tmp / "worktrees"
    agent_wt = worktrees / "backend3"
    (agent_wt / "store").mkdir(parents=True)
    (agent_wt / "store" / "fleet-test.sh").write_text("#!/bin/bash\necho hi\n")

    outside = tmp / "scratch"
    outside.mkdir()

    return root, worktrees, agent_wt, outside


def verdict(tool_name, tool_input, cwd, env_extra):
    payload = json.dumps({"tool_name": tool_name, "tool_input": tool_input, "cwd": str(cwd)})
    env = dict(os.environ)
    env.update(env_extra)
    p = subprocess.run([sys.executable, str(GUARD)], input=payload, capture_output=True,
                        text=True, env=env)
    return (BLOCK if p.returncode == 2 else ALLOW), (p.stderr or "").strip()


def main():
    tmp = Path(tempfile.mkdtemp(prefix="live-checkout-guard-selftest-"))
    try:
        root, worktrees, agent_wt, outside = build_world(tmp)
        base_env = {"MARVEEN_MAIN": str(root), "MARVEEN_WORKTREES": str(worktrees)}

        def E(**extra):
            e = dict(base_env)
            e.update(extra)
            return e

        cases = [
            # ---- the incident shape: sub-agent Edit on a tracked live-checkout file ----
            (BLOCK, "Edit", {"file_path": str(root / "store" / "fleet-test.sh")}, root,
             E(MARVEEN_AGENT_ID="backend3")),
            (BLOCK, "Write", {"file_path": str(root / "store" / "fleet-test.sh")}, root,
             E(MARVEEN_AGENT_ID="backend3")),
            (BLOCK, "MultiEdit", {"file_path": str(root / "store" / "fleet-test.sh")}, root,
             E(MARVEEN_AGENT_ID="backend3")),
            # self-identity via cwd fallback, no env var
            (BLOCK, "Edit", {"file_path": str(root / "store" / "fleet-test.sh")},
             root / "agents" / "backend3", E()),
            # ---- negative control: identical edit, but inside the agent's OWN worktree ----
            (ALLOW, "Edit", {"file_path": str(agent_wt / "store" / "fleet-test.sh")}, agent_wt,
             E(MARVEEN_AGENT_ID="backend3")),
            # ---- ALLOW: untracked runtime path in the live checkout ----
            (ALLOW, "Edit", {"file_path": str(root / "store" / "untracked-runtime.json")}, root,
             E(MARVEEN_AGENT_ID="backend3")),
            # ---- ALLOW: a brand new (not-yet-tracked) file in the live checkout ----
            (ALLOW, "Write", {"file_path": str(root / "store" / "brand-new.json")}, root,
             E(MARVEEN_AGENT_ID="backend3")),
            # ---- ALLOW: the agent's own agents/<name>/ tree, even though tracked ----
            (ALLOW, "Edit", {"file_path": str(root / "agents" / "backend3" / "CLAUDE.md")}, root,
             E(MARVEEN_AGENT_ID="backend3")),
            # ---- ALLOW: MikroB is exempt ----
            (ALLOW, "Edit", {"file_path": str(root / "store" / "fleet-test.sh")}, root,
             E(MARVEEN_AGENT_ID="mikrob")),
            # ---- ALLOW: self cannot be resolved -> fail open ----
            (ALLOW, "Edit", {"file_path": str(root / "store" / "fleet-test.sh")}, outside,
             E(MARVEEN_AGENT_ID="", CLAUDE_AGENT_ID="")),
            # ---- ALLOW: the escape hatch ----
            (ALLOW, "Edit", {"file_path": str(root / "store" / "fleet-test.sh")}, root,
             E(MARVEEN_AGENT_ID="backend3", MARVEEN_ALLOW_LIVE_EDIT="1")),
            # ---- ALLOW: outside the live checkout entirely ----
            (ALLOW, "Write", {"file_path": str(outside / "notes.txt")}, outside,
             E(MARVEEN_AGENT_ID="backend3")),
        ]

        bash_cases = [
            (BLOCK, f"sed -i 's/a/b/' {root / 'store' / 'fleet-test.sh'}", root,
             E(MARVEEN_AGENT_ID="backend3")),
            (BLOCK, f"tee {root / 'store' / 'fleet-test.sh'} <<<x", root,
             E(MARVEEN_AGENT_ID="backend3")),
            (BLOCK, f"echo hi > {root / 'store' / 'fleet-test.sh'}", root,
             E(MARVEEN_AGENT_ID="backend3")),
            (BLOCK, f"git checkout -- {root / 'store' / 'fleet-test.sh'}", root,
             E(MARVEEN_AGENT_ID="backend3")),
            # relative path resolved against cwd
            (BLOCK, "sed -i 's/a/b/' store/fleet-test.sh", root, E(MARVEEN_AGENT_ID="backend3")),
            # same shapes, but in the agent's own worktree -> allowed
            (ALLOW, f"sed -i 's/a/b/' {agent_wt / 'store' / 'fleet-test.sh'}", agent_wt,
             E(MARVEEN_AGENT_ID="backend3")),
            # untracked target -> allowed
            (ALLOW, f"echo '{{}}' > {root / 'store' / 'untracked-runtime.json'}", root,
             E(MARVEEN_AGENT_ID="backend3")),
            # marveen-land.sh / update.sh named in the command -> exempt
            (ALLOW, f"bash store/marveen-land.sh backend3 > {root / 'store' / 'fleet-test.sh'}",
             root, E(MARVEEN_AGENT_ID="backend3")),
            (ALLOW, f"bash update.sh > {root / 'store' / 'fleet-test.sh'}", root,
             E(MARVEEN_AGENT_ID="backend3")),
            # QA FAIL regression (card 0c3b13b5): the exempt-script check used to be a bare
            # substring search on the whole raw command, so merely MENTIONING the script name
            # anywhere (e.g. a trailing comment) disabled the guard for an unrelated write --
            # this must still be BLOCKed, the comment does not actually invoke anything.
            (BLOCK, f"sed -i 's/a/b/' {root / 'store' / 'fleet-test.sh'} # update.sh", root,
             E(MARVEEN_AGENT_ID="backend3")),
            (BLOCK, f"echo hi > {root / 'store' / 'fleet-test.sh'} # marveen-land.sh", root,
             E(MARVEEN_AGENT_ID="backend3")),
            # the exemption is per-segment, not whole-command: a real update.sh/marveen-land.sh
            # invocation in one segment must not exempt an unrelated write in another segment
            (BLOCK, f"sed -i 's/a/b/' {root / 'store' / 'fleet-test.sh'} && bash update.sh", root,
             E(MARVEEN_AGENT_ID="backend3")),
            # escape hatch
            (ALLOW, f"MARVEEN_ALLOW_LIVE_EDIT=1 sed -i 's/a/b/' {root / 'store' / 'fleet-test.sh'}",
             root, E(MARVEEN_AGENT_ID="backend3")),
            # a quoted/data-only mention is not a real redirect
            (ALLOW, f"echo 'do not run: sed -i x {root / 'store' / 'fleet-test.sh'}'", root,
             E(MARVEEN_AGENT_ID="backend3")),
            # unrelated commands with no file target
            (ALLOW, "npm run build", root, E(MARVEEN_AGENT_ID="backend3")),
            (ALLOW, "git status", root, E(MARVEEN_AGENT_ID="backend3")),
        ]

        failures = []
        for expected, tool, ti, cwd, env in cases:
            got, msg = verdict(tool, ti, cwd, env)
            ok = got == expected
            if not ok:
                failures.append((f"{tool} {ti}", str(cwd), expected, got, msg))
            print(f"  [{'ok ' if ok else 'FAIL'}] {expected:5} {tool} {ti.get('file_path')}")

        for expected, cmd, cwd, env in bash_cases:
            got, msg = verdict("Bash", {"command": cmd}, cwd, env)
            ok = got == expected
            if not ok:
                failures.append((cmd, str(cwd), expected, got, msg))
            print(f"  [{'ok ' if ok else 'FAIL'}] {expected:5} {cmd!r}")

        # Kill switch must actually kill it.
        got, _ = verdict("Edit", {"file_path": str(root / "store" / "fleet-test.sh")}, root,
                          {**base_env, "MARVEEN_AGENT_ID": "backend3", "LIVE_CHECKOUT_WRITE_GUARD": "off"})
        ok = got == ALLOW
        if not ok:
            failures.append(("kill switch", str(root), ALLOW, got, ""))
        print(f"  [{'ok ' if ok else 'FAIL'}] {ALLOW:5} (kill switch off)")

        print()
        total = len(cases) + len(bash_cases) + 1
        if failures:
            print(f"{len(failures)} / {total} FAILED:")
            for cmd, cwd, exp, got, msg in failures:
                print(f"  - {cmd!r} (cwd={cwd}): expected {exp}, got {got}. stderr={msg[:200]}")
            return 1
        print(f"All {total} cases pass.")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
