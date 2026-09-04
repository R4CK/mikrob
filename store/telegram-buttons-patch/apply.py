#!/usr/bin/env python3
"""Re-apply the fork's `buttons` parameter to the Telegram plugin's server.ts.

WHY THIS FILE EXISTS (card d6be510a, MikroB decision on comment 19268).

The `reply` tool's `buttons` parameter -- Peti's tappable approve/deny keyboard, asked for
2026-08-16 and made mandatory by the root CLAUDE.md unknown-sender pairing flow -- was written
directly into the plugin's `server.ts`. That file lives in a git checkout tracking upstream, and
the edit was never committed anywhere. An upstream pull on 2026-09-01 21:15 discarded it without a
word: the marketplace source and the 0.0.7 cache are now byte-identical pure upstream, with no
`buttons` in either.

It kept working only because the project-scope install stayed pinned to the 0.0.6 cache directory,
which happened to survive. That is luck, not a mechanism, and the root CLAUDE.md update-safety rule
says the same thing in general: a local edit to a tracked file that an update would collide with
must never sit uncommitted.

So the edit lives here, versioned, and gets re-applied after any plugin update. Upstream keeps
flowing -- this is four additive hunks on top of whatever version is installed, not a frozen copy
of the file. Re-applying onto 0.0.7 also GAINS the upstream fixes 0.0.6 never had (CLAUDE_CONFIG_DIR
support in STATE_DIR, and the PID-recycling check before SIGTERM), which is the whole argument for
a patch over a vendored fork of the file.

USAGE
  python3 store/telegram-buttons-patch/apply.py            # apply to the live install
  python3 store/telegram-buttons-patch/apply.py --check    # report only, write nothing
  python3 store/telegram-buttons-patch/apply.py --path F   # target a specific server.ts

EXIT CODES (a contract -- callers switch on these)
  0  applied now, or already applied (idempotent; --check: already applied)
  1  --check only: NOT applied (the feature is missing and the file is patchable)
  2  an anchor is missing or ambiguous -- upstream moved and a human must re-cut this patch
  3  the target file could not be resolved or read

It does NOT restart anything. `bun` loads server.ts once at startup, so the change takes effect on
the next mikrob-channels restart, and that restart is MikroB's call, not this script's.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC_FILE = os.path.join(HERE, "buttons.hunks.json")

# The marker that says the patch is already in: the one line that cannot plausibly appear for any
# other reason. Checked before anything is written, so a second run is a no-op rather than a
# double-insert.
APPLIED_MARKER = "const buttons = (args.buttons"

REGISTRY = os.path.join(os.path.expanduser("~"), ".claude", "plugins", "installed_plugins.json")
PLUGIN_KEY = "telegram@claude-plugins-official"


def resolve_target():
    """The server.ts the running fleet actually loads.

    Read out of the plugin registry rather than guessed from a path, and specifically the
    PROJECT-scope entry -- not whichever version number is highest. `src/__tests__/
    telegram-reply-chatid-contract.test.ts` resolves it the same way, so the applier and the guard
    that checks its work cannot disagree about which file they mean.
    """
    try:
        with open(REGISTRY, encoding="utf-8") as fh:
            entries = json.load(fh).get("plugins", {}).get(PLUGIN_KEY, [])
    except Exception as exc:
        return None, f"cannot read {REGISTRY}: {exc}"
    for e in entries:
        if isinstance(e, dict) and e.get("scope") == "project" and e.get("installPath"):
            p = os.path.join(e["installPath"], "server.ts")
            if os.path.exists(p):
                return p, None
            return None, f"registry names {p}, which does not exist"
    return None, f"no project-scope install of {PLUGIN_KEY} in the registry"


def main():
    args = sys.argv[1:]
    check_only = "--check" in args
    target = None
    if "--path" in args:
        target = args[args.index("--path") + 1]
    else:
        target, err = resolve_target()
        if target is None:
            sys.stderr.write(f"telegram-buttons-patch: {err}\n")
            return 3

    try:
        with open(target, encoding="utf-8") as fh:
            src = fh.read()
        with open(SPEC_FILE, encoding="utf-8") as fh:
            hunks = json.load(fh)
    except Exception as exc:
        sys.stderr.write(f"telegram-buttons-patch: {exc}\n")
        return 3

    if APPLIED_MARKER in src:
        print(f"telegram-buttons-patch: already applied -- {target}")
        return 0

    if check_only:
        print(f"telegram-buttons-patch: NOT applied -- {target}")
        return 1

    # Every anchor is verified BEFORE anything is written. A half-applied server.ts would be worse
    # than an unpatched one: the plugin would fail to parse and the fleet would lose Telegram
    # entirely, which is a much bigger outage than a missing button.
    out = src
    for h in hunks:
        n = out.count(h["anchor"])
        if n != 1:
            sys.stderr.write(
                "telegram-buttons-patch: REFUSING to patch -- the anchor for\n"
                f"  {h['name']}\n"
                f"occurs {n} times in {target}, expected exactly 1.\n\n"
                "Upstream has moved under this patch. Re-cut it against the new server.ts by hand;\n"
                "do NOT loosen the anchor to make this pass. Nothing was written.\n"
            )
            return 2

    for h in hunks:
        out = out.replace(h["anchor"], h["replacement"], 1)

    tmp = target + ".buttons-patch.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(out)
    os.replace(tmp, target)
    print(f"telegram-buttons-patch: applied {len(hunks)} hunk(s) -- {target}")
    print("  NOTE: bun loads server.ts once at startup. This takes effect on the next")
    print("  mikrob-channels restart, which is MikroB's call -- this script starts nothing.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
