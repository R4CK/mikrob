#!/usr/bin/env python3
"""PreToolUse hook: block `cd <dir> && <read/search command>` before the permission engine has to
ask about it, and hand back the cd-free form.

THE MEASURED PROBLEM (cards a1b2a1de + 6b32a478). A `cd` earlier on the line makes the search
directory of a following grep/sed/cat statically unresolvable, so Claude Code's Read() deny rules
cannot be evaluated and the call goes to a permission prompt. In a fleet agent's tmux pane nobody
is there to answer it: the pane sits on "Do you want to proceed?" until MikroB notices and sends a
keystroke by hand. Measured cost: 7 occurrences in this agent alone, then THREE agents wedged
simultaneously in one heartbeat sweep (backend, backend2, backend3), then three more the next day
(cybered, qa2, fron-teddy) -- one of them stuck for 57 minutes on card d6ecb003.

WHY A GUARD AND NOT A REMINDER. The rule "pass an absolute path instead of cd" was written into
this agent's memory FOUR times, by the agent it applies to, and the agent regressed each time. It
is not a knowledge gap: `cd` into the worktree and then work is the natural instinct after creating
one. CLAUDE.md's "structure over discipline" rule (Kodminosegi alapelvek 6.) says to make that
structural where it can be, and this can be.

BLOCK, NOT AUTO-ALLOW. A PreToolUse hook could in principle return an allow decision and skip the
prompt entirely, and that would look like the friendlier fix. It is the wrong one: an allow covers
the WHOLE Bash call, and `cd X && grep ...` is a chain -- allowing it blindly would also allow
whatever else the agent chained after the grep. Blocking costs the agent one retry with a better
command and grants nothing. Same block-and-suggest shape as noisy-command-guard.py,
git-protect-guard.py and npm-protect-guard.py.

SCOPE, DELIBERATELY NARROW. Only READ/SEARCH commands after a cd, and only when that command has no
absolute path of its own to anchor it. `cd X && npm test`, `cd X && git commit`, and
`cd /abs && grep -n x /abs/file` (the engine can resolve that one) are all left alone. The wedge
class is what is measured; widening it to every `cd` would trade a real stall for a fleet-wide
nuisance, and this guard blocks every agent's Bash tool.

ESCAPE HATCHES
- `CD_CHAIN_ALLOW=1 <cmd>`: one-off, greppable, per simple command.
- `CD_CHAIN_GUARD=off` in the environment: disables the guard entirely.

WHAT THIS IS NOT. Like its siblings, a regex over the command STRING: a seatbelt, not a security
boundary. Any guard error FAILS OPEN.
"""
import json
import os
import re
import sys

ALLOW_ENV = "CD_CHAIN_ALLOW"
OFF_ENV = "CD_CHAIN_GUARD"

_ENV_PREFIX = r"(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]*\s+)*"

# Commands whose file arguments the permission engine resolves against the cwd. Kept to the
# FILE-CONTENT readers, which is the class that was measured (grep, sed, cat on the
# cards; the rest are the same operation under different names) plus `find`, a search whose rewrite
# is trivial. Directory/metadata commands -- ls, tree, du, stat, file, wc, sort -- are deliberately
# ABSENT: nobody has measured them wedging, `cd X && ls` is one of the most common things an
# engineer types, and guessing at scope here would trade a real stall for a fleet-wide nuisance
# (CLAUDE.md kodminosegi alapelv 2: nothing speculative). Add one when it is measured, not before.
_READ_CMDS = (
    "grep|egrep|fgrep|rg|ripgrep|ag|ack"
    "|sed|awk|cat|head|tail|diff"
    "|find"
)
# git is handled separately, by SUBCOMMAND: only the reading ones, and only when the call does not
# already carry `git -C <dir>` -- which is the cd-free form this guard points people at.
_GIT_READ_SUB = "log|show|diff|status|grep|blame|ls-files|rev-parse|rev-list|cat-file|describe|branch|remote"

_CD_RX = re.compile(
    r"^\s*" + _ENV_PREFIX + r"cd\s+(?P<target>(?:\"[^\"]*\"|'[^']*'|[^\s;&|]+))\s*$"
)
_READ_RX = re.compile(r"^\s*" + _ENV_PREFIX + r"(?:sudo\s+)?(?:time\s+)?(?P<cmd>" + _READ_CMDS + r")\b")
_GIT_READ_RX = re.compile(
    r"^\s*" + _ENV_PREFIX + r"(?:sudo\s+)?git\s+(?:-[-\w]+(?:=\S+)?\s+)*(?:" + _GIT_READ_SUB + r")\b"
)
# `git -C <dir>` already carries its own directory: it is the answer, not the problem.
_GIT_DASH_C_RX = re.compile(r"\bgit\s+(?:[-\w]+(?:=\S+)?\s+)*-C\s")

_HEREDOC_RX = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1.*?^\s*\2\s*$", re.S | re.M)
# Quoted literals are DATA. Without this, passing the wedge shape as an argument -- a grep pattern,
# an echo, a python -c body that writes the guard's own test cases -- splits on the `&&` and `|`
# INSIDE the quotes and trips the guard on text that is never executed. noisy-command-guard.py
# strips them for exactly this reason (its header records the same incident class); this guard
# shipped without it and blocked its own author writing this fix.
_QUOTED_RX = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"", re.S)

# An absolute path anywhere in the read command anchors it: the engine can resolve THAT, so the
# call does not wedge and this guard has nothing to prevent. Quoted forms count too.
_ABS_PATH_RX = re.compile(r"(?:^|[\s=\"'])(?:/|~/)[^\s\"';&|]*")

# Segment split. `&&`, `||`, `;`, `|`, newline separate simple commands; a nested context starts a
# new one because the outer shell expands it. Kept in the same shape as noisy-command-guard.py's
# splitter so the two guards read alike.
_SEG_SPLIT_RX = re.compile(r"\|\||&&|\$\(|<\(|>\(|[;\n|&()`]")


def _strip_heredoc_bodies(cmd):
    return _HEREDOC_RX.sub("<<HEREDOC-BODY-STRIPPED", cmd)


def _strip_quoted_literals(cmd):
    """Blank out quoted strings, keeping the quotes so operand counting still sees them."""
    return _QUOTED_RX.sub(lambda m: "''" if m.group(0)[0] == "'" else '""', cmd)


def _unquote(s):
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        return s[1:-1]
    return s


def _segments(cmd):
    return _SEG_SPLIT_RX.split(cmd)


# Commands whose FIRST operand is a pattern or a script, not a path: they need a SECOND operand
# before any file is named. `grep "x"` reads stdin; `grep "x" file` reads a file.
_PATTERN_FIRST = {"grep", "egrep", "fgrep", "rg", "ripgrep", "ag", "ack", "sed", "awk"}
# `-e PATTERN` / `-f PATTERNFILE` move the pattern off the operand list, so the first operand is
# already a path.
_PATTERN_FLAG_RX = re.compile(r"(?:^|\s)-[a-zA-Z]*[ef](?:\s|=)")
# Recursive search walks the CWD even with no path given, so it resolves against the cd either
# way -- operand count says nothing there.
#
# `r`/`R` ANYWHERE in the short-flag cluster, not only as its last letter (Cybersec NO-GO on
# 7705585d). The previous form `-[a-zA-Z]*[rR](?:\s|$)` matched `-nr` but NOT `-rn`, and with no
# path operand `grep -rn foo` then fell through the operand rule and PASSED -- reopening the exact
# class this guard exists for, in its most common spelling. Worse, `grep -rn --include="*.ts" foo`
# is literally the shape that wedged the fleet's panes four times. The selftest could not see it
# because every `-rn` case in it carried a trailing `.` operand, so the operand rule rescued them
# and the hole stayed invisible.
#
# SCOPED to commands that can actually recurse. In `sed`/`awk`, `-r` means EXTENDED REGEX, not
# recursion: `sed -nr "s/x/y/p"` reads stdin and walks nothing. The old regex matched its `-nr` and
# blocked it -- a false positive in both directions of this fix, measured by Cybersec. Scoping
# closes the grep hole and removes the sed false positive in one change.
_RECURSION_CAPABLE = {"grep", "egrep", "fgrep", "rg", "ripgrep", "ag", "ack"}
_RECURSIVE_RX = re.compile(r"(?:^|\s)-[a-zA-Z]*[rR][a-zA-Z]*(?:\s|$)|(?:^|\s)--recursive\b")
_OPERAND_RX = re.compile(r"""(?:^|\s)(?!-)("(?:[^"\\]|\\.)*"|'[^']*'|\S+)""")


def _has_path_operand(seg, name):
    """Whether the read command actually NAMES something for the shell to resolve.

    A read command with NO file operand cannot wedge: there is no directory to determine, because
    it is reading stdin. Measured after shipping (card fe06da0c-adjacent, found by the guard
    blocking its own author): `cd X && git merge ... | tail -2`, `cd X && ls | head -5` and
    `cd X && echo hi | cat` were all blocked, and none of them can trigger the permission prompt
    this guard exists to prevent. That over-match is exactly the "fleet-wide nuisance" the scope
    note warns about, so it is fixed where the scope is decided.
    """
    if name in _RECURSION_CAPABLE and _RECURSIVE_RX.search(seg):
        return True
    body = seg.split(None, 1)
    operands = _OPERAND_RX.findall(body[1]) if len(body) > 1 else []
    need = 2 if (name in _PATTERN_FIRST and not _PATTERN_FLAG_RX.search(seg)) else 1
    return len(operands) >= need


def _is_read_segment(seg):
    """The segment reads/searches files, names a path, and has no absolute path to anchor it."""
    if _GIT_DASH_C_RX.search(seg):
        return None
    m = _READ_RX.match(seg)
    if m:
        name = m.group("cmd")
    elif _GIT_READ_RX.match(seg):
        name = "git"
    else:
        return None
    if _ABS_PATH_RX.search(seg):
        return None
    if name != "git" and not _has_path_operand(seg, name):
        return None
    return name


def _suggest(cmd_name, cd_target):
    """The cd-free rewrite, specific to the command that would have wedged.

    Names an ABSOLUTE literal on purpose. A variable (`"$WORKTREE"`) is valid shell but no more
    resolvable to the permission engine than the cd was, so it moves the wedge instead of removing
    it -- the measured working form was always a literal path.
    """
    d = cd_target
    hint = "" if d.startswith("/") else (
        f"\n  (a `{d}` nem abszolut literal -- oldd fel eloszor, es az eredmenyt add at "
        "literalkent; egy valtozo ugyanugy feloldhatatlan a permission-engine-nek, mint a cd volt)"
    )
    if cmd_name in ("grep", "egrep", "fgrep", "rg", "ripgrep", "ag", "ack"):
        return (
            f"  grep -rn \"<minta>\" --include=<glob> {d}\n"
            f"  vagy hasznald a natív Grep toolt (path: {d}) -- ott nincs shell, nincs mit feloldani{hint}"
        )
    if cmd_name == "git":
        return f"  git -C {d} <alparancs> ...{hint}"
    if cmd_name == "find":
        return f"  find {d} ...{hint}"
    return (
        f"  {cmd_name} ... {d}/<fajl>   (a konyvtar a parancs SAJAT argumentumaba megy, nem cd-be){hint}"
    )


def main():
    if (os.environ.get(OFF_ENV) or "").strip().lower() == "off":
        sys.exit(0)

    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if (payload.get("tool_name") or "") != "Bash":
        sys.exit(0)

    ti = payload.get("tool_input") or {}
    raw = ti.get("command") if isinstance(ti, dict) else None
    if not isinstance(raw, str) or not raw.strip():
        sys.exit(0)

    try:
        segs = _segments(_strip_quoted_literals(_strip_heredoc_bodies(raw)))
        cd_target = None
        for seg in segs:
            if f"{ALLOW_ENV}=1" in seg:
                # Per simple command, same as noisy-command-guard: naming the hatch elsewhere on
                # the line says nothing about THIS command.
                continue
            m = _CD_RX.match(seg)
            if m:
                cd_target = _unquote(m.group("target"))
                continue
            if cd_target is None:
                continue
            name = _is_read_segment(seg)
            if name:
                sys.stderr.write(
                    "CD-CHAIN-GUARD: ez a parancs egy `cd` UTAN olvas/keres, relativ utvonallal. "
                    "A permission-engine ilyenkor nem tudja feloldani, melyik konyvtarrol van szo, "
                    "ezert JOVAHAGYAST ker -- egy fleet-agent paneljeben viszont nincs aki "
                    "valaszoljon, es a panel percekre-orakra beragad (merve: 57 perc a d6ecb003-on).\n\n"
                    "Ird at cd nelkul, a konyvtarat a parancs sajat argumentumaba teve:\n"
                    f"{_suggest(name, cd_target)}\n\n"
                    f"Ha tenyleg ez a lancolt alak kell, egyszeri korre: {ALLOW_ENV}=1 <parancs>. "
                    f"A guard teljes kikapcsolasa: {OFF_ENV}=off."
                )
                sys.exit(2)
    except Exception:
        sys.exit(0)  # any guard error -> fail open

    sys.exit(0)


if __name__ == "__main__":
    main()
