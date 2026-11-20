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
  - MikroB (no sub-agent identity resolves to it) and anything update.sh/
    marveen-land.sh itself runs (matched by name in the Bash command).

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
# Anchored to the START of a (quote-stripped, &&/||/;/|-split) segment, optionally after an
# interpreter (`bash `, `sh `, `.`) and a path prefix -- NOT a bare substring search on the raw
# command. A substring search let a command exempt itself by merely MENTIONING the script name
# anywhere (e.g. a trailing `# update.sh` comment) without actually invoking it (QA FAIL on
# card 0c3b13b5, c42e55cf1/3f97f0a43 Gate-SHA).
EXEMPT_SCRIPT_RX = re.compile(
    r"^(?:(?:bash|sh|\.)\s+)?\S*/?(marveen-land\.sh|update\.sh)\b"
)

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


_COMMENT_START_RX = re.compile(r"(?:^|\s)#")


def _strip_trailing_comment(cmd: str) -> str:
    """Drop a bash `#` comment, found via the neutralized copy (so a quoted '#' is never
    mistaken for one) but sliced from the REAL cmd at the same offset. A trailing comment
    mentioning a filename used to shift _SED_I_RX's naive last-token target extraction onto the
    comment text instead of the real file (found alongside the QA FAIL on card 0c3b13b5 while
    fixing EXEMPT_SCRIPT_RX)."""
    m = _COMMENT_START_RX.search(_neutralize_quotes(cmd))
    return cmd[: m.start()] if m else cmd


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
    no_comment = _strip_trailing_comment(cmd)
    targets: list[str] = []
    for seg in _split_segments(no_comment):
        if EXEMPT_SCRIPT_RX.search(seg):
            continue  # this segment itself runs marveen-land.sh/update.sh -- exempt, not the whole command
        if _SED_I_RX.search(seg):
            t = _sed_i_target(seg)
            if t:
                targets.append(t)
        m = _TEE_RX.search(seg)
        if m:
            targets.append(m.group(1))
        m = _REDIRECT_RX.search(seg)
        if m:
            targets.append(m.group(1))
        m = _GIT_CHECKOUT_RX.search(seg)
        if m:
            targets.append(m.group(1))
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
