#!/usr/bin/env python3
"""PreToolUse hook: protect the shared git checkout from documented footguns.

Multiple agents share one working tree (see the shared-checkout rule). Three git
moves reliably corrupt a shared checkout or a protected branch, and every one of
them has already bitten this fleet at least once:

  1. `git add -A` / `git add .` / `git add --all` -- stages OTHER agents' unrelated
     changes into your commit. The rule is: stage only your own files/hunks.
  2. force-push (`git push --force` / `-f` / `--force-with-lease`) to a protected
     branch (main / develop) -- rewrites shared history.
  3. `git add`-ing the contended lockfile (pnpm-lock.yaml / package-lock.json) --
     MikroB batches dependency changes; agents never touch the lockfile.

This guard parses the Bash command and blocks (exit 2) ONLY on a clear match of
one of the above. It is intentionally conservative:

  - It only inspects Bash tool calls; everything else is allowed.
  - `git add -p` / `git add <specific-path>` -> allowed (the correct pattern).
  - A protected-branch force-push is blocked; a force-push to a private feature
    branch is allowed (that is a legitimate agent workflow).
  - Any parse error -> FAIL-OPEN (exit 0). Never wedge the fleet on a guard bug.
"""
import sys
import re
import json

PROTECTED_BRANCHES = ("main", "master", "develop")
LOCKFILES = ("pnpm-lock.yaml", "package-lock.json", "yarn.lock")

# A git invocation only counts when it sits at a COMMAND boundary (start of the
# command, or right after a shell separator), optionally behind `sudo`/`time`.
# This is what stops the frequent false positive: the literal string "git add -A"
# embedded in a QUOTED argument to another command (a curl -d payload, an echo, a
# log line that documents the rule) is NOT at a boundary, so it is not matched.
# Backtick is deliberately NOT a boundary here -- inside single quotes it is a
# literal char in docs far more often than a real command substitution.
_CMD = r"(?:^|[\n;&|(])\s*(?:sudo\s+)?(?:time\s+)?git\s+"
# `git add` with a stage-everything flag (-A, --all, or a bare `.`).
ADD_ALL_RX = re.compile(_CMD + r"add\b[^\n&|;]*?(?:(?<!\S)-A\b|--all\b|(?<!\S)\.(?:\s|$))")
# `git add` naming a lockfile explicitly.
ADD_LOCK_RX = re.compile(
    _CMD + r"add\b[^\n&|;]*?(?:" + "|".join(re.escape(f) for f in LOCKFILES) + r")"
)
# force-push in any argument order.
FORCE_PUSH_RX = re.compile(_CMD + r"push\b[^\n&|;]*?(?:--force(?:-with-lease)?\b|(?<!\S)-f\b)")


def _pushes_protected(cmd):
    """True only if a force-push EXPLICITLY names a protected branch. We fail
    toward allow: a force-push with no protected-branch token (e.g. to a feature
    branch, or current branch) is permitted -- blocking those would break the
    legitimate agent workflow. Naming main/master/develop in a force-push is the
    unambiguous footgun we stop."""
    m = FORCE_PUSH_RX.search(cmd)
    if not m:
        return False
    seg = cmd[m.start():]
    return any(
        re.search(r"(?<![\w./-])" + re.escape(b) + r"(?:\s|$|:)", seg)
        for b in PROTECTED_BRANCHES
    )


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if (payload.get("tool_name") or "") != "Bash":
        sys.exit(0)

    ti = payload.get("tool_input") or {}
    cmd = ti.get("command") if isinstance(ti, dict) else None
    if not isinstance(cmd, str) or "git" not in cmd:
        sys.exit(0)

    try:
        # `git add -p` is the sanctioned staging path; never block it.
        add_all = ADD_ALL_RX.search(cmd) and not re.search(r"\bgit\s+add\s+-p\b", cmd)
        if add_all:
            sys.stderr.write(
                "GIT-PROTECT-GUARD: `git add -A/./--all` blokkolva -- kozos "
                "checkout-on ez mas agentek valtozasait is stage-eli. Csak a SAJAT "
                "fajljaidat/hunkjaidat add hozza: `git add <path>` vagy `git add -p`."
            )
            sys.exit(2)

        if ADD_LOCK_RX.search(cmd):
            sys.stderr.write(
                "GIT-PROTECT-GUARD: lockfile (pnpm-lock.yaml / package-lock.json) "
                "git add-je blokkolva -- a fuggosegeket MikroB batcheli, agent nem "
                "nyul a lockfile-hoz. Hagyd ki a lockfile-t a commitbol."
            )
            sys.exit(2)

        if _pushes_protected(cmd):
            sys.stderr.write(
                "GIT-PROTECT-GUARD: force-push vedett branchre (main/master/develop) "
                "blokkolva -- ez kozos historiat ir felul. Pushold feature branchre, "
                "vagy nyiss PR-t. Force-push privat feature branchre engedelyezett."
            )
            sys.exit(2)
    except Exception:
        sys.exit(0)  # any guard error -> fail open

    sys.exit(0)


if __name__ == "__main__":
    main()
