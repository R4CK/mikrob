#!/usr/bin/env python3
"""PreToolUse hook: refuse a write whose node_modules path traverses a symlink (card 9dc0fba8).

THE INCIDENT (2026-09-02, 11:11-11:49 local, ~38 minutes of fleet-wide breakage). A QA gate
worktree was set up the usual way -- a detached worktree, then one DIRECTORY symlink per workspace
dir pointing at the shared clone:

    ln -s "$CC_MAIN/apps/web/node_modules" "$WT/apps/web/node_modules"

Then, to make the worktree's tests read the worktree's OWN i18n package, the gate ran what looks
like a purely local repair:

    rm    "$WT/apps/web/node_modules/@cleancore/i18n"
    ln -s "$WT/packages/i18n" "$WT/apps/web/node_modules/@cleancore/i18n"

Both paths start with "$WT". Neither names the shared clone. But `apps/web/node_modules` IS the
symlink, so the kernel resolved both operations inside $CC_MAIN and the two commands rewrote the
SHARED clone's link from its relative form to an absolute path into the worktree. Twenty minutes
later `git worktree remove` deleted that worktree, the shared link dangled, and every agent's vite/
vitest answered "Failed to resolve import @cleancore/i18n" until it was restored by hand.

WHAT THIS BLOCKS
A mutating statement (rm / ln / mv / cp / touch / mkdir / chmod / chown / tee / sed -i / install, or
a `>` redirect) whose target names something INSIDE a node_modules, in either of two cases:

  A. the path resolves, and its parent lands somewhere other than the literal path says -- the
     incident above, reported with both paths so the surprise is visible; or
  B. the path still holds an unexpanded variable ($WT/apps/web/node_modules/@cleancore/i18n) and
     names a package entry, so where it lands CANNOT be checked. Fail closed on the ambiguity.

Case B is not hypothetical: the same gate repeated the same two commands 32 minutes later with
"$WT/..." instead of the expanded path, which is why the shared link had to be repaired twice.
A write that resolves and stays local is NOT blocked -- an agent with a real node_modules of its
own is doing the right thing.

WHY NOT "no installs in a worktree" (npm-protect-guard.py's rule)
That guard already covers the installer verbs and `rm -rf node_modules`, and it would not have
fired here: `rm <one file>` and `ln -s` are not installers. The property that actually matters is
not WHICH command runs, it is whether the path the agent typed is the path the kernel writes to.

WHY NOT chmod / read-only bind mounts
A symlink carries no useful mode of its own on Linux (chmod follows it), so "chmod the link" is a
no-op. Making the shared node_modules read-only would also block the legitimate installs the main
clone must keep doing. Refusing the escaping WRITE is the narrow control; the broad ones are not.

NOT A SECURITY BOUNDARY. Like its siblings this inspects the command STRING: it does not survive
variable indirection ($d/node_modules where d is computed at runtime), a script written to a file
and then executed, or nested wrappers. It is a seatbelt against the exact tired-agent mistake above.
Any guard error FAILS OPEN -- wedging the fleet on a guard bug would be worse than the footgun.

ESCAPE HATCH: `MARVEEN_ALLOW_SYMLINK_NM=1 <command>`, inline, deliberately greppable.
"""
import json
import os
import re
import shlex
import sys

ALLOW_ENV = "MARVEEN_ALLOW_SYMLINK_NM"

# Statement separators. `|` is included so a piped stage is judged on its own verb.
_SPLIT_RX = re.compile(r"(?:\|\||&&|[;\n|&()])")

# Verbs that write. `git`, `grep`, `ls`, `cat`, `find`, `npx`, `node`, `python3` are deliberately
# absent: reading through a symlinked node_modules is normal and must stay unblocked.
_MUTATING = {
    "rm", "ln", "mv", "cp", "touch", "mkdir", "rmdir", "chmod", "chown",
    "tee", "dd", "install", "unlink", "truncate", "rsync",
}

_ENV_ASSIGN_RX = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
# A token we cannot resolve statically (still unexpanded at hook time).
_UNRESOLVED_RX = re.compile(r"[$`*?\[]")


def statements(command):
    for part in _SPLIT_RX.split(command):
        part = part.strip()
        if part:
            yield part


def is_mutating(stmt):
    """First real word is a writing verb, or the statement redirects into a file."""
    if re.search(r"(?<![0-9<>])>{1,2}(?!&)", stmt):
        return True
    try:
        words = shlex.split(stmt, comments=True)
    except ValueError:
        words = stmt.split()
    for w in words:
        if _ENV_ASSIGN_RX.match(w) or w in ("sudo", "time", "command", "exec", "nohup"):
            continue
        base = os.path.basename(w)
        if base == "sed":
            return "-i" in words or any(x.startswith("-i") for x in words)
        return base in _MUTATING
    return False


def path_tokens(stmt):
    try:
        words = shlex.split(stmt, comments=True)
    except ValueError:
        words = stmt.split()
    for w in words:
        if w.startswith("-"):
            continue
        # A node_modules COMPONENT with something after it: `.../node_modules/@scope/pkg`.
        # A bare `.../node_modules` (removing or creating the link itself) is legitimate setup.
        if not re.search(r"(?:^|/)node_modules/[^/]", w):
            continue
        yield w, bool(_UNRESOLVED_RX.search(w))


def escapes(path):
    """(literal_parent, real_parent) when the parent directory resolves elsewhere, else None."""
    parent = os.path.dirname(os.path.abspath(path.rstrip("/")))
    real = os.path.realpath(parent)
    return None if real == parent else (parent, real)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    if payload.get("tool_name") != "Bash":
        sys.exit(0)
    command = (payload.get("tool_input") or {}).get("command") or ""
    if not command or ALLOW_ENV in command:
        sys.exit(0)

    try:
        for stmt in statements(command):
            if not is_mutating(stmt):
                continue
            for token, unresolved in path_tokens(stmt):
                if unresolved:
                    # Case B: cannot be checked, so it is not allowed. Only a PACKAGE ENTRY
                    # (node_modules/pkg or node_modules/@scope/pkg) counts -- a deeper path into a
                    # package's own files, or the bare link itself, is not this failure's shape.
                    if not re.search(r"(?:^|/)node_modules/(?:@[^/\s]+/)?[^/\s]+/?$", token):
                        continue
                    sys.stderr.write(
                        "BLOCKED: this write targets an entry inside a node_modules through an "
                        "unexpanded variable, so where it actually lands cannot be checked.\n\n"
                        f"  you typed : {token}\n\n"
                        "Card 9dc0fba8: a gate worktree ran exactly this shape twice. Both times the "
                        "path read local and the write landed in the SHARED clone, because the "
                        "node_modules component was itself a symlink -- once for 38 minutes of "
                        "fleet-wide 'Failed to resolve import @cleancore/i18n'.\n\n"
                        "Do one of these instead:\n"
                        "  * Gate/test worktree: bash store/cc-gate-worktree.sh <card> <sha>\n"
                        "    It gives the worktree a REAL node_modules (per-entry symlinks) and its "
                        "own\n    @cleancore/* pointing at the worktree's packages, so this write "
                        "stays local.\n"
                        "  * Need a package to resolve to the worktree's source in tests? Use the "
                        "vitest\n    alias (apps/web/vitest.config.ts already does this for "
                        "@cleancore/i18n).\n"
                        "  * Repairing a link in the MAIN clone: bash store/agent-worktree.sh "
                        "--check-links\n\n"
                        f"Deliberate one-off: prefix the command with {ALLOW_ENV}=1\n"
                    )
                    sys.exit(2)
                hit = escapes(token)
                if not hit:
                    continue
                literal, real = hit
                sys.stderr.write(
                    "BLOCKED: this write's node_modules path traverses a symlink, so it would land "
                    "somewhere other than where the path says.\n\n"
                    f"  you typed : {token}\n"
                    f"  parent    : {literal}\n"
                    f"  REALLY is : {real}\n\n"
                    "That is card 9dc0fba8's incident exactly: a gate worktree repointed what looked "
                    "like its own @cleancore/i18n link and rewrote the SHARED clone's link instead, "
                    "breaking every agent's vite/vitest for 38 minutes.\n\n"
                    "Do one of these instead:\n"
                    "  * Gate/test worktree: bash store/cc-gate-worktree.sh <card> <sha>\n"
                    "    It gives the worktree a REAL node_modules (per-entry symlinks) and its own\n"
                    "    @cleancore/* pointing at the worktree's packages, so this write stays local.\n"
                    "  * Need a package to resolve to the worktree's source in tests? Use the vitest\n"
                    "    alias (apps/web/vitest.config.ts already does this for @cleancore/i18n).\n"
                    "  * Installing on purpose in the MAIN clone: run it there, not through a link.\n\n"
                    f"Deliberate one-off: prefix the command with {ALLOW_ENV}=1\n"
                )
                sys.exit(2)
    except Exception:
        sys.exit(0)  # any guard error -> fail open
    sys.exit(0)


if __name__ == "__main__":
    main()
