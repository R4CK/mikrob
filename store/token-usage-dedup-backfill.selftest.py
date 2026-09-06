#!/usr/bin/env python3
"""Selftest for store/token-usage-dedup-backfill.py.

Builds a synthetic token_usage table whose groups are the shapes measured on the live
database, then checks that the three survivor rules actually DIFFER on them (a bench that
returns the same answer for every rule proves nothing), that --apply mutates exactly the
planned rows, and that --rollback restores the table byte for byte.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "token-usage-dedup-backfill.py")

spec = importlib.util.spec_from_file_location("token_usage_dedup_backfill", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

PASSES = 0
FAILURES = 0


def check(label, got, want):
    global PASSES, FAILURES
    if got == want:
        PASSES += 1
        print("ok   %s" % label)
    else:
        FAILURES += 1
        print("FAIL %s: got %r, want %r" % (label, got, want))


SCHEMA = """
CREATE TABLE token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  content_preview TEXT,
  tool_name TEXT,
  task_title TEXT,
  project TEXT,
  thinking_tokens INTEGER NOT NULL DEFAULT 0,
  model TEXT
);
CREATE UNIQUE INDEX idx_token_usage_dedup
  ON token_usage(agent, session_id, timestamp, input_tokens, output_tokens);
"""

# (agent, session, ts, in, out, task_title, project, model)
ROWS = [
    # A: cross-agent WITH a mikrob row.  mikrob carries no project; the others stamped
    # their own card on the same event.  This is the fabrication case.
    ("mikrob", "sA", 100, 2, 285, None, None, "opus"),
    ("backend", "sA", 100, 2, 285, "card X", "MikroB", "opus"),
    ("qa", "sA", 100, 2, 285, "card Y", "CleanCore", "opus"),
    # B: cross-agent, no mikrob, the project values DISAGREE -> must be nulled, not picked.
    ("backend", "sB", 200, 3, 40, "b task", "P1", "opus"),
    ("qa", "sB", 200, 3, 40, "q task", "P2", "opus"),
    # C: cross-agent, no mikrob, the project values AGREE -> keeping it is not fabrication.
    ("backend", "sC", 300, 1, 10, None, "P", None),
    ("qa", "sC", 300, 1, 10, None, "P", None),
    # D: singleton with an EMPTY project; must not be rewritten to NULL by anyone.
    ("fron-ted", "sD", 400, 5, 5, None, "", None),
    # E: two DISTINCT events from one agent.  A same-agent duplicate cannot even be
    # inserted -- the unique index has `agent` first -- which is why the live measurement
    # found zero of them.  Neither row may be deleted.
    ("backend", "sE", 500, 7, 7, "e task", "P", "opus"),
    ("backend", "sE", 501, 7, 7, "e task", "P", "opus"),
]


def build_db(path):
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    for agent, session, ts, tin, tout, title, project, model in ROWS:
        conn.execute(
            "INSERT INTO token_usage (agent, session_id, timestamp, input_tokens,"
            " output_tokens, task_title, project, model) VALUES (?,?,?,?,?,?,?,?)",
            (agent, session, ts, tin, tout, title, project, model),
        )
    conn.commit()
    conn.close()


def snapshot(path):
    conn = sqlite3.connect(path)
    rows = conn.execute(
        "SELECT %s FROM token_usage ORDER BY id" % ", ".join(mod.COLUMNS)
    ).fetchall()
    conn.close()
    return rows


def group(db, session):
    conn = mod.open_ro(db)
    rows = conn.execute(
        "SELECT %s FROM token_usage WHERE session_id=? ORDER BY id" % ", ".join(mod.COLUMNS),
        (session,),
    ).fetchall()
    conn.close()
    return rows


def main():
    tmp = tempfile.mkdtemp(prefix="token-usage-dedup-selftest-")
    db = os.path.join(tmp, "test.db")
    build_db(db)

    # --- the three rules must disagree on group A ----------------------------------
    a = group(db, "sA")
    check("minid picks the mikrob row on A", mod.pick_survivor(a, "minid")[0]["agent"], "mikrob")
    check(
        "completeness picks a STAMPED row on A",
        mod.pick_survivor(a, "completeness")[0]["agent"],
        "backend",
    )
    check(
        "attribution-safe keeps the mikrob row on A",
        mod.pick_survivor(a, "attribution-safe")[0]["agent"],
        "mikrob",
    )
    check("attribution-safe writes no override on A", mod.pick_survivor(a, "attribution-safe")[1], {})

    # --- disagreeing fields are nulled, not picked ----------------------------------
    b = group(db, "sB")
    surv_b, over_b = mod.pick_survivor(b, "attribution-safe")
    check("B survivor is the lowest id", surv_b["agent"], "backend")
    check("B is relabelled unattributed", over_b.get("agent"), "unattributed")
    check("B disagreeing project is nulled", over_b.get("project", "MISSING"), None)
    check("B disagreeing task_title is nulled", over_b.get("task_title", "MISSING"), None)

    # --- unanimous fields survive ---------------------------------------------------
    c = group(db, "sC")
    _surv_c, over_c = mod.pick_survivor(c, "attribution-safe")
    check("C is relabelled unattributed", over_c.get("agent"), "unattributed")
    check("C unanimous project is NOT touched", "project" in over_c, False)

    # --- an empty-string field must not produce a no-op rewrite ----------------------
    d = group(db, "sD")
    check("D singleton yields no override", mod.pick_survivor(d, "attribution-safe")[1], {})

    # --- two distinct events from one agent are two keys, not a duplicate ------------
    e = group(db, "sE")
    check("E holds two rows in the table", len(e), 2)

    # --- dry-run counts --------------------------------------------------------------
    proc = subprocess.run(
        [sys.executable, SCRIPT, "--db", db, "--dry-run"], capture_output=True, text=True
    )
    check("dry-run exits 0", proc.returncode, 0)
    out = proc.stdout
    check("dry-run says nothing was written", "nothing was written" in out, True)
    check("dry-run reports 10 rows", "rows                          10" in out, True)
    check("dry-run counts the fabrication case", "picks another agent: 1" in out, True)
    check("dry-run leaves the table alone", len(snapshot(db)), 10)

    # --- apply, then prove the rollback ---------------------------------------------
    before = snapshot(db)
    rollback = os.path.join(tmp, "rb.jsonl.gz")
    rc = mod.main(["--db", db, "--apply", "--rule", "attribution-safe", "--yes",
                   "--rollback-file", rollback])
    check("apply exits 0", rc, 0)
    after = snapshot(db)
    check("apply deleted 4 rows", len(before) - len(after), 4)
    check("rollback file exists", os.path.exists(rollback), True)

    conn = sqlite3.connect(db)
    check(
        "A survivor is still mikrob",
        conn.execute("SELECT agent FROM token_usage WHERE session_id='sA'").fetchone()[0],
        "mikrob",
    )
    check(
        "B survivor is unattributed",
        conn.execute("SELECT agent FROM token_usage WHERE session_id='sB'").fetchone()[0],
        "unattributed",
    )
    check(
        "B survivor has no fabricated project",
        conn.execute("SELECT project FROM token_usage WHERE session_id='sB'").fetchone()[0],
        None,
    )
    check(
        "C survivor keeps the unanimous project",
        conn.execute("SELECT project FROM token_usage WHERE session_id='sC'").fetchone()[0],
        "P",
    )
    check(
        "D singleton is untouched",
        conn.execute("SELECT agent, project FROM token_usage WHERE session_id='sD'").fetchone(),
        ("fron-ted", ""),
    )
    conn.close()

    rc = mod.main(["--db", db, "--rollback", rollback])
    check("rollback exits 0", rc, 0)
    check("rollback restores the table byte for byte", snapshot(db), before)

    # --- control: --apply refuses without --yes --------------------------------------
    guarded = os.path.join(tmp, "guarded.db")
    shutil.copyfile(db, guarded)
    rc = mod.main(["--db", guarded, "--apply", "--rule", "minid"])
    check("apply without --yes refuses", rc, 2)
    check("refusal left the table alone", len(snapshot(guarded)), 10)

    shutil.rmtree(tmp, ignore_errors=True)
    print("selftest: %d passed, %d failed" % (PASSES, FAILURES))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
