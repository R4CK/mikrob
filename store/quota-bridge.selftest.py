#!/usr/bin/env python3
"""
quota-bridge.selftest.py -- does the recovery probe stay suppressed only when it is SAFE to?
(card cd7376ed)

WHAT PETI REPORTED: during a quota outage the Ghost handover message and the "MikroB is back"
message alternated every few minutes. One loop, not two bugs -- the recovery test is
`banner AND heartbeat-stale`, the heartbeat counts as fresh for 12 minutes, so one scheduled task
touching that file flips mikrob_down() to false, the loop announces recovery, resets the notified
flag, immediately re-detects the outage and announces the handover again. Two messages per flap,
no information in either.

THE ASYMMETRY THIS FILE DEFENDS, and the reason the cases are ordered the way they are:

  Suppressing the probe TOO LITTLE costs a message. That is the bug being fixed, and it is
  annoying rather than dangerous.

  Suppressing it TOO MUCH costs the real orchestrator: a Ghost latched on after MikroB is back
  holds the Telegram getUpdates slot, so Peti talks to a 7B model believing it is MikroB. Every
  case below where the answer is "probe" exists to make that outcome impossible on bad state --
  a missing file, unparseable JSON, a missing or non-numeric deadline, a deadline in the past, or
  one so far out it cannot belong to this outage.

So: exactly ONE input shape suppresses the probe (a numeric deadline, in the future, beyond the
window, within the trusted horizon). Everything else probes.
"""
import importlib.util
import json
import os
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PASS = 0
FAIL = 0


def ok(name):
    global PASS
    PASS += 1
    print(f"  ok   {name}")


def bad(name, detail=""):
    global FAIL
    FAIL += 1
    print(f"  FAIL {name}\n     {detail}")


def load_module():
    spec = importlib.util.spec_from_file_location("quota_bridge", HERE / "quota-bridge.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    print("quota-bridge selftest")
    try:
        m = load_module()
    except Exception as exc:  # noqa: BLE001 -- the selftest must report, not crash
        print(f"  FAIL could not import quota-bridge.py: {type(exc).__name__}: {exc}")
        print("\nselftest: 0 passed, 1 failed")
        return 1

    NOW = 1_800_000_000.0
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        cd = td / "countdown.json"
        m.COUNTDOWN_FILE = str(cd)

        def write(obj):
            cd.write_text(json.dumps(obj), encoding="utf-8")

        # --- the one suppressing shape -------------------------------------------------------
        write({"deadline": NOW + 3600})          # an hour out: well past the window, well inside trust
        if m.recovery_probe_due(NOW) is False:
            ok("a known deadline an hour out SUPPRESSES the probe (this is the fix)")
        else:
            bad("a known deadline an hour out suppresses the probe", "still probing")

        # --- everything else must probe ------------------------------------------------------
        if cd.exists():
            cd.unlink()
        if m.recovery_probe_due(NOW) is True:
            ok("no countdown file -> probe (today's behaviour preserved)")
        else:
            bad("no countdown file -> probe")

        cd.write_text("{not json", encoding="utf-8")
        if m.recovery_probe_due(NOW) is True:
            ok("unparseable countdown -> probe, never silence")
        else:
            bad("unparseable countdown -> probe")

        write({"note": "no deadline key here"})
        if m.recovery_probe_due(NOW) is True:
            ok("countdown without a deadline field -> probe")
        else:
            bad("countdown without a deadline field -> probe")

        write({"deadline": "2026-09-10T12:00:00Z"})   # a string, not epoch
        if m.recovery_probe_due(NOW) is True:
            ok("a non-numeric deadline -> probe (no string/number comparison crash)")
        else:
            bad("a non-numeric deadline -> probe")

        write({"deadline": NOW - 60})
        if m.recovery_probe_due(NOW) is True:
            ok("a deadline already past -> probe (the reset may have happened)")
        else:
            bad("a deadline already past -> probe")

        # The boundary, stated as a value rather than left implicit: at exactly the window edge the
        # probe runs. Off-by-one here would silence the last 3 minutes, which is the one stretch
        # where recovery is most likely.
        write({"deadline": NOW + m.RECOVERY_PROBE_WINDOW_SEC})
        if m.recovery_probe_due(NOW) is True:
            ok("exactly at the probe window edge -> probe")
        else:
            bad("exactly at the probe window edge -> probe")

        write({"deadline": NOW + m.RECOVERY_PROBE_WINDOW_SEC + 1})
        if m.recovery_probe_due(NOW) is False:
            ok("one second beyond the window -> suppressed (the boundary is where it is claimed)")
        else:
            bad("one second beyond the window -> suppressed")

        # A quota window is 5h05m; anything past the trusted horizon is stale or corrupt state, and
        # trusting it would hold the Ghost latched for hours.
        write({"deadline": NOW + m.COUNTDOWN_MAX_TRUSTED_SEC + 1})
        if m.recovery_probe_due(NOW) is True:
            ok("an implausibly distant deadline -> probe, not hours of silence")
        else:
            bad("an implausibly distant deadline -> probe")

        # MUST NOT RAISE. This function runs inside outage_loop's only exit path, so an exception
        # does not degrade to "probe anyway" -- it kills the loop holding Peti's channel and leaves
        # the Ghost dead mid-outage with the getUpdates slot claimed. Shapes JSON permits but the
        # arithmetic does not: a list, an object, null.
        for shape in ([1, 2], {"x": 1}, None):
            write({"deadline": shape})
            try:
                got = m.recovery_probe_due(NOW)
            except Exception as exc:  # noqa: BLE001
                bad(f"a {type(shape).__name__} deadline must not raise", f"{type(exc).__name__}: {exc}")
                break
            if got is not True:
                bad(f"a {type(shape).__name__} deadline -> probe", f"got {got}")
                break
        else:
            ok("list / object / null deadlines probe instead of raising (the loop survives)")

        # THE CASE THAT REACHES THE OUTER except, and the reason it is not decoration. Every shape
        # above is caught by an inner guard, so none of them proves the broad handler does anything
        # -- mutation testing showed exactly that: replacing `except Exception` with a narrower one
        # left the suite green. A file whose JSON ROOT is not an object is different: json.load()
        # succeeds, and `.get("deadline")` then raises AttributeError before any guard sees it.
        # That is a real state (a truncated or half-written file), and it must probe, not kill the
        # loop.
        cd.write_text("[1, 2, 3]", encoding="utf-8")
        try:
            got = m.recovery_probe_due(NOW)
        except Exception as exc:  # noqa: BLE001
            bad("a non-object JSON root must not raise", f"{type(exc).__name__}: {exc}")
        else:
            if got is True:
                ok("a non-object JSON root probes instead of raising (reaches the outer handler)")
            else:
                bad("a non-object JSON root -> probe", f"got {got}")

        # NOT ASSERTED, deliberately: the `isinstance(deadline, bool)` rejection in the source has
        # no observable effect. `True - now` is a large negative remaining, which lands on the same
        # `probe` answer the rejection produces, so a test for it passes with or without the guard
        # (mutation-verified). The guard stays for honest arithmetic; this suite does not claim to
        # prove it, because a case that passes either way proves nothing.

    print(f"\nselftest: {PASS} passed, {FAIL} failed")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
