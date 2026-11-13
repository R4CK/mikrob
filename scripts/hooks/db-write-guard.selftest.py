#!/usr/bin/env python3
"""Self-test for db-write-guard.py (card c1766c6c).

Run:  python3 scripts/hooks/db-write-guard.selftest.py
Exit: 0 = all pass, 1 = at least one case wrong.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

GUARD = str(Path(__file__).with_name("db-write-guard.py"))

BLOCK = "block"
ALLOW = "allow"

# BLOCKING2 repro (QA FAIL 28673): a real filesystem symlink aliasing the protected db under a
# different name must still resolve (via its basename) to claudeclaw.db.
_ALIAS_DIR = Path(tempfile.gettempdir()) / "db-write-guard-selftest-realdir"
_ALIAS_DIR.mkdir(exist_ok=True)
_ALIAS_TARGET = _ALIAS_DIR / "claudeclaw.db"
_ALIAS_TARGET.touch(exist_ok=True)
_ALIAS_PATH = Path("/tmp/db-write-guard-selftest-alias.db")
if _ALIAS_PATH.is_symlink() or _ALIAS_PATH.exists():
    _ALIAS_PATH.unlink()
os.symlink(_ALIAS_TARGET, _ALIAS_PATH)

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

    # ---- re-gate round 2: CYBERSEC NO-GO 28672 M1a, case-insensitive table name ----
    (BLOCK, 'sqlite3 store/claudeclaw.db "INSERT INTO DASHBOARD_USERS (id) VALUES (1)"'),
    (BLOCK, "sqlite3 store/claudeclaw.db 'update Auth_Sessions set x=1'"),
    (BLOCK, "sqlite3 store/claudeclaw.db 'DELETE FROM Approvals WHERE id=1'"),

    # ---- re-gate round 2: NO-GO 28672 M1b, wrapper forms that must still be caught ----
    (BLOCK, '/usr/bin/sqlite3 store/claudeclaw.db "INSERT INTO dashboard_users (id) VALUES (1)"'),
    (BLOCK, 'env sqlite3 store/claudeclaw.db "INSERT INTO dashboard_users (id) VALUES (1)"'),
    (BLOCK, 'timeout 5 sqlite3 store/claudeclaw.db "DELETE FROM approvals"'),
    (BLOCK, '\\sqlite3 store/claudeclaw.db "DELETE FROM approvals"'),
    (BLOCK, "bash -c 'sqlite3 store/claudeclaw.db \"INSERT INTO dashboard_users (id) VALUES (1)\"'"),
    (BLOCK, 'sh -c "sqlite3 store/claudeclaw.db \\"DELETE FROM auth_sessions\\""'),
    (
        BLOCK,
        "python3 - <<'PY'\nimport sqlite3\nc = sqlite3.connect('store/claudeclaw.db')\n"
        "c.execute('DELETE FROM dashboard_users')\nPY",
    ),  # heredoc body is the live python, not a file being written
    (
        BLOCK,
        "node -e \"const db=require('better-sqlite3')('store/claudeclaw.db'); "
        "db.prepare('DELETE FROM approvals').run()\"",
    ),
    (
        BLOCK,
        "perl -e \"use DBI; DBI->connect('dbi:SQLite:dbname=store/claudeclaw.db'); "
        "\\$dbh->do('DELETE FROM approvals')\"",
    ),

    # ---- re-gate round 2: NO-GO 28672 M1c, side-channel SQL this guard cannot read ----
    (BLOCK, "sqlite3 store/claudeclaw.db < evil.sql"),
    (BLOCK, "sqlite3 store/claudeclaw.db <<'SQL'\n.read evil.sql\nSQL"),
    (BLOCK, "sqlite3 store/claudeclaw.db <<'SQL'\n.import rows.csv dashboard_users\nSQL"),

    # ---- re-gate round 2: NO-GO 28672 M2, escape hatch must be real command-position syntax ----
    (BLOCK, 'sqlite3 store/claudeclaw.db "DELETE FROM approvals" # DB_WRITE_GUARD_ALLOW=1'),
    (BLOCK, "echo DB_WRITE_GUARD_ALLOW=1 >/dev/null; sqlite3 store/claudeclaw.db 'DELETE FROM approvals'"),
    (
        BLOCK,
        "sqlite3 store/claudeclaw.db \"DELETE FROM approvals WHERE note='DB_WRITE_GUARD_ALLOW=1'\"",
    ),

    # ---- re-gate round 2: QA FAIL 28673 BLOCKING1 repro (now fixed by M1a) ----
    (BLOCK, 'sqlite3 store/claudeclaw.db "INSERT INTO DASHBOARD_USERS (id) VALUES (1)"'),

    # ---- re-gate round 2: QA FAIL 28673 BLOCKING2, symlink / unresolvable env-var indirection ----
    (BLOCK, "sqlite3 /tmp/db-write-guard-selftest-alias.db 'INSERT INTO dashboard_users (id) VALUES (1)'"),
    (BLOCK, 'sqlite3 "$DB_PATH_SET_EARLIER" "INSERT INTO dashboard_users (id) VALUES (1)"'),
    # a genuinely different, unrelated db by a literal (non-variable) name is still out of scope
    (ALLOW, "sqlite3 /tmp/completely-unrelated.db 'INSERT INTO dashboard_users (id) VALUES (1)'"),

    # ---- re-gate round 2: QA FAIL 28673, Write/Edit/MultiEdit blind spot ----
    (BLOCK, {"tool_name": "Write", "tool_input": {"file_path": "store/claudeclaw.db", "content": "garbage"}}),
    (BLOCK, {"tool_name": "Edit", "tool_input": {"file_path": "/home/neon/marveen/store/claudeclaw.db", "old_string": "a", "new_string": "b"}}),
    (BLOCK, {"tool_name": "MultiEdit", "tool_input": {"file_path": "store/claudeclaw.db", "edits": []}}),
    (ALLOW, {"tool_name": "Write", "tool_input": {"file_path": "store/some-other-file.txt", "content": "hi"}}),

    # ---- re-gate round 2: QA FAIL 28673 minor, read-only false blocks (M3) ----
    (ALLOW, 'sqlite3 store/claudeclaw.db "SELECT replace(name, \'a\', \'b\') FROM approvals"'),
    (ALLOW, "sqlite3 store/claudeclaw.db \"SELECT * FROM approvals WHERE category LIKE '%delete%'\""),
    (ALLOW, "sqlite3 store/claudeclaw.db \"SELECT * FROM approvals WHERE category='insert'\""),
    (ALLOW, "sqlite3 store/claudeclaw.db \"SELECT * FROM approvals WHERE category LIKE '%update%'\""),
    (ALLOW, 'sqlite3 store/claudeclaw.db "SELECT * FROM approvals"; curl -X DELETE https://example.invalid'),
    (ALLOW, 'sqlite3 store/claudeclaw.db "SELECT * FROM approvals" # replace later'),

    # ---- re-gate round 3: QA FAIL 28716, runtime env-var indirection (os.environ/os.getenv/
    # $ENV{}/process.env), same fail-closed posture as the shell $VAR case ----
    (
        BLOCK,
        "python3 -c \"import sqlite3,os; sqlite3.connect(os.environ['DB_PATH']).execute("
        "'INSERT INTO dashboard_users (id) VALUES (1)')\"",
    ),
    (
        BLOCK,
        "python3 -c \"import sqlite3,os; sqlite3.connect(os.getenv('DB_PATH')).execute("
        "'DELETE FROM approvals')\"",
    ),
    (
        BLOCK,
        "perl -e 'my $p = $ENV{DB_PATH}; DBI->connect(\"dbi:SQLite:dbname=$p\")->do("
        "\"INSERT INTO dashboard_users (id) VALUES (1)\")'",
    ),
    (
        BLOCK,
        "node -e \"const {DatabaseSync}=require('node:sqlite'); "
        "const db=new DatabaseSync(process.env.DB_PATH); "
        "db.exec('INSERT INTO dashboard_users (id) VALUES (1)')\"",
    ),
    # no protected table/verb visible -- the env-var indirection alone is not enough to block
    (
        ALLOW,
        "python3 -c \"import sqlite3,os; sqlite3.connect(os.environ['DB_PATH']).execute("
        "'SELECT 1')\"",
    ),

    # ---- re-gate round 3: QA FAIL 28716, plain pipe into sqlite3 (same side-channel class as
    # M1c's </.read/.import) ----
    (BLOCK, "cat evil.sql | sqlite3 store/claudeclaw.db"),
    (BLOCK, "cat evil.sql | env sqlite3 store/claudeclaw.db"),
    (BLOCK, "cat evil.sql | timeout 5 sqlite3 store/claudeclaw.db"),
    (BLOCK, "cat evil.sql | sudo -u x sqlite3 store/claudeclaw.db"),
    (BLOCK, "cat evil.sql | tee /tmp/x.sql | sqlite3 store/claudeclaw.db"),

    # ---- re-gate round 4: CYBERSEC NO-GO 28718/28723 N1, write statement embedded in a literal
    # or variable assignment (regression vs round 1, hidden by M3's literal-blanking) ----
    (
        BLOCK,
        "python3 -c \"import sqlite3;c=sqlite3.connect('store/claudeclaw.db');"
        "q='DELETE FROM approvals';c.execute(q);c.commit()\"",
    ),
    (
        BLOCK,
        "python3 -c \"import sqlite3;c=sqlite3.connect('store/claudeclaw.db');"
        "sql='UPDATE auth_sessions SET expires_at=0';c.execute(sql)\"",
    ),
    (BLOCK, "Q='DELETE FROM approvals'; sqlite3 store/claudeclaw.db \"$Q\""),
    (
        BLOCK,
        "sqlite3 store/claudeclaw.db \"SELECT 1 WHERE '1'='x\\'; DELETE FROM approvals; --'\"",
    ),
    # regression guard: a genuine comparison value never has the table name INSIDE the same
    # literal -- these must stay ALLOW (M3 must not regress)
    (ALLOW, "sqlite3 store/claudeclaw.db \"SELECT * FROM approvals WHERE category='insert'\""),
    (ALLOW, "sqlite3 store/claudeclaw.db \"SELECT * FROM approvals WHERE category LIKE '%delete%'\""),

    # ---- re-gate round 4: CYBERSEC NO-GO 28718/28723 N2 covered by src/__tests__ wiring tests
    # (matcher string assertion), not here -- this file only exercises the hook's own stdin
    # protocol, which the matcher registration sits outside of.

    # ---- re-gate round 4: CYBERSEC NO-GO 28718/28723 P1, pipe-rule false blocks ----
    (ALLOW, "echo '.tables' | sqlite3 store/claudeclaw.db"),
    (ALLOW, "printf 'SELECT count(*) FROM approvals;' | sqlite3 store/claudeclaw.db"),
    (ALLOW, "lsof store/claudeclaw.db | grep sqlite3"),
    (ALLOW, "ls -la store/claudeclaw.db* | grep -i sqlite3"),
    (ALLOW, 'sqlite3 store/claudeclaw.db "SELECT * FROM approvals" | grep -c sqlite3'),
    # a readable pipe source that DOES carry a write verb+table must still block
    (BLOCK, "echo 'DELETE FROM approvals' | sqlite3 store/claudeclaw.db"),
    # MikroB's live datapoint: a heredoc that only WRITES a message file quoting an example
    # delete statement, sharing a top-level command with an unrelated real read-only SELECT
    (
        ALLOW,
        "cat > /tmp/db-write-guard-selftest-msg.json <<'JSON'\n"
        '{"content": "example: DELETE FROM approvals WHERE id=1"}\n'
        "JSON\n"
        'sqlite3 store/claudeclaw.db "select id from approvals limit 1"',
    ),

    # ---- re-gate round 5: CYBERSEC NO-GO 28743 R1, heredoc opener's own line was being blanked ----
    (
        BLOCK,
        "cat <<'EOF' | sqlite3 store/claudeclaw.db\nDELETE FROM approvals;\nEOF",
    ),
    (
        BLOCK,
        'cat <<\'EOF\'; sqlite3 store/claudeclaw.db "DELETE FROM approvals"\nirrelevant\nEOF',
    ),
    (
        BLOCK,
        "cat <<'EOF' && sqlite3 store/claudeclaw.db \"DELETE FROM approvals\"\nirrelevant\nEOF",
    ),
    (
        BLOCK,
        "cat <<EOF > f ; sqlite3 store/claudeclaw.db 'UPDATE approvals SET x=1'\nirrelevant\nEOF",
    ),
    (
        BLOCK,
        "cat <<'EOF' | python3 -c \"import sqlite3; "
        "sqlite3.connect('store/claudeclaw.db').execute('DELETE FROM approvals')\"\nirrelevant\nEOF",
    ),
    # the no-heredoc control and a write AFTER the closing marker must still block (mutation pins)
    (BLOCK, 'sqlite3 store/claudeclaw.db "DELETE FROM approvals"'),
    (
        BLOCK,
        "cat <<'EOF'\nhello\nEOF\nsqlite3 store/claudeclaw.db \"DELETE FROM approvals\"",
    ),
    # widened heredoc-keep list: a shell-wrapper opener must not have its body blanked either
    (
        BLOCK,
        "bash <<'EOF'\nsqlite3 store/claudeclaw.db \"DELETE FROM approvals\"\nEOF",
    ),
    # unrelated-opener heredoc body still blanks correctly (P1 fix from round 4 must not regress)
    (
        ALLOW,
        "cat > /tmp/db-write-guard-selftest-msg2.json <<'JSON'\n"
        '{"content": "example: DELETE FROM approvals WHERE id=1"}\n'
        "JSON\n"
        'sqlite3 store/claudeclaw.db "select id from approvals limit 1"',
    ),

    # ---- re-gate round 5: CYBERSEC NO-GO 28743 R2, readable-pipe-source check too permissive ----
    (BLOCK, "Q='DELETE FROM approvals'; echo \"$Q\" | sqlite3 store/claudeclaw.db"),
    (BLOCK, "echo \"$(cat /tmp/nonexistent-selftest-file)\" | sqlite3 store/claudeclaw.db"),
    (
        BLOCK,
        "printf '%b' '\\x44ELETE FROM approvals' | sqlite3 store/claudeclaw.db",
    ),
    (
        BLOCK,
        "echo -e '\\x44ELETE FROM approvals' | sqlite3 store/claudeclaw.db",
    ),
    # a genuinely plain literal source stays allowed/blocked exactly as round 4 already covers
    (ALLOW, "echo '.tables' | sqlite3 store/claudeclaw.db"),
    (ALLOW, "printf 'SELECT count(*) FROM approvals' | sqlite3 store/claudeclaw.db"),
    (BLOCK, "echo 'DELETE FROM approvals' | sqlite3 store/claudeclaw.db"),
    # round 5 R1b (CYBERSEC NO-GO 28763): a consumer named AFTER <<MARK on the opener's own line
    # (not before it) was never checked -- the heredoc's cat body is piped into a shell that then
    # runs the sqlite3 write inside it, or dot-sourced directly.
    (BLOCK, "cat <<'EOF' | bash\nsqlite3 store/claudeclaw.db \"DELETE FROM approvals\"\nEOF"),
    (BLOCK, "cat <<'EOF' | sh -s\nsqlite3 store/claudeclaw.db \"DELETE FROM approvals\"\nEOF"),
    (BLOCK, ". /dev/stdin <<'EOF'\nsqlite3 store/claudeclaw.db \"DELETE FROM approvals\"\nEOF"),
]


def verdict(case):
    if isinstance(case, dict):
        payload = json.dumps(case)
    else:
        payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": case}})
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
