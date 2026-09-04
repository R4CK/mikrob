#!/usr/bin/env python3
"""Self-test for apply.py.

Run:  python3 store/telegram-buttons-patch/selftest.py
Exit: 0 = all pass, 1 = at least one case wrong, 3 = no upstream copy to test against.

The cases that matter most are the REFUSALS. This script edits the file that carries every
Telegram message the fleet sends; a half-applied or wrongly-applied server.ts costs the whole
channel, which is far worse than the missing button it exists to restore. So: it must refuse when
an anchor has moved, it must write nothing when it refuses, and running it twice must be a no-op.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
APPLY = os.path.join(HERE, "apply.py")
PAYLOAD_MARKERS = [
    "buttons: {",                                  # the tool schema
    "const buttons = (args.buttons",               # the handler parse
    "isLast && keyboard ? { reply_markup:",        # attached to the last chunk only
    "button_data: data,",                          # the inbound tap notification
]

# A pure-upstream server.ts to patch. Any cache copy that does NOT already carry the fork edit
# will do; the test is about the transformation, not about a particular version number.
CANDIDATES = [
    os.path.expanduser("~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7/server.ts"),
    os.path.expanduser("~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram/server.ts"),
]

fails = []


def run(*args):
    p = subprocess.run([sys.executable, APPLY] + list(args), capture_output=True, text=True)
    return p.returncode, (p.stdout + p.stderr)


def check(name, cond, detail=""):
    print(("OK   " if cond else "FAIL ") + name + (("  -- " + detail) if (detail and not cond) else ""))
    if not cond:
        fails.append(name)


def main():
    upstream = next((c for c in CANDIDATES if os.path.exists(c) and "const buttons = (args.buttons"
                     not in open(c, encoding="utf-8").read()), None)
    if not upstream:
        sys.stderr.write("selftest: no un-patched upstream server.ts on this machine to test against\n")
        return 3

    tmp = tempfile.mkdtemp(prefix="tg-buttons-selftest-")
    try:
        target = os.path.join(tmp, "server.ts")
        shutil.copy(upstream, target)
        original = open(target, encoding="utf-8").read()

        rc, out = run("--check", "--path", target)
        check("--check on un-patched upstream reports NOT applied (exit 1)", rc == 1, f"exit={rc} {out}")
        check("--check writes nothing", open(target, encoding="utf-8").read() == original)

        rc, out = run("--path", target)
        check("apply succeeds (exit 0)", rc == 0, f"exit={rc} {out}")
        patched = open(target, encoding="utf-8").read()
        for m in PAYLOAD_MARKERS:
            check(f"applied file contains: {m[:44]}", m in patched)
        check("apply says what it did NOT do (no restart)", "restart" in out.lower())

        rc, out = run("--check", "--path", target)
        check("--check now reports applied (exit 0)", rc == 0, f"exit={rc} {out}")

        rc, out = run("--path", target)
        check("a second apply is a no-op (exit 0, 'already applied')", rc == 0 and "already applied" in out)
        check("a second apply changes nothing", open(target, encoding="utf-8").read() == patched)

        # ANCHOR DRIFT. The point of the exercise: upstream moves, the anchor stops matching, and
        # the script must refuse loudly rather than guess -- and must leave the file alone.
        drift = os.path.join(tmp, "drifted.ts")
        with open(drift, "w", encoding="utf-8") as fh:
            fh.write(original.replace("        const sentIds: number[] = []", "        const sentIds: number[] = [] // upstream moved"))
        before = open(drift, encoding="utf-8").read()
        rc, out = run("--path", drift)
        check("a moved anchor is REFUSED (exit 2)", rc == 2, f"exit={rc} {out}")
        check("the refusal names the hunk", "InlineKeyboard" in out or "buttons" in out, out[:120])
        check("the refusal tells you not to loosen the anchor", "do NOT loosen" in out)
        check("a refused run writes NOTHING", open(drift, encoding="utf-8").read() == before)

        rc, out = run("--path", os.path.join(tmp, "does-not-exist.ts"))
        check("an unreadable target is exit 3, not a crash", rc == 3, f"exit={rc}")

        # The patched file must still be valid TypeScript. Resolution of `grammy` needs the
        # plugin's node_modules, so parse without bundling -- a syntax error still fails here.
        if shutil.which("bun"):
            p = subprocess.run(["bun", "build", target, "--no-bundle", "--outfile", os.path.join(tmp, "o.js")],
                               capture_output=True, text=True)
            check("the patched server.ts still PARSES (bun)", p.returncode == 0, (p.stderr or "")[:200])
        else:
            print("SKIP the parse check -- bun is not on PATH here")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        return 1
    print("All cases passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
