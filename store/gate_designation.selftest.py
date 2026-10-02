#!/usr/bin/env python3
"""Standalone selftest for gate_designation.py (card acc197c8) -- offline, no API calls.

Exercises the shared designation function directly (not just through gate-dispatch-check.sh's own
selftest, which only proves the import wiring did not regress its existing cases) and the CLI
entrypoint mopsion-land.sh calls.
"""
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from gate_designation import designated_gates  # noqa: E402

HERE = Path(__file__).parent
SCRIPT = HERE / "gate_designation.py"

failures = []


def check(label, got, want):
    if got != want:
        failures.append(f"{label}: got {got!r}, want {want!r}")
    else:
        print(f"  ok   {label} -> {got!r}")


# --- designated_gates() direct calls --------------------------------------------------------
check("labels only", designated_gates("qa,cybersec", ""), frozenset({"qa", "qa2", "cybersec"}))
check("gate-line fallback when no labels", designated_gates("", "Gate: QA + Cybered."),
      frozenset({"qa", "qa2", "cybered"}))
check("labels override a conflicting gate-line",
      designated_gates("cybered", "Gate: QA."), frozenset({"cybered"}))
check("neither source -> None", designated_gates("", ""), None)
check("unknown label names are dropped", designated_gates("not-a-gate", ""), None)
check("qa2 label widens to qa too", designated_gates("qa2", ""), frozenset({"qa", "qa2"}))

# --- CLI entrypoint, exactly as mopsion-land.sh would call it -------------------------------
def cli(labels, line):
    out = subprocess.run(
        [sys.executable, str(SCRIPT), labels, line],
        capture_output=True, text=True, check=True,
    )
    return out.stdout.strip()


check("CLI: labels -> sorted comma-joined", cli("cybersec,qa", ""), "cybersec,qa,qa2")
check("CLI: no designation -> empty string", cli("", ""), "")
check("CLI: gate-line only", cli("", "Gate: Cybered."), "cybered")

if failures:
    print("\nFAILURES:")
    for f in failures:
        print(" -", f)
    sys.exit(1)
print("\nselftest: PASS")
