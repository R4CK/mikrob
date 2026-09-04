#!/usr/bin/env python3
"""Self-test for cd-chain-guard.py.

Run:  python3 scripts/hooks/cd-chain-guard.selftest.py
Exit: 0 = all pass, 1 = at least one case wrong.

The BLOCK cases are the measured wedge shapes (cards a1b2a1de + 6b32a478, and the seven
occurrences recorded in the backend agent's own memory). The ALLOW cases matter more: this guard
sits in front of every agent's Bash tool, so an over-match trades a real stall for a fleet-wide
nuisance. Every command an engineer plausibly writes with a `cd` in it and no wedge risk is listed
here on purpose.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

GUARD = Path(__file__).with_name("cd-chain-guard.py")

BLOCK = "block"
ALLOW = "allow"


def verdict(cmd, env=None):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}})
    full = dict(os.environ)
    full.update(env or {})
    p = subprocess.run(
        [sys.executable, str(GUARD)], input=payload, capture_output=True, text=True, env=full
    )
    return (BLOCK if p.returncode == 2 else ALLOW), (p.stderr or "").strip()


CASES = [
    # --- the measured wedge shapes -----------------------------------------------------------
    ('cd /home/neon/wt && grep -rn "pattern" --include=*.ts .', BLOCK,
     "the exact --include shape that wedged three agents at once"),
    ('cd /home/neon/wt && grep -n "pattern" src/file.ts', BLOCK,
     "plain single-file grep after cd wedges too (memory: second incident)"),
    ("cd /home/neon/wt && sed -n '1,40p' src/file.ts", BLOCK,
     "sed after cd, named on card a1b2a1de"),
    ("cd /home/neon/wt && cat package.json", BLOCK, "cat after cd"),
    ('cd "$WORKTREE" && grep -rn "x" .', BLOCK,
     "quoted variable target: still wedges, and the message says to resolve it first"),
    ("cd /home/neon/wt && rg 'pattern' src", BLOCK, "ripgrep counts as a search command"),
    ("cd /home/neon/wt && head -20 README.md", BLOCK, "head after cd"),
    ("cd /home/neon/wt && find . -name '*.ts'", BLOCK, "find after cd"),
    ("cd /home/neon/wt; grep -rn x .", BLOCK, "`;` chains the same way `&&` does"),
    ("cd /home/neon/wt && git log --oneline -3", BLOCK,
     "git read subcommand after cd -- the message names `git -C`"),
    ('cd /home/neon/wt && echo hi && grep -rn "x" .', BLOCK,
     "the read command need not be adjacent to the cd"),

    # --- must NOT block ------------------------------------------------------------------------
    ('grep -rn "pattern" --include=*.ts /home/neon/wt', ALLOW,
     "THE REWRITE THIS GUARD ASKS FOR -- blocking it would be a loop"),
    ("git -C /home/neon/wt status", ALLOW, "git -C is the cd-free form, not the problem"),
    ('cd /home/neon/wt && grep -n "x" /home/neon/wt/src/file.ts', ALLOW,
     "an absolute path anchors the read: the engine resolves it, no prompt, nothing to prevent"),
    ("cd /home/neon/wt && npm test", ALLOW, "not a read command -- out of this guard's scope"),
    ("cd /home/neon/wt && git commit -m x", ALLOW, "write subcommand, not a read"),
    ("cd /home/neon/wt && ./build.sh", ALLOW, "arbitrary script, not a read command"),
    ('grep -rn "cd /tmp && cat x" /home/neon/wt', ALLOW,
     "the wedge shape QUOTED AS A PATTERN is data, not a command"),
    ("cd /home/neon/wt", ALLOW, "a bare cd wedges nothing"),
    ('echo "cd x && grep y"', ALLOW, "mentioning the shape in a string is not running it"),
    ("cat /home/neon/wt/README.md", ALLOW, "no cd at all"),
    ('grep -rn "x" .', ALLOW, "a relative grep with no preceding cd is the engine's own business"),

    # --- scope statement: directory/metadata commands are OUT until one is measured -------------
    ("cd /home/neon/wt && ls -la", ALLOW,
     "`ls` after cd is one of the most common things an engineer types and has never been measured "
     "wedging -- guessing it in would be a fleet-wide nuisance for no evidence"),
    ("cd /home/neon/wt && wc -l src/file.ts", ALLOW, "wc: same, out of scope until measured"),
    ("cd /home/neon/wt && du -sh .", ALLOW, "du: metadata, out of scope"),

    # --- ordering: a cd AFTER the read does not make the read ambiguous -------------------------
    ("cat /home/neon/wt/x.txt && cd /home/neon/wt", ALLOW,
     "the read runs first, in a determinable cwd"),

    # --- escape hatches ------------------------------------------------------------------------
    ('cd /home/neon/wt && CD_CHAIN_ALLOW=1 grep -rn "x" .', ALLOW,
     "per-command opt-out, greppable"),
    ('cd /home/neon/wt && grep -rn "x" .', ALLOW,
     "CD_CHAIN_GUARD=off disables the guard entirely"),  # env applied below

    # --- FIELD REGRESSION 1: a read command with NO file operand cannot wedge ------------------
    # Found by the guard blocking its own author minutes after it landed. The right-hand side of a
    # pipe reads stdin: there is no directory to determine, so the permission prompt this guard
    # exists to prevent can never appear. Blocking these is pure nuisance, fleet-wide.
    ("cd /home/neon/wt && git merge origin/develop 2>&1 | tail -2", ALLOW,
     "tail on a PIPE has no file operand -- nothing for the engine to resolve"),
    ("cd /home/neon/wt && ls | head -5", ALLOW, "head on a pipe, same reason"),
    ("cd /home/neon/wt && echo hi | cat", ALLOW, "cat on a pipe, same reason"),
    ("cd /home/neon/wt && wc -l < file", ALLOW, "wc is out of scope anyway"),

    # --- FIELD REGRESSION 2: the wedge shape as an ARGUMENT is data, not a command -------------
    # Quoted literals were not stripped, so `&&` and `|` INSIDE a string split into segments and
    # tripped the guard on text that is never executed. noisy-command-guard.py strips them for
    # exactly this reason; this guard shipped without it.
    ('cd /home/neon/wt && echo "cd /x && grep -rn z ."', ALLOW,
     "a wedge shape inside a double-quoted argument is data"),
    ("cd /home/neon/wt && python3 -c \"print('cd /x && cat y')\"", ALLOW,
     "a wedge shape inside a python -c body is data"),

    # --- the operand rule must not weaken the real cases ---------------------------------------
    ('cd /home/neon/wt && grep -r "x"', BLOCK,
     "recursive with NO path still walks the cwd, so operand count says nothing"),
    ('cd /home/neon/wt && grep -e "x" file.ts', BLOCK,
     "-e moves the pattern off the operand list, so the first operand IS a path"),

    # --- heredoc bodies are data ---------------------------------------------------------------
    ("cat > /tmp/f <<'EOF'\ncd /home/neon/wt && grep -rn x .\nEOF", ALLOW,
     "a wedge shape inside a heredoc body is text being written, not executed"),
]

def main():
    failures = []
    for idx, (cmd, expected, why) in enumerate(CASES):
        # The one case that needs the kill switch is identified by its position, not by its text:
        # the same command string appears as a BLOCK case earlier, and that pair IS the test.
        env = {"CD_CHAIN_GUARD": "off"} if why.startswith("CD_CHAIN_GUARD=off") else {}
        got, stderr = verdict(cmd, env)
        ok = got == expected
        print(f"{'OK  ' if ok else 'FAIL'} {expected:5s} <- {got:5s}  {cmd!r}  ({why})")
        if not ok:
            failures.append((cmd, expected, got, stderr))

    # Non-vacuity for the two BLOCK-message promises: the guard must NAME the rewrite, not just
    # refuse. A guard that blocks without a usable alternative recreates the stall it prevents.
    _, msg = verdict('cd /home/neon/wt && grep -rn "x" --include=*.ts .')
    for needle in ("grep -rn", "/home/neon/wt", "CD_CHAIN_ALLOW=1"):
        if needle not in msg:
            failures.append(("<block message>", f"contains {needle!r}", "missing", msg))
            print(f"FAIL message must name {needle!r}")
    _, gitmsg = verdict("cd /home/neon/wt && git log --oneline")
    if "git -C /home/neon/wt" not in gitmsg:
        failures.append(("<git block message>", "names git -C", "missing", gitmsg))
        print("FAIL git message must name `git -C <dir>`")

    if failures:
        print(f"\n{len(failures)} FAILED")
        for cmd, expected, got, stderr in failures:
            print(f"  {cmd!r}: expected {expected}, got {got}\n    stderr: {stderr[:300]}")
        sys.exit(1)

    print(f"\nAll {len(CASES)} cases + 4 message assertions passed.")
    sys.exit(0)


if __name__ == "__main__":
    main()
