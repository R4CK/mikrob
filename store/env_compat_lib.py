"""env_compat_get -- Python counterpart of store/env-compat-lib.sh's env_compat_get and
src/env-compat.ts's envCompatGet (card 22835648 round 4, Cybered NO-GO 28967 / QA correction
28970: store/gate-closure-check.py:649 and store/nmr-git-evidence.py:56 were still reading only
the retired CLEANCORE_* name directly, with no MOPSION_* fallback precedence at all).

Precedence, identical to the bash/TS siblings: NEW var wins if set to a non-empty value; else the
OLD (retired) var, with a warning to stderr; else the given default. See env-compat-lib.sh's own
header for why the warning is not de-duplicated across calls.
"""
import os
import sys


def env_compat_get(new_name: str, old_name: str, default_val: str = "") -> str:
    new_val = os.environ.get(new_name, "")
    if new_val:
        return new_val
    old_val = os.environ.get(old_name, "")
    if old_val:
        print(
            f"env-compat: ${old_name} is deprecated, use ${new_name} instead "
            "(still honoured as a fallback)",
            file=sys.stderr,
        )
        return old_val
    return default_val
