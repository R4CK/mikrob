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

RELATIVE PATHS ARE RESOLVED AGAINST THE CALLER'S cwd, not the guard's (QA finding on card
9dc0fba8, round 1). The first version called os.path.abspath(), which resolves against the GUARD
process's own cwd -- so `cd "$WT" && rm apps/web/node_modules/@cleancore/i18n` (the same incident,
written relatively, and the shape this fleet actually uses) resolved to a path that does not exist,
whose realpath equals itself, and the escape check answered "no escape". The tool call's `cwd` field
is the authority, exactly as npm-protect-guard.py already used it; a leading literal `cd <dir>` in
the command overrides it, and a `cd` to an UNRESOLVABLE target (an unexpanded $VAR) makes every
later relative node_modules path uncheckable -- which is case B, fail closed, not a free pass.

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
# The escape hatch, only in its declared inline form at the start of a statement.
_ALLOW_PREFIX_RX = re.compile(r"(?:^|[\n;&|(])\s*" + ALLOW_ENV + r"=\S+\s+\S")
# A token we cannot resolve statically (still unexpanded at hook time).
_UNRESOLVED_RX = re.compile(r"[$`*?\[]")


# A heredoc BODY is data being written, not commands to judge -- same reading, and the same regex,
# as cd-chain-guard.py's. Only the BODY is removed: the redirect target stays in the text, so a
# write INTO a node_modules is still caught. Without this, prose in a document that merely quotes an
# example command is parsed as that command -- this card's false positive, in its heredoc spelling.
_HEREDOC_RX = re.compile(r"""<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1.*?^\s*\2\s*$""", re.S | re.M)


def strip_heredoc_bodies(command):
    return _HEREDOC_RX.sub(lambda m: "<<" + m.group(2), command)


def statements(command):
    """Split into simple commands, HONOURING QUOTES (card c393bf09).

    `_SPLIT_RX.split()` is blind to quoting, and that produced a false positive I reproduced on
    MYSELF twice while working this card -- once posting a kanban comment, once running the very
    test harness for the fix. Both times the command performed no file operation at all; the text
    merely QUOTED an example:

        python3 -c "post({'content':'... az utvonalban (mkdir -p \"$tmp/node_modules/evil\", ...)'})"

    The `(` inside that quoted prose became a statement boundary, so `mkdir -p "$tmp/node_..."` --
    a fragment of a sentence -- was read as a command. is_mutating saw `mkdir`, path_tokens handed
    back the prose, and the unresolved `$tmp` tripped the fail-closed branch. The reported symptom
    ("the Hungarian prose contained node_modules") is this, and it is why backend2 routed around
    the guard with the Edit tool -- which is worse than the false positive, as their report says.

    Quote-awareness is the whole fix, and it is deliberately NOT a blanket strip of quoted text:
    the real cases depend on quoted PATHS. `cd "$WT/apps/web/node_modules" && rm @cleancore/i18n`
    still splits on its `&&` (outside quotes) and still blocks; `mkdir -p "$tmp/node_modules/evil"`
    is still one statement led by a mutating verb and still blocks. Only separators INSIDE a quoted
    span stop being separators -- which is what bash does, and the same fix cd-chain-guard's
    segmenter needed for the same reason.
    """
    command = strip_heredoc_bodies(command)
    buf = []
    i, n = 0, len(command)
    dq = sq = False
    while i < n:
        c = command[i]
        if c == "\\" and i + 1 < n and not sq:
            buf.append(command[i:i + 2])
            i += 2
            continue
        if c == "'" and not dq:
            sq = not sq
        elif c == '"' and not sq:
            dq = not dq
        if not sq and not dq:
            m = _SPLIT_RX.match(command, i)
            if m:
                part = "".join(buf).strip()
                if part:
                    yield part
                buf = []
                i = m.end()
                continue
        buf.append(c)
        i += 1
    part = "".join(buf).strip()
    if part:
        yield part


# Quoted spans blanked, quotes kept so word positions do not shift. Used for the redirect test
# only: a `>` inside a string is text, not a redirection.
_QUOTED_RX = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"", re.S)


def _blank_quoted(stmt):
    return _QUOTED_RX.sub(lambda m: m.group(0)[0] * 2, stmt)


def is_mutating(stmt):
    """First real word is a writing verb, or the statement redirects into a file.

    The redirect test runs on the statement with QUOTED spans blanked. Without that, an ordinary
    progress line -- `echo "node_modules: symlink -> $MAIN/node_modules (SHARED ...)"` from
    agent-worktree-marveen.sh, a real line in this repo -- counts as a redirect, because the `>` of
    the ASCII arrow `->` is not excluded by the lookbehind. It then reads as a mutating statement
    and the path in the message becomes a write target.

    This was always true; it only became reachable when the splitter stopped cutting such a line
    into fragments at the `(` and `;` inside its quotes (card c393bf09). Measured over the fleet's
    own shell scripts: with the splitter fixed and this not, two real lines went pass -> block.
    """
    if re.search(r"(?<![0-9<>])>{1,2}(?!&)", _blank_quoted(stmt)):
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
    """Every non-flag word, with whether it is still unresolvable.

    It used to yield ONLY words that literally spelled `node_modules/<x>` -- and that was the
    hole Cybered measured (8 shapes, card 9dc0fba8 round 2). The kernel does not read the word,
    it reads the word JOINED TO THE CWD, so `cd "$WT/apps/web/node_modules" && rm @cleancore/i18n`
    never even reached the check: the incriminating component was in the cwd, not in the token.
    Whether a token is about a node_modules is decided AFTER resolution now, not by its spelling.
    """
    try:
        words = shlex.split(stmt, comments=True)
    except ValueError:
        words = stmt.split()
    first = True
    for w in words:
        if w.startswith("-") or _ENV_ASSIGN_RX.match(w):
            continue
        if first:  # the verb itself is not a path
            first = False
            continue
        yield w, bool(_UNRESOLVED_RX.search(w))


# A leading literal `cd <dir>` retargets everything after it. Same shape as npm-protect-guard.py's
# _CD_RX, deliberately: the two guards answer the same "which directory is this really about"
# question and should not drift into two different answers.
# Every directory change, in order -- `cd` AND `pushd`. Taking only the FIRST `cd` was two of
# Cybered's eight bypasses (`cd /tmp && cd $WT && rm ...`, and `pushd $WT && rm ...`).
_CD_RX = re.compile(r"(?:^|[\n;&|(])\s*(?:cd|pushd)\s+([^\s;&|]+)")


def effective_cwd(command, payload_cwd):
    """(cwd, resolvable, mentions_node_modules). Where a relative path in `command` actually lands: the tool call's cwd,
    then EVERY `cd`/`pushd` applied in order. A hop whose target still holds an unexpanded $VAR
    makes everything after it uncheckable -- reported, never guessed at."""
    base = payload_cwd or os.getcwd()
    mentions_nm = _under_node_modules(base)
    for m in _CD_RX.finditer(command):
        target = os.path.expanduser(m.group(1).strip("\"'"))
        mentions_nm = mentions_nm or "node_modules" in target
        if not target or target == "-":
            return base, False, mentions_nm  # `cd -` needs history we do not have
        if _UNRESOLVED_RX.search(target):
            return base, False, mentions_nm
        base = target if os.path.isabs(target) else os.path.join(base, target)
    return base, True, _under_node_modules(base) or mentions_nm


def _under_node_modules(path):
    return "node_modules" in path.split(os.sep)


def escapes(path, cwd):
    """(literal_parent, real_parent) when this write lands somewhere other than where it reads,
    AND a node_modules is involved -- else None.

    Both halves are decided on the RESOLVED path, never on the spelling: `path` is joined to the
    caller's `cwd` first, so a node_modules component hiding in the cwd counts exactly as much as
    one typed in the argument. A bare `.../node_modules` (creating or removing the link itself) is
    legitimate setup and is left alone.
    """
    joined = os.path.normpath(os.path.join(cwd, path.rstrip("/")))
    if os.path.basename(joined) == "node_modules":
        return None
    parent = os.path.dirname(joined)
    real = os.path.realpath(parent)
    if real == parent:
        return None
    if not (_under_node_modules(parent) or _under_node_modules(real)):
        return None
    return (parent, real)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    if payload.get("tool_name") != "Bash":
        sys.exit(0)
    command = (payload.get("tool_input") or {}).get("command") or ""
    # The hatch must be an ENV ASSIGNMENT AT THE FRONT, not the string appearing anywhere: a
    # command that merely mentions the name (a grep under scripts/, then `;` and the write) used to
    # disarm the guard entirely (Cybered B8, measured -- rc=0 and the link gone).
    if not command or _ALLOW_PREFIX_RX.search(command):
        sys.exit(0)

    try:
        # The caller's directory, not this process's (QA finding, card 9dc0fba8): a relative path
        # resolved against the wrong base lands on a path that does not exist, whose realpath
        # equals itself -- which reads as "no escape" and waves the incident straight through.
        cwd, cwd_known, cwd_in_nm = effective_cwd(command, payload.get("cwd"))
        for stmt in statements(command):
            if not is_mutating(stmt):
                continue
            for token, unresolved in path_tokens(stmt):
                # A relative path we cannot place (the command cd-ed somewhere only a variable
                # names) is case B for the same reason an unexpanded path is: unknown destination.
                if not unresolved and not os.path.isabs(token) and not cwd_known:
                    unresolved = True
                if unresolved:
                    # CASE B, deliberately WIDER than in round 1 (my call on Cybered's open
                    # question, card 9dc0fba8): it used to fire only on a package ENTRY, so
                    # `echo x > "$WT/apps/web/node_modules/@cleancore/i18n/package.json"` walked
                    # through -- and that one does not dangle a link, it silently REWRITES a source
                    # file in the shared clone. No error, no red test (the vitest alias reads the
                    # worktree's own copy), visible only in vite dev/build. A silent shared-tree
                    # tamper is worse than an outage, so "cannot check" now means "do not write"
                    # for ANY path under a node_modules, however deep.
                    mentions = "node_modules" in token or (
                        cwd_in_nm and not os.path.isabs(token)
                    )
                    # The BARE link itself stays legitimate setup, exactly as in escapes(): the
                    # gate-worktree scripts create and replace `<tree>/<pkg>/node_modules` all day
                    # and must not need the hatch to do it.
                    if token.rstrip("/").split("/")[-1] == "node_modules":
                        mentions = False
                    if not mentions:
                        continue
                    sys.stderr.write(
                        "BLOCKED: this write targets an entry inside a node_modules by a path "
                        "whose destination cannot be checked (an unexpanded variable, or a "
                        "relative path after a `cd` to a variable directory).\n\n"
                        f"  you typed : {token}\n\n"
                        "Card 9dc0fba8: a gate worktree ran exactly this shape twice. Both times the "
                        "path read local and the write landed in the SHARED clone, because the "
                        "node_modules component was itself a symlink -- once for 38 minutes of "
                        "fleet-wide 'Failed to resolve import @cleancore/i18n'.\n\n"
                        "Do one of these instead:\n"
                        "  * Gate/test worktree: bash store/cc-gate-worktree.sh --agent <you> <card> <sha>\n"
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
                hit = escapes(token, cwd)
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
                    "  * Gate/test worktree: bash store/cc-gate-worktree.sh --agent <you> <card> <sha>\n"
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
