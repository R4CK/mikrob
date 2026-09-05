#!/usr/bin/env python3
"""Compact reader for this install's dashboard API (card e96b06e7).

WHY THIS EXISTS. `scripts/noisy-run.sh` filters noisy output by LINE, which does nothing for a JSON
body -- the whole response is one line. So every agent reading the kanban/agents/messages API has
been hand-writing a throwaway `python3 -c` extractor, several times a day, each one slightly
different. Measured while writing this: `GET /api/kanban` returns 242 cards with 18 fields each,
including every full `description`. Raw, that is unreadable; hand-extracted, it is re-invented every
time.

WHAT IT IS NOT. Not an MCP server, not a proxy, no new dependency, no new outbound path -- it talks
to localhost with the token this install already has. That is deliberate: the alternative considered
on card 241dbf87 was a third-party compression layer, and the reason to say no there was that the
value came from a position (in front of every LLM call) nobody should hand out for a convenience.

THE AUTH IS INSIDE ON PURPOSE. The usual incantation is
`printf 'Authorization: Bearer %s\\n' "$(cat store/.dashboard-token)" | curl -H @- ...`, and its
failure mode is silent: `-H @-` consumes stdin, so any request that also pipes a body sends an EMPTY
one and the server answers 200 to nothing. Encapsulating the header removes that whole class for
reads. The token is read from the file and never printed.

TRUNCATION IS ALWAYS MARKED. A shortened field ends in ` ...(+N)`, so a reader can tell "this is all
of it" from "there is more" -- the point of the tool is to be trusted at a glance.

Usage:
  store/dash.py card <id>              one card: status, assignee, labels, description
  store/dash.py comments <id> [n]      last n comments (default 5), author + body
  store/dash.py board [status]         id/status/assignee/title lines, optionally one column
  store/dash.py agents                 which agents exist and which are running
  store/dash.py queue                  pending inter-agent messages: age, sender, first line
  store/dash.py get <path>             any GET, pretty-printed (escape hatch)

  Any subcommand accepts --stdin to format a body you already have instead of fetching:
      curl ... | store/dash.py card --stdin
  which is also how the selftest exercises the formatting without a live server.

Exit: 0 ok | 1 HTTP/parse error | 2 usage
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASE = "http://localhost:3420"
WIDTH = 100


def token_file() -> Path:
    """Where this install keeps the dashboard token.

    Not simply `HERE/.dashboard-token`: the token is gitignored, so it exists only in the MAIN
    checkout -- and every agent runs from its own worktree, where `HERE/store/` has no token. Found
    by running exactly that way: the first live call failed with "no token", from a worktree.

    So: this directory first (the main checkout, and anyone who put one beside the script), then the
    main checkout resolved from git itself. `--git-common-dir` from a worktree points at the main
    repo's `.git`, which makes this portable rather than a hardcoded /home path.
    """
    override = os.environ.get("DASH_TOKEN_FILE")
    if override:
        return Path(override)
    local = HERE / ".dashboard-token"
    if local.exists():
        return local
    try:
        common = subprocess.run(
            ["git", "-C", str(HERE), "rev-parse", "--git-common-dir"],
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout.strip()
    except (subprocess.SubprocessError, OSError):
        return local
    return (Path(common).resolve().parent / "store" / ".dashboard-token")


def die(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(code)


def clip(text: str, width: int = WIDTH) -> str:
    """One line, shortened with an explicit count of what was dropped.

    The count is the point. A bare `...` leaves the reader guessing whether the tail mattered;
    `...(+180)` says how much is missing, which is enough to decide whether to go and read it."""
    flat = " ".join((text or "").split())
    if len(flat) <= width:
        return flat
    return f"{flat[:width]} ...(+{len(flat) - width})"


def fetch(path: str):
    """GET with the install's bearer token. Never prints the token."""
    tf = token_file()
    if not tf.exists():
        die(f"no token at {tf} (set DASH_TOKEN_FILE to override) -- is this a dashboard install?")
    token = tf.read_text().strip()
    req = urllib.request.Request(f"{BASE}{path}", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        # Say the status. "it failed" sends the reader to the wrong place; 401 and 404 mean
        # completely different next steps.
        die(f"HTTP {e.code} for {path}")
    except urllib.error.URLError as e:
        die(f"cannot reach {BASE} ({e.reason}) -- is the dashboard running?")
    except json.JSONDecodeError:
        die(f"{path} did not return JSON")


def ago(ts) -> str:
    try:
        mins = (time.time() - float(ts)) / 60
    except (TypeError, ValueError):
        return "?"
    if mins < 90:
        return f"{mins:.0f}m"
    return f"{mins / 60:.1f}h"



def _blocker(b) -> str:
    """One blocker as `id (status)`, tolerating a bare id string from an older API shape."""
    if isinstance(b, str):
        return b
    if isinstance(b, dict):
        bid = str(b.get("id") or "?")
        st = b.get("status")
        return f"{bid} ({st})" if st else bid
    return str(b)


def show_card(d) -> None:
    print(f"{d.get('id')}  {d.get('status')}  {d.get('assignee') or '(unassigned)'}  "
          f"prio={d.get('priority')}  updated={ago(d.get('updated_at'))} ago")
    labels = ", ".join(l.get("name", "") for l in (d.get("labels") or []))
    if labels:
        print(f"  labels: {labels}")
    if d.get("blocked"):
        # blockedBy is a list of {id, title, status} OBJECTS, not of id strings. The first version
        # joined it directly and raised TypeError on the first card that was actually blocked -- the
        # branch had never been exercised, because writing a dependency edge is rare and every card
        # I built this against was unblocked. Printing the id AND the blocker's status is what the
        # reader needs anyway: "waiting on a card that is still planned" and "waiting on one already
        # in review" are different situations.
        print("  BLOCKED by: " + (", ".join(_blocker(b) for b in (d.get("blockedBy") or []))
                                  or "(unnamed)"))
    print(f"  {d.get('title')}")
    desc = (d.get("description") or "").strip()
    if desc:
        print()
        for line in desc.split("\n"):
            print(f"  {line}")


def show_comments(rows, limit: int) -> None:
    rows = rows[-limit:] if limit else rows
    print(f"{len(rows)} comment(s) shown")
    for c in rows:
        print(f"\n--- {c.get('author')}  {ago(c.get('created_at'))} ago  (id {c.get('id')})")
        for line in (c.get("content") or "").split("\n"):
            print(f"  {line}")


def show_board(rows, status: str | None) -> None:
    if status:
        rows = [r for r in rows if r.get("status") == status]
    rows = sorted(rows, key=lambda r: (r.get("status") or "", r.get("priority") or ""))
    print(f"{len(rows)} card(s)")
    for r in rows:
        print(f"  {r.get('id')}  {(r.get('status') or ''):<12} {(r.get('assignee') or '-'):<12} "
              f"{(r.get('priority') or ''):<7} {clip(r.get('title') or '', 70)}")


def show_agents(rows) -> None:
    print(f"{len(rows)} agent(s)")
    for a in rows:
        state = "RUNNING" if a.get("running") else "stopped"
        print(f"  {(a.get('name') or ''):<14} {state:<8} {a.get('activeModel') or a.get('model') or ''}")


def show_queue(rows) -> None:
    print(f"{len(rows)} pending message(s)")
    by_target: dict[str, int] = {}
    for m in rows:
        by_target[m.get("to_agent") or "?"] = by_target.get(m.get("to_agent") or "?", 0) + 1
    for k, v in sorted(by_target.items(), key=lambda kv: -kv[1]):
        print(f"  {v:>3}  -> {k}")
    for m in rows:
        first = next((l for l in (m.get("content") or "").split("\n") if l.strip()), "")
        print(f"  {ago(m.get('created_at')):>6}  {(m.get('from_agent') or ''):<10} -> "
              f"{(m.get('to_agent') or ''):<10} {clip(first, 60)}")


def main(argv: list[str]) -> int:
    if not argv:
        die(__doc__ or "", 2)
    use_stdin = "--stdin" in argv
    argv = [a for a in argv if a != "--stdin"]
    cmd, rest = argv[0], argv[1:]

    def body(path: str):
        if use_stdin:
            try:
                return json.loads(sys.stdin.read())
            except json.JSONDecodeError:
                die("stdin is not JSON")
        return fetch(path)

    if cmd == "card":
        if not rest and not use_stdin:
            die("usage: dash.py card <id>", 2)
        show_card(body(f"/api/kanban/{rest[0]}" if rest else ""))
    elif cmd == "comments":
        if not rest and not use_stdin:
            die("usage: dash.py comments <id> [n]", 2)
        limit = int(rest[1]) if len(rest) > 1 else 5
        show_comments(body(f"/api/kanban/{rest[0]}/comments" if rest else ""), limit)
    elif cmd == "board":
        show_board(body("/api/kanban"), rest[0] if rest else None)
    elif cmd == "agents":
        show_agents(body("/api/agents"))
    elif cmd == "queue":
        show_queue(body("/api/messages?status=pending"))
    elif cmd == "get":
        if not rest and not use_stdin:
            die("usage: dash.py get <path>", 2)
        print(json.dumps(body(rest[0] if rest else ""), indent=2, ensure_ascii=False))
    else:
        die(f"unknown subcommand '{cmd}'\n{__doc__}", 2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
