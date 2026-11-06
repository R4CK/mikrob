#!/usr/bin/env python3
"""PreToolUse hook: block a direct sqlite write to the dashboard's auth/approval tables.

Card c1766c6c (7391f09a follow-up): upstream's `db-write-gate.mjs` denies a direct sqlite write to
these tables, but this fork rejected adopting it wholesale (DECISIONS.md, 7391f09a) because it
imports a generalized multi-surface-deny engine (`scheduleSurfaceDeny`/`scheduleSurfaceVariants`)
that this fork's `scripts/self-pace-gate.mjs` has no equivalent of -- porting that engine is its own
refactor, not a drive-by adoption, and that reject reason still stands. This is instead a narrow,
fork-shaped guard, same shape as `git-protect-guard.py` / `npm-protect-guard.py`: it does not try to
cover every table or every write path, only the three security-sensitive ones named by this card.

WHY THESE THREE TABLES: `dashboard_users` (login credentials/password hashes), `auth_sessions`
(live session tokens), `approvals` (the level-2 autonomy approval records) are the dashboard's own
auth/authorization state. The dashboard API already enforces validation, hashing and audit logging
on writes to them; a raw `sqlite3`/`python3 sqlite3` write bypasses all of that -- it can plant a
user, forge a session, or silently approve/deny a pending request with no audit trail. Every other
table in `store/claudeclaw.db` (kanban cards, memories, messages, ...) is explicitly OUT of scope:
widening this guard to the whole database would just be `db-write-gate.mjs`'s rejected engine again,
one table at a time.

SCOPE, deliberately narrow (same philosophy as git-protect-guard.py's docstring):
  - Only fires on a Bash command that invokes `sqlite3` (the CLI) or a `python3`/`python` command
    whose text shows it is using the `sqlite3` module -- not merely a stray mention of a table name.
  - Only fires when the command ALSO names `claudeclaw.db` (the specific protected database) AND
    ALSO names one of the three protected tables AND ALSO contains a write verb (INSERT, UPDATE,
    DELETE, REPLACE -- the four the card lists; DROP/ALTER/TRUNCATE added for the same reason, they
    are strictly more destructive than the four named and there is no legitimate agent reason to run
    any of them against these tables directly either).
  - A pure SELECT (no write verb present) is always allowed, regardless of table or db name.
  - Any parse error -> FAIL-OPEN (exit 0). Never wedge the fleet on a guard bug.

WHAT THIS DOES NOT DO: unlike git-protect-guard.py, this guard does NOT strip heredoc bodies before
scanning. For `sqlite3 store/claudeclaw.db <<'SQL' ... SQL`, the heredoc body IS the live SQL being
executed (not a file being written), so it must be scanned, not exempted. The accepted cost: a
heredoc that writes a DOC or TEST FIXTURE file (not sqlite3's stdin) which happens to quote one of
the blocked verbs next to one of the three table names and `claudeclaw.db` in the same breath would
also false-block. Measured against this guard's own selftest and the existing hook corpus: no such
case exists today, and the fix if one ever appears is the same escape hatch as every sibling guard.

Escape hatch: `DB_WRITE_GUARD_ALLOW=1` prefixed on the command, for a reviewed, deliberate one-off
(e.g. a MikroB-approved manual data fix) -- same `_ALLOW` pattern as the other guards. Full disable:
`DB_WRITE_GUARD=off` in the environment.
"""
import json
import os
import re
import sys

PROTECTED_DB = "claudeclaw.db"
PROTECTED_TABLES = ("dashboard_users", "auth_sessions", "approvals")
WRITE_VERBS = ("INSERT", "UPDATE", "DELETE", "REPLACE", "DROP", "ALTER", "TRUNCATE")

# A `sqlite3` CLI call, or a python interpreter whose command text shows sqlite3-module usage
# (`import sqlite3` or `sqlite3.connect(`). Boundary-anchored the same way git-protect-guard.py
# anchors `git` -- so the literal substring "sqlite3" inside an unrelated quoted payload (a log
# line, a curl body) does not by itself make this a sqlite invocation; it still needs the db name,
# a protected table and a write verb below to actually block.
_SQLITE_CLI_RX = re.compile(r"(?:^|[\n;&|(])\s*(?:sudo\s+)?sqlite3\b")
_PY_SQLITE_RX = re.compile(
    r"(?:^|[\n;&|(])\s*(?:sudo\s+)?python3?\b[^\n]*?(?:import\s+sqlite3|sqlite3\.connect\s*\()"
)

_TABLE_RX = re.compile(r"\b(?:" + "|".join(PROTECTED_TABLES) + r")\b")
_WRITE_VERB_RX = re.compile(r"\b(?:" + "|".join(WRITE_VERBS) + r")\b", re.IGNORECASE)


def _is_sqlite_invocation(cmd: str) -> bool:
    return bool(_SQLITE_CLI_RX.search(cmd) or _PY_SQLITE_RX.search(cmd))


def main():
    if os.environ.get("DB_WRITE_GUARD", "").lower() == "off":
        sys.exit(0)

    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if (payload.get("tool_name") or "") != "Bash":
        sys.exit(0)

    ti = payload.get("tool_input") or {}
    cmd = ti.get("command") if isinstance(ti, dict) else None
    if not isinstance(cmd, str) or not cmd:
        sys.exit(0)

    if "DB_WRITE_GUARD_ALLOW=1" in cmd:
        sys.exit(0)

    try:
        if PROTECTED_DB not in cmd:
            sys.exit(0)
        if not _is_sqlite_invocation(cmd):
            sys.exit(0)

        table_match = _TABLE_RX.search(cmd)
        if not table_match:
            sys.exit(0)

        if not _WRITE_VERB_RX.search(cmd):
            # No write verb at all -- a SELECT (or any other read-only statement) is allowed.
            sys.exit(0)

        sys.stderr.write(
            "DB-WRITE-GUARD: direct sqlite write to a protected table "
            f"('{table_match.group(0)}' in {PROTECTED_DB}) blocked -- dashboard_users/auth_sessions/"
            "approvals carry auth/session/approval state the dashboard API hashes, validates and "
            "audit-logs on write; a raw sqlite3/python3 write bypasses all of that. Use the dashboard "
            "API instead. Reviewed one-off: prefix the command with DB_WRITE_GUARD_ALLOW=1."
        )
        sys.exit(2)
    except Exception:
        sys.exit(0)  # any guard error -> fail open


if __name__ == "__main__":
    main()
