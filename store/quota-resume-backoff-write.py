#!/usr/bin/env python3
"""
quota-resume-backoff-write.py -- writes store/quota-resume-backoff.json after one
quota-resume.sh attempt (card 7f112c2f point 1).

M1 (Cybersec NO-GO @f859c361b): this used to be a Python heredoc INLINED in quota-resume.sh, with
its own copy of the 15 -> 30 -> 60 min backoff formula -- a THIRD copy alongside
quota_switchback.compute_backoff_sec() and the selftest's own reimplementation, so a mutation to
the real formula in quota-resume.sh was never caught by the selftest (it only exercised its own
copy). Pulled out into its own script that quota-resume.sh calls, and that compute_backoff_sec
IS THIS backoff's math, not a mirror of it -- so a mutation to compute_backoff_sec, or a wrong
call here, breaks the selftest that drives this exact script.

`now` is injectable via QUOTA_PRECHECK_FAKE_NOW (same env var
sched-precheck-quota-reset-resume.sh honours) so the selftest can drive a fake clock without
faking the whole process's wall clock.
"""
import importlib.util
import json
import os
import sys
import time

STORE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("quota_switchback", os.path.join(STORE, "quota-switchback.py"))
quota_switchback = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(quota_switchback)


def main():
    backoff_path, early_probe = sys.argv[1], sys.argv[2] == "1"
    now = float(os.environ.get("QUOTA_PRECHECK_FAKE_NOW") or time.time())
    try:
        with open(backoff_path) as f:
            state = json.load(f)
    except (OSError, ValueError):
        state = {}
    if early_probe:
        # The early deadline-3min probe does not count toward the post-deadline backoff -- it
        # just marks itself spent so the precheck gate does not run it again before the deadline
        # actually passes.
        state["earlyProbeDone"] = True
        state.setdefault("consecutiveStillLimited", 0)
        state.setdefault("nextProbeAt", 0)
    else:
        n = state.get("consecutiveStillLimited", 0) + 1
        state["consecutiveStillLimited"] = n
        state["nextProbeAt"] = now + quota_switchback.compute_backoff_sec(n)
        state.setdefault("earlyProbeDone", True)
    tmp = backoff_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, backoff_path)


if __name__ == "__main__":
    main()
