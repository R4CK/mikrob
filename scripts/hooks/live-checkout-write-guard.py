#!/usr/bin/env python3
"""PreToolUse hook: stop a sub-agent from writing a TRACKED file inside the live
checkout /home/neon/marveen (card 0c3b13b5).

THE INCIDENTS (2026-11-20, rule 6 -- structural protection instead of discipline):
  11:55 backend edited scripts/hooks/agent-key-secret-guard.py (+selftest) directly
        in the live checkout instead of its own worktree (card 52114c2f).
  ~12:24 backend3 edited store/fleet-test.sh directly in the live checkout (card
        fc1bb414) WHILE four fleet-test.sh runs were executing that very file, and
        the edit also blocked Peti's approved update.sh (approval 4a91bbac).

Every fleet agent is supposed to work in its own worktree
(/home/neon/marveen-agent-worktrees/<agent>, store/agent-worktree-marveen.sh) and land
through store/marveen-land.sh -- see the shared-checkout-safe-commit skill. Both
incidents were a sub-agent's ordinary Edit/Write tool call landing on the live
checkout path instead, because nothing enforced the worktree boundary; a point-in-time
reminder in a skill is not that enforcement.

WHAT THIS BLOCKS: an Edit/Write/MultiEdit/NotebookEdit tool call, or the obvious Bash
forms (sed -i, tee, a shell redirect, `git checkout -- <file>`), that targets a file
GIT TRACKS inside the live checkout, when the caller is a sub-agent (not MikroB).

WHAT STAYS ALLOWED:
  - the identical write inside an agent worktree (anywhere NOT under the live
    checkout root) -- that is the whole point, the deny message names it;
  - an UNTRACKED path inside the live checkout (store/*.json runtime state, logs,
    a brand new file nothing has committed yet);
  - anything under the calling agent's own agents/<agent>/ directory -- that tree is
    the agent's own turf, not the shared one these incidents were about;
  - MikroB (no sub-agent identity resolves to it); a plain invocation of update.sh/
    marveen-land.sh itself is never flagged because it contains no sed/tee/redirect/
    `git checkout --` operator -- NOT because the script's name is special-cased (a
    by-name exemption was tried and dropped, CYBERSEC NO-GO 34780 N3: it let an
    invocation's OWN output-redirect smuggle a write to a different tracked file past
    the guard, e.g. `bash update.sh > <live>/store/fleet-test.sh`).

Self-identity: MARVEEN_AGENT_ID / CLAUDE_AGENT_ID env (same precedence as
bash-egress-guard.py / agent-key-secret-guard.py), falling back to a
".../agents/<name>(/|$)" match in the tool call's cwd. If self cannot be resolved at
all, this FAILS OPEN -- same convention as every guard in this directory, so an
operator/MikroB session is never blocked by a guard that cannot tell who it is.

ESCAPE HATCH: MARVEEN_ALLOW_LIVE_EDIT=1 (Bash: inline in the command; Edit/Write/
NotebookEdit: set in the environment for that call).
Kill switch: LIVE_CHECKOUT_WRITE_GUARD=off.

WHAT THIS IS NOT (seatbelt, not a kernel-enforced control -- same framing as
npm-protect-guard.py / git-protect-guard.py / agent-key-secret-guard.py): the Bash
regexes catch the obvious shapes, not every way to mutate a file from a shell (a
written-then-run script, a here-doc fed to `python3 -c`, an editor macro). Any guard
error FAILS OPEN; a guard bug must never stop the fleet.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

ALLOW_ENV = "MARVEEN_ALLOW_LIVE_EDIT"
KILL_ENV = "LIVE_CHECKOUT_WRITE_GUARD"

EXEMPT_AGENTS = {"mikrob"}

_AGENT_ID_RX = r"[a-z][a-z0-9-]{0,31}"
_CWD_AGENT_RX = re.compile(r"(?:^|/)agents/(" + _AGENT_ID_RX + r")(?:/|$)")

_QUOTED_RX = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"", re.S)
_SEGMENT_SPLIT_RX = re.compile(r"&&|\|\||[;|]")

_SED_I_RX = re.compile(r"\bsed\b.*\s-\w*i\w*\b")
# Target group accepts a quoted string OR a bare word -- CYBERSEC F2 (card 0c3b13b5): the old
# code ran these against a copy where every quoted span had been BLANKED to '' / "" before
# extraction, so a quoted redirect/tee target (the exact thing an agent would naturally write,
# `echo x > "/home/neon/marveen/store/fleet-test.sh"`) collapsed to an empty target and was
# never checked at all (silent ALLOW). These now run against the REAL segment text instead.
_QUOTED_OR_WORD = r"'[^']*'|\"(?:\\.|[^\"\\])*\"|\S+"
_TEE_RX = re.compile(r"\btee\b\s+(?:-a\s+)?(" + _QUOTED_OR_WORD + r")")
_REDIRECT_RX = re.compile(r">{1,2}\s*(" + _QUOTED_OR_WORD + r")")
_GIT_CHECKOUT_RX = re.compile(r"\bgit\s+checkout\b[^\n]*--\s+(" + _QUOTED_OR_WORD + r")")


def _live_root() -> Path:
    return Path(os.environ.get("MARVEEN_MAIN") or "/home/neon/marveen").resolve()


def _worktree_root() -> Path:
    return Path(os.environ.get("MARVEEN_WORKTREES") or "/home/neon/marveen-agent-worktrees")


def _self_agent(cwd: str | None) -> str | None:
    agent = os.environ.get("MARVEEN_AGENT_ID") or os.environ.get("CLAUDE_AGENT_ID")
    if agent:
        return agent.strip().lower()
    m = _CWD_AGENT_RX.search(cwd or "")
    if m:
        return m.group(1)
    return None


def _neutralize_quotes(cmd: str) -> str:
    """SAME-LENGTH placeholder for quoted spans (interior -> 'x', quote chars kept), used ONLY
    to find segment/comment boundaries without a `;`/`&&`/`#` INSIDE a quoted string being
    mistaken for a real one. Because it is length-preserving, the offsets found in it slice
    correctly into the ORIGINAL (still-quoted) cmd text -- unlike the old blank-to-'' approach,
    which also destroyed quoted TARGETS for every regex that ran after it (CYBERSEC F2)."""
    return _QUOTED_RX.sub(lambda m: m.group(0)[0] + "x" * (len(m.group(0)) - 2) + m.group(0)[-1], cmd)


_COMMENT_START_RX = re.compile(r"(?:^|(?<=\s))#")


def _strip_trailing_comment(cmd: str) -> str:
    """Drop each bash `#` comment, found via the neutralized copy (so a quoted '#' is never
    mistaken for one) but sliced from the REAL cmd at the same offsets -- up to the END OF ITS
    OWN LINE only, not to the end of the whole string. CYBERSEC NO-GO 34780 (card 0c3b13b5,
    regression on the prior fix): stripping to end-of-string meant a comment line BEFORE a
    write in a multi-line command (the normal shape of an agent Bash call) hid the write
    entirely -- `# note\nsed -i ... <live-file>` went from BLOCK to ALLOW.

    CYBERSEC NO-GO (card 0c3b13b5, round 4): the first per-line fix matched the comment start
    with a CONSUMING `\\s` (`(?:^|\\s)#`), so `m.start()` landed on the NEWLINE BEFORE a `#` that
    is not on line 1 -- `neutral.find("\\n", start)` then immediately found that SAME newline
    (search begins at `start`, and `neutral[start]` IS that newline), so `end == start` and the
    loop never advanced: an infinite loop on any comment not on the first line (hook timeout,
    which under the fleet's fail-closed wrapper denies every such Bash call). Fixed with a
    zero-width lookbehind instead of a consuming `\\s`, so `m.start()` is always the `#` itself
    (never the preceding whitespace) -- `find("\\n", start)` then starts one position AFTER that
    whitespace and is guaranteed to return either -1 or an index > start, so `end > start`
    strictly and `search_from` strictly increases every iteration. The `end <= search_from`
    check below is a defensive progress guard on top of that guarantee, not reachable today."""
    neutral = _neutralize_quotes(cmd)
    n = len(neutral)
    out: list[str] = []
    pos = 0
    search_from = 0
    while search_from <= n:
        m = _COMMENT_START_RX.search(neutral, search_from)
        if not m:
            break
        start = m.start()
        nl = neutral.find("\n", start)
        end = nl if nl != -1 else n
        if end <= search_from:
            break  # no forward progress possible -- should be unreachable, see docstring
        out.append(cmd[pos:start])
        pos = end
        search_from = end
    out.append(cmd[pos:])
    return "".join(out)


def _split_segments(cmd: str) -> list[str]:
    """Split on &&/||/;/| OUTSIDE quotes, found via the neutralized copy but sliced from the
    REAL cmd at the same offsets (same reasoning as _strip_trailing_comment)."""
    neutral = _neutralize_quotes(cmd)
    segments: list[str] = []
    pos = 0
    for m in _SEGMENT_SPLIT_RX.finditer(neutral):
        segments.append(cmd[pos:m.start()])
        pos = m.end()
    segments.append(cmd[pos:])
    return [s.strip() for s in segments if s.strip()]


def _is_tracked(root: Path, rel: str) -> bool:
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files", "--error-unmatch", "--", rel],
            capture_output=True, timeout=5,
        )
        return out.returncode == 0
    except Exception:
        return False


def _resolve(path: str, cwd: str) -> Path:
    p = Path(path)
    if not p.is_absolute():
        p = Path(cwd) / p
    return Path(os.path.normpath(str(p)))


def _check_path(path: str, cwd: str, agent: str | None, root: Path) -> str | None:
    """Returns the repo-relative path IF this write should be denied, else None."""
    p = _resolve(path, cwd)
    try:
        rel = p.relative_to(root)
    except ValueError:
        return None  # not under the live checkout at all -> fine (a worktree, /tmp, ...)
    rel_str = str(rel)
    if agent and rel_str.startswith(f"agents/{agent}/"):
        return None  # the agent's own turf
    if not _is_tracked(root, rel_str):
        return None  # untracked runtime path (store/*.json, logs, a brand new file)
    return rel_str


def _file_target(payload: dict) -> str | None:
    ti = payload.get("tool_input")
    if not isinstance(ti, dict):
        return None
    fp = ti.get("file_path") or ti.get("notebook_path")
    return fp if isinstance(fp, str) and fp else None


def _sed_i_target(seg: str) -> str | None:
    try:
        toks = [t for t in shlex.split(seg, posix=True) if t]
    except ValueError:
        toks = [t for t in seg.split() if t]  # unbalanced quotes -> best-effort fallback
    toks = [t for t in toks if not t.startswith("-")]
    return toks[-1] if len(toks) >= 2 else None  # toks[0] is "sed" itself


def _bash_targets(cmd: str) -> list[str]:
    """CYBERSEC NO-GO 34780 N2+N3 (card 0c3b13b5): every match is LOCATED in the neutralized
    (quote-blind) copy of the segment, so a `>`/`#`/etc INSIDE a quoted string is never mistaken
    for a real operator -- but the TARGET substring is sliced out of the REAL segment text at
    that same offset, so a quoted target is not re-blinded by the search itself. An exempt
    segment (one that itself invokes marveen-land.sh/update.sh) still has its OWN redirect/tee/
    sed/checkout targets checked: `bash update.sh > <live>/store/fleet-test.sh` must not use the
    exempt invocation to smuggle a write to a DIFFERENT tracked file past the guard."""
    no_comment = _strip_trailing_comment(cmd)
    targets: list[str] = []
    for seg in _split_segments(no_comment):
        neutral_seg = _neutralize_quotes(seg)
        if _SED_I_RX.search(neutral_seg):
            t = _sed_i_target(seg)
            if t:
                targets.append(t)
        m = _TEE_RX.search(neutral_seg)
        if m:
            targets.append(seg[m.start(1):m.end(1)])
        m = _REDIRECT_RX.search(neutral_seg)
        if m:
            targets.append(seg[m.start(1):m.end(1)])
        m = _GIT_CHECKOUT_RX.search(neutral_seg)
        if m:
            targets.append(seg[m.start(1):m.end(1)])
    return [t.strip("'\"") for t in targets if t and t.strip("'\"") not in ("/dev/null", "")]


def _deny(rel: str, agent: str | None) -> None:
    who = agent or "<ismeretlen ugynok>"
    worktree_path = _worktree_root() / who / rel
    sys.stderr.write(
        "LIVE-CHECKOUT-WRITE-GUARD: ez a hivas a KOZOS, eles checkout "
        f"({_live_root()}) egy GIT-KOVETETT fajljat ({rel}) irna, nem a sajat "
        "worktree-det. Ket incidens 2026-11-20-an (52114c2f, fc1bb414) pont ez volt -- "
        "a masodik egy futo fleet-test.sh-t es Peti jovahagyott update.sh-jat is "
        "blokkolta. A sajat worktree-d (ha meg nincs: "
        "store/agent-worktree-marveen.sh <ugynokneved>):\n"
        f"  {worktree_path}\n"
        f"Landolas onnan: store/marveen-land.sh <ugynokneved>. Ha ez tenyleg szandekos "
        f"(provisioning/operator-muvelet): {ALLOW_ENV}=1 <parancs>.\n"
    )
    sys.exit(2)


def main() -> None:
    if (os.environ.get(KILL_ENV) or "").lower() in ("off", "0", "false"):
        sys.exit(0)
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool = payload.get("tool_name") or ""
    if tool not in ("Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"):
        sys.exit(0)

    cwd = payload.get("cwd") or os.getcwd()

    try:
        agent = _self_agent(cwd)
        if not agent or agent in EXEMPT_AGENTS:
            sys.exit(0)  # cannot determine self, or it's MikroB -> fail open

        if tool != "Bash" and (os.environ.get(ALLOW_ENV) or "") == "1":
            sys.exit(0)

        root = _live_root()

        if tool == "Bash":
            ti = payload.get("tool_input") or {}
            raw = ti.get("command") if isinstance(ti, dict) else None
            if not isinstance(raw, str):
                sys.exit(0)
            if f"{ALLOW_ENV}=1" in raw:
                sys.exit(0)
            for cand in _bash_targets(raw):
                rel = _check_path(cand, cwd, agent, root)
                if rel is not None:
                    _deny(rel, agent)
            sys.exit(0)

        # Edit / Write / MultiEdit / NotebookEdit
        path = _file_target(payload)
        if not path:
            sys.exit(0)
        rel = _check_path(path, cwd, agent, root)
        if rel is not None:
            _deny(rel, agent)
    except SystemExit:
        raise
    except Exception:
        sys.exit(0)  # any guard error -> fail open

    sys.exit(0)


if __name__ == "__main__":
    main()
