#!/usr/bin/env python3
"""Self-test for db-write-guard.py (card c1766c6c).

Run:  python3 scripts/hooks/db-write-guard.selftest.py
Exit: 0 = all pass, 1 = at least one case wrong.
"""
import json
import subprocess
import sys
from pathlib import Path

GUARD = str(Path(__file__).with_name("db-write-guard.py"))

BLOCK = "block"
ALLOW = "allow"

CASES = [
    # ---- Kesz-ha point 1: a write to a protected table via sqlite3 CLI, blocked ----
    (BLOCK, 'sqlite3 store/claudeclaw.db "INSERT INTO dashboard_users (id) VALUES (1)"'),
    (BLOCK, 'sqlite3 store/claudeclaw.db "UPDATE auth_sessions SET expires_at=0"'),
    (BLOCK, 'sqlite3 store/claudeclaw.db "DELETE FROM approvals WHERE id=1"'),
    (BLOCK, 'sqlite3 store/claudeclaw.db "REPLACE INTO dashboard_users (id) VALUES (1)"'),
    (BLOCK, "sqlite3 /home/neon/marveen/store/claudeclaw.db 'insert into auth_sessions values (1)'"),  # case-insensitive verb
    (BLOCK, "sqlite3 store/claudeclaw.db <<'SQL'\nINSERT INTO approvals (id) VALUES (1);\nSQL"),  # heredoc body is live SQL
    (BLOCK, "sqlite3 store/claudeclaw.db 'DROP TABLE dashboard_users'"),
    (BLOCK, "sudo sqlite3 store/claudeclaw.db 'UPDATE approvals SET status=1'"),

    # ---- the python3 -c sqlite3 variant (Kesz-ha point 1, "plus a python3 -c sqlite3 variant") ----
    (
        BLOCK,
        "python3 -c \"import sqlite3; c=sqlite3.connect('store/claudeclaw.db'); "
        "c.execute(\\\"INSERT INTO dashboard_users (id) VALUES (1)\\\")\"",
    ),
    (
        BLOCK,
        "python3 -c \"import sqlite3; db=sqlite3.connect('store/claudeclaw.db'); "
        "db.execute(\\\"DELETE FROM auth_sessions\\\")\"",
    ),

    # ---- Kesz-ha point 2: a read-only SELECT on the same tables/db still passes ----
    (ALLOW, 'sqlite3 store/claudeclaw.db "SELECT * FROM dashboard_users"'),
    (ALLOW, 'sqlite3 store/claudeclaw.db "SELECT id FROM auth_sessions WHERE id=1"'),
    (ALLOW, 'sqlite3 store/claudeclaw.db "select * from approvals"'),
    (
        ALLOW,
        "python3 -c \"import sqlite3; c=sqlite3.connect('store/claudeclaw.db'); "
        "print(c.execute('SELECT * FROM dashboard_users').fetchall())\"",
    ),

    # ---- not this guard's business at all ----
    (ALLOW, "sqlite3 store/claudeclaw.db 'INSERT INTO kanban_cards (id) VALUES (1)'"),  # not a protected table
    (ALLOW, "sqlite3 /tmp/other.db 'INSERT INTO dashboard_users (id) VALUES (1)'"),  # not the protected db
    (ALLOW, "echo 'INSERT INTO dashboard_users' > note.txt"),  # not a sqlite invocation at all
    (ALLOW, "grep -n dashboard_users store/claudeclaw-schema.sql"),  # no write verb, no sqlite invocation
    (ALLOW, "curl -d '{\"note\":\"never INSERT INTO dashboard_users directly\"}' http://x"),  # quoted mention, no sqlite3

    # ---- escape hatch ----
    (ALLOW, "DB_WRITE_GUARD_ALLOW=1 sqlite3 store/claudeclaw.db 'INSERT INTO approvals (id) VALUES (1)'"),
]


def verdict(cmd):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}})
    p = subprocess.run(
        [sys.executable, GUARD], input=payload, capture_output=True, text=True
    )
    return (BLOCK if p.returncode == 2 else ALLOW), (p.stderr or "").strip()


def main():
    failures = []
    for expected, cmd in CASES:
        got, msg = verdict(cmd)
        mark = "ok " if got == expected else "FAIL"
        if got != expected:
            failures.append((cmd, expected, got, msg))
        print(f"  [{mark}] {expected:5} {cmd}")
    print()
    if failures:
        print(f"{len(failures)} FAILED:")
        for cmd, exp, got, msg in failures:
            print(f"  - {cmd!r}: expected {exp}, got {got}. stderr={msg[:160]}")
        return 1
    print(f"All {len(CASES)} cases pass.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
