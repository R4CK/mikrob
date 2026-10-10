#!/usr/bin/env python3
"""SIZEBOUND924: _safe_read_text's size cap must hold even when fstat's st_size lies or
changes after the check (card 14256aac, Cybersec NO-GO F1 on e8b479d0, delta-gate on
e8b479d0's own fix for Cybered NO-GO C1).

Measured live by Cybersec: a /proc file reporting st_size=0 had its real (8 MiB) content
read and audited in full, because the size cap only looked at fstat's st_size, never at
what the read actually returned. A sparse file rewritten by another process passed the
size check as "small" in 18/80 runs and then grew past a 400 MB RLIMIT_AS during the read.
The fix bounds the READ itself (os.read(fd, CAP + 1), reject on overrun), with the st_size
check kept only as a cheap, non-authoritative fast-path.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import os
import sys
import tempfile
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
GATE_PATH = os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")

spec = importlib.util.spec_from_file_location("outgoing_copy_gate_sizebound", GATE_PATH)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


with tempfile.TemporaryDirectory() as td:
    small = os.path.join(td, "small.txt")
    with open(small, "w", encoding="utf-8") as f:
        f.write("hello")
    text, reason = gate._safe_read_text(small)
    check("a small regular file reads normally", text == "hello" and reason is None)

    big = os.path.join(td, "big.txt")
    with open(big, "w", encoding="utf-8") as f:
        f.write("x" * (gate._MAX_BODY_FILE_BYTES + 10))
    text, reason = gate._safe_read_text(big)
    check("an honestly-oversized file is rejected (st_size fast-path)",
          text == "" and reason is not None and "nagy" in reason, f"got {(text[:20], reason)!r}")

    # SIZEBOUND924: fstat reports st_size=0 (the procfs/sysfs shape), but the real content
    # is over the cap. The fast-path alone would wave this through as "small".
    lying_path = os.path.join(td, "lying.txt")
    with open(lying_path, "w", encoding="utf-8") as f:
        f.write("y" * (gate._MAX_BODY_FILE_BYTES + 10))
    real_fstat = os.fstat

    def lying_fstat(fd):
        st = real_fstat(fd)
        class _Lying:
            st_mode = st.st_mode
            st_size = 0
        return _Lying()

    with mock.patch.object(gate.os, "fstat", side_effect=lying_fstat):
        text, reason = gate._safe_read_text(lying_path)
    check("a file whose fstat lies about st_size=0 is STILL rejected (the bounded read, not the fast-path, catches it)",
          text == "" and reason is not None and "nagy" in reason, f"got {(text[:20], reason)!r}")

    # Control: with the lying fstat but a GENUINELY small file, the bounded read must still
    # return the real content -- the fix must not turn into "always reject".
    lying_small = os.path.join(td, "lying_small.txt")
    with open(lying_small, "w", encoding="utf-8") as f:
        f.write("tiny")
    with mock.patch.object(gate.os, "fstat", side_effect=lying_fstat):
        text, reason = gate._safe_read_text(lying_small)
    check("control: a genuinely small file still reads fine even under the lying fstat",
          text == "tiny" and reason is None, f"got {(text, reason)!r}")

# F3 (Cybersec NO-GO on e8b479d0): S_ISREG's exception survived a mutation test because
# every FIFO case was already caught by O_NONBLOCK alone -- nothing exercised S_ISREG
# against a non-FIFO non-regular file. /dev/zero is both always present and never blocks,
# so it is a clean probe for the mode check specifically, independent of O_NONBLOCK.
if os.path.exists("/dev/zero"):
    text, reason = gate._safe_read_text("/dev/zero")
    check("a character device (/dev/zero) is rejected by S_ISREG, not just O_NONBLOCK",
          text == "" and reason is not None and "szabalyos" in reason, f"got {(text, reason)!r}")
else:
    check("a character device (/dev/zero) is rejected by S_ISREG, not just O_NONBLOCK",
          False, "/dev/zero not present on this host -- cannot probe this case")

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All body-file size-bound tests passed.")
