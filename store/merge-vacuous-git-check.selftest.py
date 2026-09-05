#!/usr/bin/env python3
"""Wires merge-vacuous-git-check.py's own --selftest into store-selftests-all-run.test.ts.

The cases live in the tool so that running it by hand proves it too; this file exists because the
harness discovers `*.selftest.py`, and a control nothing invokes is not a control (card 2003e04b).
"""
import os
import subprocess
import sys

TOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "merge-vacuous-git-check.py")
p = subprocess.run([sys.executable, TOOL, "--selftest"], capture_output=True, text=True)
sys.stdout.write(p.stdout)
sys.stderr.write(p.stderr)
sys.exit(p.returncode)
