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


# Inside DOUBLE quotes, bash still expands `$(...)` and backticks -- they are live code, not text.
# Only SINGLE quotes are fully literal.
#
# This used to be the regex `\$\([^)]*\)|`[^`]*``, which stops at the FIRST `)` -- and a regex
# cannot count parentheses, so nesting was never going to work here (card 5bee4b22, QA MEDIUM on
# 9c664b88). Backticks do not nest, so they stay a plain scan; `$( ... )` gets a real walker.


def _close_paren(text, k):
    """Index just past the `)` that closes a `$(` whose body starts at k, or len(text).

    Quoted spans are stepped over rather than counted: a `)` inside `'...'` or `"..."` is literal
    text to bash, so counting it would close the substitution early -- which is the very
    truncation this function exists to stop. An UNTERMINATED substitution returns len(text),
    keeping everything; that direction only ever gives the scanner more to look at.
    """
    depth, n = 1, len(text)
    while k < n:
        c = text[k]
        if c == "\\":
            k += 2
        elif c == "'":
            j = text.find("'", k + 1)
            k = n if j < 0 else j + 1
        elif c == '"':
            j = k + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            k = n if j >= n else j + 1
        elif c == "(":
            depth += 1
            k += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return k + 1
            k += 1
        else:
            k += 1
    return n


def _executable_spans(text):
    """The substrings inside a double-quoted span that bash would still EXECUTE."""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
        elif c == "'":
            j = text.find("'", i + 1)
            i = n if j < 0 else j + 1
        elif c == "`":
            j = text.find("`", i + 1)
            out.append(text[i:] if j < 0 else text[i:j + 1])
            i = n if j < 0 else j + 1
        elif c == "$" and i + 1 < n and text[i + 1] == "(":
            end = _close_paren(text, i + 2)
            out.append(text[i:end])
            i = end
        else:
            i += 1
    return out


def _strip_quoted_literals(cmd):
    """Blank quoted strings, but keep what bash would still EXECUTE inside them.

    QA FAIL on 57bb35a8, and it reopened the guard's whole class through a second mechanism. The
    first version blanked a double-quoted span wholesale, so

        cd /abs && printf "%s" "$(cat relative/file.txt)"

    lost its `$(cat relative/file.txt)` BEFORE _segments() ran -- and since the segmenter splits on
    `$(`, the split point was inside the part that had just been erased. The relative-path read
    vanished from the text and the command passed. The unquoted form of the same line blocked
    correctly, which is the wrong way round: `"$(...)"` is the shape shellcheck and every style
    guide ask for, and it is literally the fleet's own token idiom
    (`"$(cat store/.dashboard-token)"`).

    So: single quotes are erased entirely (nothing in them ever runs); a double-quoted span keeps
    its command substitutions and loses the rest. The quotes themselves stay, so operand counting
    still sees a token where one was.

    NESTING, and a claim of mine that was simply wrong (card 5bee4b22, QA MEDIUM). The earlier
    version of this docstring said nested `$( ... $(...) ...)` "truncates at the first `)`, which
    leaves MORE text than it should, so the guard errs toward blocking -- the safe direction".
    Both halves are false, and measurably so. `findall` keeps the MATCH and discards the rest of
    the quoted span, so truncation loses text, in two different ways:

        cd /abs && printf "%s" "$(cat $(echo relative)/file.txt)"

    kept only `$(cat $(echo relative)`, dropping the `/file.txt` operand -- so `cat` looked like a
    stdin read and passed. And:

        cd /abs && printf "%s" "$(foo $(bar) && cat relative/f)"

    kept `$(foo $(bar)` and dropped `cat relative/f` ENTIRELY -- the read command disappeared from
    the text before anything could look at it. Balanced walking (`_executable_spans`) fixes both.
    """
    def repl(m):
        tok = m.group(0)
        if tok[0] == "'":
            return "''"
        kept = _executable_spans(tok[1:-1])
        return '"' + ' '.join(kept) + '"' if kept else '""'
    return _QUOTED_RX.sub(repl, cmd)


def _unquote(s):
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        return s[1:-1]
    return s


# A word whose operand STARTS with a command substitution -- `cat $(echo rel)/file.txt` -- is split
# by _SEG_SPLIT_RX exactly at the `$(`, so the read command is left holding no operand at all and
# the operand rule reads it as a harmless stdin read. That is how QA's nested case passed even
# after the truncation above was fixed: balanced extraction restores the TEXT, but the segmenter
# still cuts the word in half.
#
# The operand is real; we simply cannot resolve it, and an unresolvable operand is by definition
# not an absolute path -- which is the same thing the permission engine will conclude. So the
# segment inherits a synthetic operand standing for "a path this guard cannot resolve". It carries
# no `/`, so _ABS_PATH_RX still refuses to anchor on it.
_SUBST_OPERAND = "\x00cmdsubst\x00"
_SUBST_OPENERS = ("$(", "`")


def _segments(cmd):
    parts = _SEG_SPLIT_RX.split(cmd)
    delims = _SEG_SPLIT_RX.findall(cmd)
    out, depth, tick = [], 0, False
    for i, part in enumerate(parts):
        if i < len(delims) and delims[i] in _SUBST_OPENERS:
            # Appended with NO separator, so it lands on the WORD the substitution was part of
            # rather than beside it. Measured, and it is the same trap as the previous round: with
            # a space, `cd "$(git rev-parse --show-toplevel)" && grep -rn x .` split into `cd "`
            # plus a loose token, `_CD_RX` (which anchors with `\s*$`) stopped matching, the cd was
            # never recorded, and a real wedge shape went BLOCK -> pass. The quoted spelling is the
            # one shellcheck asks for and the one people actually write, so breaking it to fix the
            # bare spelling would have been a straight downgrade.
            part = part + _SUBST_OPERAND
        out.append((part, depth))
        d = delims[i] if i < len(delims) else None
        if d in ("$(", "<(", ">(", "("):
            depth += 1
        elif d == ")":
            depth = max(0, depth - 1)
        elif d == "`":
            # Backticks are their own closer, so the same delimiter opens and closes by turns.
            tick = not tick
            depth = depth + 1 if tick else max(0, depth - 1)
    return out


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
# ...and these RECURSE WITH NO FLAG AT ALL (Cybersec, card 26863263). `rg foo` walks the CWD; so do
# `ag` and `ack`. They sit in _PATTERN_FIRST, so the operand rule wanted a second operand, and the
# flag-based recursion test found no flag to match -- one operand (the pattern) and they sailed
# through. Measured: `cd /abs && rg foo` was BLOCK on the original guard, PASS from the operand
# rule onwards. Their default IS the recursion, so no flag can be the signal; membership is.
_RECURSES_BY_DEFAULT = {"rg", "ripgrep", "ag", "ack"}
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
    if name in _RECURSES_BY_DEFAULT:
        return True
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
        # A substitution that IS the cd's own target runs BEFORE the cd, so the cd cannot be what
        # its directory resolves against. `ROOT="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"`
        # -- a real line in this repo -- would otherwise read as "cd, then a relative git read",
        # because flat splitting puts that `git rev-parse` right after the cd even though it runs
        # first. Skipping while DEEPER than the cd, and resuming at its own depth, keeps the case
        # that matters: in `cd "$(...)" && grep -rn x .` the grep is back at the cd's depth and is
        # still judged against it.
        skip_below = None
        for seg, depth in segs:
            if skip_below is not None:
                if depth > skip_below:
                    continue
                skip_below = None
            if f"{ALLOW_ENV}=1" in seg:
                # Per simple command, same as noisy-command-guard: naming the hatch elsewhere on
                # the line says nothing about THIS command.
                continue
            m = _CD_RX.match(seg)
            if m:
                cd_target = _unquote(m.group("target"))
                if _SUBST_OPERAND in m.group("target"):
                    skip_below = depth
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
