#!/usr/bin/env python3
"""Selftest for card 7f112c2f's Kesz-ha list. Fake-clock, no network/filesystem except the two
grep checks at the end. Run: python3 store/quota-switchback.selftest.py"""
import importlib.util
import os
import sys

STORE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("quota_switchback", f"{STORE}/quota-switchback.py")
qs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(qs)

passed = 0
failed = 0


def check(name, cond):
    global passed, failed
    if cond:
        passed += 1
        print(f"ok   {name}")
    else:
        failed += 1
        print(f"FAIL {name}")


# --- Kesz-ha 1: 3 consecutive STILL-LIMITED produce probe gaps 15/30/60 min (fake clock) -------
check("backoff 1st STILL-LIMITED = 15 min", qs.compute_backoff_sec(1) == 15 * 60)
check("backoff 2nd STILL-LIMITED = 30 min", qs.compute_backoff_sec(2) == 30 * 60)
check("backoff 3rd STILL-LIMITED = 60 min", qs.compute_backoff_sec(3) == 60 * 60)
check("backoff 4th STILL-LIMITED stays capped at 60 min", qs.compute_backoff_sec(4) == 60 * 60)
check("backoff with zero consecutive = 0 (no retry needed)", qs.compute_backoff_sec(0) == 0)

# --- Kesz-ha 2: OK, LIMITED, OK within 12 s does NOT switch back -------------------------------
t0 = 1_000_000.0
probe_log = []
probe_log = qs.record_probe(probe_log, ok=True, ts=t0)
probe_log = qs.record_probe(probe_log, ok=False, ts=t0 + 6)
probe_log = qs.record_probe(probe_log, ok=True, ts=t0 + 12)
check(
    "OK, LIMITED, OK within 12s does not confirm switch-back",
    qs.confirm_switchback(probe_log, confirm_probes=2, min_gap_sec=300) is False,
)

# Also: two back-to-back OK probes with NO limited between them, but too close in time, must
# also fail -- the gap check is independent of the "a non-ok probe breaks the run" check.
close_ok_log = [{"ok": True, "ts": t0}, {"ok": True, "ts": t0 + 12}]
check(
    "two consecutive OK probes 12s apart (no LIMITED between) does not confirm",
    qs.confirm_switchback(close_ok_log, confirm_probes=2, min_gap_sec=300) is False,
)

# Positive control: two OK probes genuinely >=5 min apart DOES confirm.
far_ok_log = [{"ok": True, "ts": t0}, {"ok": True, "ts": t0 + 301}]
check(
    "two consecutive OK probes >=5 min apart DOES confirm (positive control)",
    qs.confirm_switchback(far_ok_log, confirm_probes=2, min_gap_sec=300) is True,
)

# M3 (Cybersec NO-GO @f859c361b): a non-ok probe straddling a >=min_gap_sec span must still
# break the run. The 12s-flap case above is only rejected by the gap check (span < min_gap_sec
# either way); this case's span is >=300s, so only the "a non-ok probe resets the trailing run"
# logic (the `break`, not `continue`, in confirm_switchback) rejects it -- a mutant that lets a
# non-ok probe not reset the run passes the 12s case but wrongly confirms this one.
straddling_log = [
    {"ok": True, "ts": t0},
    {"ok": False, "ts": t0 + 150},
    {"ok": True, "ts": t0 + 310},
]
check(
    "OK, LIMITED, OK spanning >=300s straddling the LIMITED does not confirm (M3)",
    qs.confirm_switchback(straddling_log, confirm_probes=2, min_gap_sec=300) is False,
)

# --- Kesz-ha 4: quota-bridge.py and gemini-fallback-runner share the SAME confirmation rule -----
PY_SRC = f"{STORE}/quota-bridge.py"
TS_SRC = os.path.join(STORE, "..", "src", "gemini-fallback.ts")
with open(PY_SRC) as f:
    py_text = f.read()
with open(TS_SRC) as f:
    ts_text = f.read()
check("quota-bridge.py references SWITCHBACK-HYSTERESIS-V1", "SWITCHBACK-HYSTERESIS-V1" in py_text)
check("gemini-fallback.ts references SWITCHBACK-HYSTERESIS-V1", "SWITCHBACK-HYSTERESIS-V1" in ts_text)
check("quota-bridge.py imports quota_switchback (shared Python module)", "quota_switchback" in py_text)
check("gemini-fallback.ts implements confirmSwitchback (shared-rule mirror)", "confirmSwitchback" in ts_text)

print(f"\nquota-switchback.selftest: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
