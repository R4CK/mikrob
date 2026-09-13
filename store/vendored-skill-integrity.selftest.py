#!/usr/bin/env python3
"""Runs vendored-skill-integrity.py's own --selftest, under the name the suite DISCOVERS.

WHY A SHIM AND NOT A REGISTRY LINE. src/__tests__/store-selftests-all-run.test.ts finds selftests
two ways: a `store/*.selftest.{sh,py}` glob (automatic), and a hand-written MODE_SELFTESTS list for
scripts whose selftest is an argument. That file's own comments record what the hand-written half
costs: of 13 shell selftests, EIGHT were never invoked, because wiring one meant remembering to.
Adding a line there would have made this the ninth thing someone has to remember. This file is the
same wiring with nothing to remember -- the glob cannot forget it.
"""
import pathlib
import subprocess
import sys

TOOL = pathlib.Path(__file__).with_name("vendored-skill-integrity.py")

if not TOOL.is_file():
    # The shim outliving the tool would otherwise be a selftest that passes by having nothing to run.
    print("FAIL: %s is missing -- the shim is wired to a tool that is not there" % TOOL.name)
    sys.exit(1)

sys.exit(subprocess.run([sys.executable, str(TOOL), "--selftest"]).returncode)
