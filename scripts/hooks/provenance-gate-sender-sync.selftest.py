#!/usr/bin/env python3
"""Selftest: provenance-gate.py's DIRECTIVE_SENDER must equal the fork's REAL directive sender
id (card a65f3777, regression from upstream batch 6).

The hook is plain Python with no build step, so it cannot `import` the TypeScript constant at
runtime -- DIRECTIVE_SENDER is kept as a literal there. This test is the only thing standing
between that literal and a silent re-divergence: it extracts src/web/system-directive-id.ts's
SYSTEM_DIRECTIVE_SENDER value by reading the source as text (no TS toolchain needed) and asserts
byte-for-byte equality against the hook's own literal, THEN drives the hook end to end with a row
written under that real value -- regex equality alone would not catch a hook that still rejects
its own constant for some other reason.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
HOOK = HERE / "provenance-gate.py"
TS_SOURCE = ROOT / "src" / "web" / "system-directive-id.ts"

failures = []
n = 0


def check(label, got, expect):
    global n
    n += 1
    ok = got == expect
    print("%s %r <- %r  %s" % ("OK  " if ok else "FAIL", expect, got, label))
    if not ok:
        failures.append((label, expect, got))


# --- the sync itself -----------------------------------------------------------------------
ts_text = TS_SOURCE.read_text(encoding="utf-8")
m = re.search(r"export const SYSTEM_DIRECTIVE_SENDER\s*=\s*'([^']+)'", ts_text)
if not m:
    print("FAIL  could not find SYSTEM_DIRECTIVE_SENDER in %s -- the extraction regex itself "
          "is stale, not a passing case" % TS_SOURCE)
    failures.append(("extraction", "a match", "none"))
    real_sender = None
else:
    real_sender = m.group(1)

hook_text = HOOK.read_text(encoding="utf-8")
m2 = re.search(r'^DIRECTIVE_SENDER\s*=\s*"([^"]+)"', hook_text, re.MULTILINE)
hook_sender = m2.group(1) if m2 else None

check("provenance-gate.py's DIRECTIVE_SENDER matches system-directive-id.ts's SYSTEM_DIRECTIVE_SENDER",
      hook_sender, real_sender)

# This is the regression itself, pinned so a reviewer can see what the bug WAS, not just that the
# sync check passes: the bare upstream convention must NOT be what this hook expects.
check("DIRECTIVE_SENDER is not the bare upstream 'system' convention (the actual bug, card a65f3777)",
      hook_sender == "system", False)

# --- end-to-end: a row written under the REAL sender value must verify ---------------------
if real_sender:
    db_dir = tempfile.mkdtemp(prefix="provenance-sender-sync-")
    db_path = os.path.join(db_dir, "queue.db")
    conn = sqlite3.connect(db_path)
    conn.execute(
        "CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, from_agent TEXT NOT NULL, "
        "to_agent TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, "
        "created_at INTEGER NOT NULL)"
    )
    body = "[CONTEXT-GUARD] szinkron-teszt."
    conn.execute(
        "INSERT INTO agent_messages (id, from_agent, to_agent, content, status, created_at) "
        "VALUES (?,?,?,?,?,?)",
        (900001, real_sender, "testagent", body, "delivered", int(time.time())),
    )
    conn.commit()
    conn.close()

    rules_dir = tempfile.mkdtemp(prefix="provenance-sender-sync-rules-")
    prompt = "[SYSTEM-DIREKTIVA msg_id:900001 -- X]\n" + body
    cwd = str(ROOT / "agents" / "testagent")
    env = dict(os.environ)
    env["PROVENANCE_GATE_DB"] = db_path
    env["PROVENANCE_GATE_RULES"] = os.path.join(rules_dir, "no-such-rules.json")
    p = subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps({"prompt": prompt, "cwd": cwd}),
        capture_output=True, text=True, env=env,
    )
    check("a row from the REAL directive sender verifies end-to-end (hook stays silent)",
          p.stdout.strip(), "")

print()
print("selftest: %d case(s), %s" % (n, "PASS" if not failures else "FAIL"))
for f in failures:
    print("  - %s: expected %r, got %r" % f)
sys.exit(1 if failures else 0)
