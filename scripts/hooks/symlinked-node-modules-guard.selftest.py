#!/usr/bin/env python3
"""Selftest for symlinked-node-modules-guard.py (card 9dc0fba8).

Runs the guard as the hook runner does (JSON on stdin, exit 2 == blocked) against a REAL fixture:
a fake shared clone, a fake worktree whose apps/web/node_modules is a directory symlink into it,
and the two commands that actually caused the incident. The fixture matters -- the guard's whole
question is what the kernel resolves, which no string-only test can answer.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

GUARD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "symlinked-node-modules-guard.py")


def run(command, cwd=None):
    payload = {"tool_name": "Bash", "tool_input": {"command": command}}
    if cwd is not None:
        payload["cwd"] = cwd
    p = subprocess.run(
        [sys.executable, GUARD],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        cwd=tempfile.gettempdir(),  # never the fixture: a relative path must not resolve by luck
    )
    return p.returncode, p.stderr


def main():
    lab = tempfile.mkdtemp(prefix="nmguard-")
    try:
        main_clone = os.path.join(lab, "MAIN")
        wt = os.path.join(lab, "wt-card")
        # Shared clone: a REAL apps/web/node_modules with a workspace link, as pnpm leaves it.
        os.makedirs(os.path.join(main_clone, "apps/web/node_modules/@cleancore"))
        os.makedirs(os.path.join(main_clone, "packages/i18n"))
        os.symlink("../../../../packages/i18n",
                   os.path.join(main_clone, "apps/web/node_modules/@cleancore/i18n"))
        # Worktree: node_modules is a DIRECTORY symlink into the shared clone (today's shape).
        os.makedirs(os.path.join(wt, "apps/web"))
        os.makedirs(os.path.join(wt, "packages/i18n"))
        os.symlink(os.path.join(main_clone, "apps/web/node_modules"),
                   os.path.join(wt, "apps/web/node_modules"))
        # A worktree that did it RIGHT: a real node_modules of its own.
        good = os.path.join(lab, "wt-real")
        os.makedirs(os.path.join(good, "apps/web/node_modules/@cleancore"))
        os.makedirs(os.path.join(good, "packages/i18n"))

        shared_link = os.path.join(main_clone, "apps/web/node_modules/@cleancore/i18n")
        wt_link = os.path.join(wt, "apps/web/node_modules/@cleancore/i18n")

        # --- 0. THE INCIDENT REPRODUCES without the guard -----------------------------------
        before = os.readlink(shared_link)
        os.remove(wt_link)
        os.symlink(os.path.join(wt, "packages/i18n"), wt_link)
        after = os.readlink(shared_link)
        cases = [(
            "incident reproduces: writing the worktree path rewrote the SHARED link",
            before == "../../../../packages/i18n" and after == os.path.join(wt, "packages/i18n"),
            f"{before!r} -> {after!r}",
        )]
        # put the fixture back so the guard cases below see the original shape
        os.remove(wt_link)
        os.symlink("../../../../packages/i18n", shared_link) if not os.path.lexists(shared_link) else None

        blocked = lambda c, cwd=None: run(c, cwd)[0] == 2
        cases += [
            ("QA's exact ln -s is blocked", blocked(f"ln -s {wt}/packages/i18n {wt_link}"), ""),
            ("QA's exact rm is blocked", blocked(f"rm {wt_link}"), ""),
            ("both on one line, as dispatched", blocked(f"rm {wt_link}\nln -s {wt}/packages/i18n {wt_link}"), ""),
            ("cp into the escaping path is blocked", blocked(f"cp /etc/hostname {wt_link}"), ""),
            ("redirect into the escaping path is blocked", blocked(f"echo x > {wt_link}"), ""),
            # --- must NOT fire ---
            ("reading through the link is allowed",
             not blocked(f"cat {wt_link}"), ""),
            ("grep through the link is allowed",
             not blocked(f"grep -rn foo {wt}/apps/web/node_modules/@cleancore"), ""),
            ("writing in a REAL worktree node_modules is allowed",
             not blocked(f"ln -s {good}/packages/i18n {good}/apps/web/node_modules/@cleancore/i18n"), ""),
            ("writing in the MAIN clone itself is allowed",
             not blocked(f"ln -sfn ../../../../packages/i18n {shared_link}"), ""),
            ("creating the node_modules link itself is allowed",
             not blocked(f"ln -s {main_clone}/apps/web/node_modules {wt}/apps/web/node_modules"), ""),
            ("removing the node_modules link itself is allowed",
             not blocked(f"rm -f {wt}/apps/web/node_modules"), ""),
            # --- case B: unresolvable path, fail CLOSED (the 11:43 repeat) ---
            ("the 11:43 repeat ($WT form) is blocked",
             blocked('rm -f "$WT/apps/web/node_modules/@cleancore/i18n"\n'
                     'ln -s "$WT/packages/i18n" "$WT/apps/web/node_modules/@cleancore/i18n"'), ""),
            ("bare $WT/apps/web/node_modules (the link itself) is allowed",
             not blocked('ln -s "$CC_MAIN/apps/web/node_modules" "$WT/apps/web/node_modules"'), ""),
            ("the setup loop's rm of the bare link is allowed",
             not blocked('rm -rf "$WT/$d/node_modules"'), ""),
            ("reading through a variable path is allowed",
             not blocked('grep -rn foo "$WT/apps/web/node_modules/@cleancore/i18n"'), ""),
            ("a deep path inside a package is not this shape",
             not blocked('cp x "$WT/apps/web/node_modules/@cleancore/i18n/messages/hu.json"'), ""),
            # --- QA finding, card 9dc0fba8 round 1: the same incident written RELATIVELY.
            # The first version resolved relative paths against the GUARD process's cwd, so these
            # landed on a non-existent path whose realpath equals itself -- "no escape", waved
            # through. The tool call's cwd is the authority.
            ("QA repro: relative path + the worktree as payload cwd is blocked",
             blocked("rm apps/web/node_modules/@cleancore/i18n && "
                     f"ln -s {wt}/packages/i18n apps/web/node_modules/@cleancore/i18n", wt), ""),
            ("relative path under a literal `cd` into the worktree is blocked (cd beats payload cwd)",
             blocked(f"cd {wt} && rm apps/web/node_modules/@cleancore/i18n", lab), ""),
            ("relative path after a `cd` to a VARIABLE dir cannot be placed -> case B, blocked",
             blocked('cd "$WT" && rm apps/web/node_modules/@cleancore/i18n', lab), ""),
            ("CONTROL: the same relative write in a REAL node_modules is allowed",
             not blocked("ln -s ../../../packages/i18n apps/web/node_modules/@cleancore/i18n", good), ""),
            ("CONTROL: relative READ in the escaping tree is still allowed",
             not blocked("cat apps/web/node_modules/@cleancore/i18n", wt), ""),
            ("escape hatch honoured",
             not blocked(f"MARVEEN_ALLOW_SYMLINK_NM=1 ln -s {wt}/packages/i18n {wt_link}"), ""),
            ("non-Bash tool ignored",
             subprocess.run([sys.executable, GUARD],
                            input=json.dumps({"tool_name": "Write", "tool_input": {}}),
                            capture_output=True, text=True).returncode == 0, ""),
        ]

        failed = 0
        for name, ok, detail in cases:
            print(("PASS  " if ok else "FAIL  ") + name + (f"   [{detail}]" if detail else ""))
            failed += 0 if ok else 1
        print(f"\n{len(cases) - failed}/{len(cases)} passed")
        return 1 if failed else 0
    finally:
        shutil.rmtree(lab, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
