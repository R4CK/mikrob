#!/usr/bin/env python3
"""Self-test for suite-evidence-record.py (card 08eb6402, MikroB plan-grilling verdict 6011/3736).

Covers: clean-pass recording, real-failure recording (still a valid, non-anomalous record -- a red
suite is evidence too), the birpc flake and the killed-mid-run "incomplete" cases both landing as
`anomaly: true` (never read as pass or fail), lookup by tree hash (present/anomaly/failed/missing),
and that the LATEST record wins when a tree hash has more than one (a re-run after a flake).
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "suite-evidence-record.py")

failures = []
n = 0
WORK = tempfile.mkdtemp(prefix="suite-evidence-selftest-")
STORE = os.path.join(WORK, "evidence.jsonl")
LOGDIR = os.path.join(WORK, "logs")


def write_log(name, text):
    p = os.path.join(WORK, name)
    with open(p, "w") as f:
        f.write(text)
    return p


CLEAN_LOG = write_log("clean.log", "\n Test Files  5 passed (5)\n      Tests  20 passed (20)\n")
FAIL_LOG = write_log(
    "fail.log",
    "\n Test Files  1 failed | 4 passed (5)\n      Tests  2 failed | 18 passed (20)\n",
)
FLAKE_LOG = write_log(
    "flake.log",
    '\n[vitest-worker]: Timeout calling "onTaskUpdate"\n Test Files  5 passed (5)\n'
    "      Tests  20 passed (20)\n",
)
INCOMPLETE_LOG = write_log("incomplete.log", "some partial output, then silence\n")
# CARD 08eb6402, CYBERSEC F1(a): a file that fails to even LOAD (an import error after a rename)
# can print "Tests N passed (N)" -- zero test-level failures -- while "Test Files" still counts the
# file itself as failed and vitest exits non-zero. This is the exact repro from the finding.
IMPORT_ERROR_LOG = write_log(
    "import-error.log",
    "\nError: Cannot find module './bar' imported from src/foo.test.ts\n"
    " Test Files  1 failed | 4 passed (5)\n      Tests  18 passed (18)\n",
)


def record(label, expect_prefix, **kwargs):
    global n
    n += 1
    args = [sys.executable, TOOL, "record", "--store", STORE, "--log-dir", LOGDIR]
    for k, v in kwargs.items():
        args += ["--%s" % k.replace("_", "-"), str(v)]
    p = subprocess.run(args, capture_output=True, text=True)
    ok = p.returncode == 0 and p.stdout.strip().startswith(expect_prefix)
    print("%s %-8s <- %-8s %s" % (
        "OK  " if ok else "FAIL", expect_prefix, p.stdout.strip().split("|", 1)[0] or "(nothing)", label))
    if not ok:
        failures.append((label, expect_prefix, "%s (rc=%s, stderr=%s)" % (p.stdout, p.returncode, p.stderr)))
    return p.stdout.strip()


def lookup(label, tree, expect_prefix):
    global n
    n += 1
    p = subprocess.run([sys.executable, TOOL, "lookup", "--tree", tree, "--store", STORE],
                       capture_output=True, text=True)
    ok = p.returncode == 0 and p.stdout.strip().startswith(expect_prefix)
    print("%s %-8s <- %-8s %s" % (
        "OK  " if ok else "FAIL", expect_prefix, p.stdout.strip().split("|", 1)[0] or "(nothing)", label))
    if not ok:
        failures.append((label, expect_prefix, "%s (rc=%s)" % (p.stdout, p.returncode)))


print("suite-evidence-record selftest")

lookup("a tree hash with no record at all", "tree-none", "MISSING")

record("a clean pass records READY with the right counts",
       "READY", sha="sha-clean", tree="tree-clean", agent="backend3",
       main_log=CLEAN_LOG, main_status=0)
lookup("...and lookup finds it as PRESENT (0 failures)", "tree-clean", "PRESENT")

record("a real failure is STILL a valid (non-anomalous) record",
       "READY", sha="sha-fail", tree="tree-fail", agent="backend3",
       main_log=FAIL_LOG, main_status=1)
lookup("...and lookup reports it as FAILED, not PRESENT", "tree-fail", "FAILED")

record("an import-error file (zero test-level failures, exit 1) is still a valid record",
       "READY", sha="sha-import-error", tree="tree-import-error", agent="backend3",
       main_log=IMPORT_ERROR_LOG, main_status=1)
lookup("...and lookup reports FAILED, not PRESENT, from Test Files alone (F1(a))",
       "tree-import-error", "FAILED")

record("the birpc flake (0 real failures, worker-RPC timeout) records ANOMALY, not READY-as-pass",
       "ANOMALY", sha="sha-flake", tree="tree-flake", agent="backend3",
       main_log=FLAKE_LOG, main_status=1)
lookup("...and lookup reports ANOMALY, never PRESENT or FAILED", "tree-flake", "ANOMALY")

record("a killed-mid-run log with no summary at all also records ANOMALY",
       "ANOMALY", sha="sha-dead", tree="tree-dead", agent="backend3",
       main_log=INCOMPLETE_LOG, main_status=137)

record("an e2e leg that anomalies marks the WHOLE record anomalous even if main leg is clean",
       "ANOMALY", sha="sha-mixed", tree="tree-mixed", agent="backend3",
       main_log=CLEAN_LOG, main_status=0, e2e_log=FLAKE_LOG, e2e_status=1)

record("pass/fail counts SUM across the main and e2e legs",
       "READY", sha="sha-sum", tree="tree-sum", agent="backend3",
       main_log=CLEAN_LOG, main_status=0, e2e_log=CLEAN_LOG, e2e_status=0)
n += 1
with open(STORE) as f:
    last = json.loads([l for l in f if l.strip()][-1])
ok = last["pass"] == 40 and last["fail"] == 0
print("%s %-8s <- %-8s %s" % ("OK  " if ok else "FAIL", "pass=40", "pass=%s" % last["pass"],
                               "20+20 passed across two legs sums to 40"))
if not ok:
    failures.append(("summed counts", "pass=40 fail=0", json.dumps(last)))

# THE LATEST record wins for a given tree -- a re-run after a flake must be found, not the stale one.
record("a re-run on the SAME tree after a flake ...", "READY",
       sha="sha-flake-retry", tree="tree-flake", agent="backend3",
       main_log=CLEAN_LOG, main_status=0)
lookup("...makes lookup report the LATEST (PRESENT), not the earlier ANOMALY", "tree-flake", "PRESENT")

n += 1
p = subprocess.run([sys.executable, TOOL, "record", "--store", STORE, "--log-dir", LOGDIR,
                    "--sha", "s", "--tree", "t", "--agent", "a",
                    "--main-log", "/nonexistent/does/not/exist", "--main-status", "0"],
                   capture_output=True, text=True)
ok = p.returncode == 0 and p.stdout.strip().startswith("ANOMALY")
print("%s %-8s <- %-8s %s" % ("OK  " if ok else "FAIL", "ANOMALY", p.stdout.strip().split("|", 1)[0],
                               "a missing log file never crashes the recorder, records ANOMALY"))
if not ok:
    failures.append(("missing log file", "ANOMALY (rc=0)", "%s (rc=%s)" % (p.stdout, p.returncode)))

import shutil  # noqa: E402
shutil.rmtree(WORK, ignore_errors=True)

print()
print("selftest: %d case(s), %s" % (n, "PASS" if not failures else "FAIL"))
for label, expect, got in failures:
    print("  - %s: expected %s, got %s" % (label, expect, got))
sys.exit(1 if failures else 0)
