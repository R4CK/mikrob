#!/usr/bin/env python3
"""Self-test for telegram_progress_watchdog.py's env-tunable thresholds.

Run:  python3 scripts/hooks/telegram_progress_watchdog.selftest.py
Exit: 0 = all pass, 1 = at least one case wrong.

Card dadeab30 (RedHat/QA gate question #3): WEDGED_SEC was the only one of the three
age thresholds hardcoded in the module instead of going through _env_int(), so a live
install could tune wedged_up_sec()/stale_sec() but not the blunt backstop itself. This
pins that wedged_sec() now reads TELEGRAM_WATCHDOG_WEDGED_SEC the same way its siblings
read their own env vars, falls back to the original 900s default, and ignores garbage.
"""
import importlib.util
import os
import sys
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("telegram_progress_watchdog.py")
spec = importlib.util.spec_from_file_location("telegram_progress_watchdog", MODULE_PATH)
wd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wd)

failures = []


def check(label, got, want):
    if got != want:
        failures.append(f"{label}: got {got!r}, want {want!r}")


ENV_VAR = "TELEGRAM_WATCHDOG_WEDGED_SEC"
saved = os.environ.pop(ENV_VAR, None)
try:
    check("default (no env)", wd.wedged_sec(), wd.DEFAULT_WEDGED_SEC)
    check("default value is 900s", wd.DEFAULT_WEDGED_SEC, 15 * 60)

    os.environ[ENV_VAR] = "60"
    check("env override", wd.wedged_sec(), 60)

    os.environ[ENV_VAR] = "0"
    check("zero rejected, falls back to default", wd.wedged_sec(), wd.DEFAULT_WEDGED_SEC)

    os.environ[ENV_VAR] = "not-a-number"
    check("garbage rejected, falls back to default", wd.wedged_sec(), wd.DEFAULT_WEDGED_SEC)

    os.environ[ENV_VAR] = "-30"
    check("negative rejected, falls back to default", wd.wedged_sec(), wd.DEFAULT_WEDGED_SEC)
finally:
    if saved is None:
        os.environ.pop(ENV_VAR, None)
    else:
        os.environ[ENV_VAR] = saved

if failures:
    for f in failures:
        print(f"FAIL: {f}")
    sys.exit(1)
print(f"OK: {5} cases passed")
