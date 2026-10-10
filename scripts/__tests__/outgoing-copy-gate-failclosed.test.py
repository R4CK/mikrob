#!/usr/bin/env python3
"""Exit-code contract of scripts/hooks/outgoing-copy-gate.py on malformed input.

Regression guard: a non-dict tool_input crashed the gate with an unhandled
AttributeError -> exit 1. PreToolUse treats exit 1 as NON-blocking, so the
send ran UNCHECKED -- the exact opposite of the email path's fail-closed
contract. The fix is a top-level fail-closed net: any unexpected crash on the
email/Bash send paths exits 2 (block), while the telegram path keeps its own
deliberate fail-open handling (exit 0) and non-send tools stay untouched.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")


def run_gate(payload) -> int:
    data = payload if isinstance(payload, str) else json.dumps(payload)
    proc = subprocess.run(
        [sys.executable, GATE], input=data.encode(), capture_output=True,
    )
    return proc.returncode


CASES = [
    ("email with non-dict tool_input BLOCKS (was: crash, exit 1, send ran unchecked)",
     {"tool_name": "mcp__x__send_email", "tool_input": ["x"]}, 2),
    ("Bash with non-dict tool_input BLOCKS (command is uninspectable)",
     {"tool_name": "Bash", "tool_input": "not-a-dict"}, 2),
    ("telegram reply with non-dict tool_input stays FAIL-OPEN by design",
     {"tool_name": "mcp__plugin_telegram_telegram__reply", "tool_input": 42}, 0),
    ("non-send tool with malformed input passes (the net never widens the gate)",
     {"tool_name": "Read", "tool_input": ["x"]}, 0),
    ("unparseable stdin still exits 0 (must not wedge the session)",
     "this is not json", 0),
]

failed = []
for name, payload, want in CASES:
    got = run_gate(payload)
    ok = got == want
    if not ok:
        failed.append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: exit={got} want={want}")

# FIFOTIMEOUT924 (card 0dab76a3, Cybered C1 HIGH on 087e4418): this gate's own
# collect_bash_body copy keeps the `<` redirect open()+read() -- same bug class
# as email_extract.py's, pre-dating the batch-8 GATEBINVAK916 @file forms (the
# parent already had it). A FIFO with no writer must FAIL FAST, not hang past
# this hook's real timeout (a timed-out PreToolUse hook does not block the
# call). Bounded subprocess timeout so a regression fails loud instead of
# eating the wrapper's budget.
with tempfile.TemporaryDirectory() as td:
    fifo_path = os.path.join(td, "body.fifo")
    os.mkfifo(fifo_path)  # no writer ever opens it
    name = "sendmail < fifo: denied fast, not hung past the real hook timeout"
    t0 = time.monotonic()
    try:
        proc = subprocess.run(
            [sys.executable, GATE],
            input=json.dumps({"tool_name": "Bash", "tool_input": {
                "command": f"sendmail a@b.hu < {fifo_path}"}}).encode(),
            capture_output=True, timeout=3,
        )
        got, elapsed = proc.returncode, time.monotonic() - t0
    except subprocess.TimeoutExpired:
        got, elapsed = None, time.monotonic() - t0
    ok = got == 2 and elapsed < 3
    if not ok:
        failed.append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: exit={got} elapsed={elapsed:.2f}s")

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All outgoing-copy-gate fail-closed tests passed.")
