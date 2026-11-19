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

# --- card f490ae53: confirm_outage() mirrors confirm_switchback for the ENTRY (outage-declare)
# --- direction. Same flap shape as the quota-bridge.log evidence: a down reading followed by an
# --- up reading 4s later must NOT confirm, regardless of count. ------------------------------
t1 = 2_000_000.0
flap_log = []
flap_log = qs.record_probe(flap_log, ok=False, ts=t1)        # down
flap_log = qs.record_probe(flap_log, ok=True, ts=t1 + 4)      # up 4s later (the 21:52:31/:35 flap)
check(
    "down then up 4s later does not confirm an outage (card f490ae53 flap replay)",
    qs.confirm_outage(flap_log, confirm_probes=2, min_gap_sec=45) is False,
)

# Two down readings close together (e.g. a fast process-restart edge) must also fail: count alone
# is not enough, the real-time span matters.
close_down_log = [{"ok": False, "ts": t1}, {"ok": False, "ts": t1 + 1}]
check(
    "two down readings 1s apart does not confirm an outage (count without a real gap)",
    qs.confirm_outage(close_down_log, confirm_probes=2, min_gap_sec=45) is False,
)

# Positive control: a genuinely sustained outage (down readings spanning >= min_gap_sec, none
# interrupted by an up reading) DOES confirm.
sustained_down_log = [{"ok": False, "ts": t1}, {"ok": False, "ts": t1 + 46}]
check(
    "two down readings >=45s apart, no up reading between, DOES confirm (positive control)",
    qs.confirm_outage(sustained_down_log, confirm_probes=2, min_gap_sec=45) is True,
)

# A single up reading anywhere in the trailing window breaks the run, even when the overall span
# would otherwise satisfy the gap -- mirrors M3's straddling case for confirm_switchback.
straddling_down_log = [
    {"ok": False, "ts": t1},
    {"ok": True, "ts": t1 + 20},
    {"ok": False, "ts": t1 + 50},
]
check(
    "down, up, down spanning >=45s straddling the up reading does not confirm",
    qs.confirm_outage(straddling_down_log, confirm_probes=2, min_gap_sec=45) is False,
)

check(
    "load_outage_confirm_config() defaults to (2, 45) on a missing/corrupt file",
    qs.load_outage_confirm_config("/nonexistent/path.json") == (2, 45),
)

# --- F1b (Cybersec NO-GO 33392/33574): a stale down reading from hours earlier plus ONE fresh
# --- down reading must NOT confirm once max_age_sec bounds the run -- the stale entry is dropped,
# --- leaving only one recent reading, which is < confirm_probes. -------------------------------
t2 = 3_000_000.0
stale_plus_fresh_log = [
    {"ok": False, "ts": t2 - 3 * 3600},   # 3h-old down reading (e.g. survived a process restart)
    {"ok": False, "ts": t2},               # one fresh down reading
]
check(
    "WITHOUT max_age_sec, a 3h-old reading + one fresh reading still confirms (shows the bug "
    "max_age_sec exists to close)",
    qs.confirm_outage(stale_plus_fresh_log, confirm_probes=2, min_gap_sec=45, now=t2) is True,
)
check(
    "F1b: WITH max_age_sec=450, a 3h-old reading + one fresh reading does NOT confirm (the "
    "stale entry is dropped, leaving only 1 recent down reading)",
    qs.confirm_outage(stale_plus_fresh_log, confirm_probes=2, min_gap_sec=45,
                       max_age_sec=450, now=t2) is False,
)

# Positive control: max_age_sec must not break a genuinely sustained, RECENT outage.
recent_sustained_log = [{"ok": False, "ts": t2 - 46}, {"ok": False, "ts": t2}]
check(
    "F1b positive control: two down readings 46s apart, both within max_age_sec=450, "
    "still confirms",
    qs.confirm_outage(recent_sustained_log, confirm_probes=2, min_gap_sec=45,
                       max_age_sec=450, now=t2) is True,
)

# --- F2 (Cybersec NO-GO 33392/33574): hostile/malformed switchback-hysteresis.json must not
# --- crash load_outage_confirm_config() (startup would crash-loop the bridge) and must not be
# --- accepted outside the sane window -- both fall back to the defaults (2, 45). --------------
import json as _json
import tempfile as _tempfile


def _load_outage_cfg_from(obj_or_text):
    with _tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        if isinstance(obj_or_text, str):
            f.write(obj_or_text)
        else:
            _json.dump(obj_or_text, f)
        path = f.name
    try:
        return qs.load_outage_confirm_config(path)
    finally:
        os.unlink(path)


check(
    "F2: confirmProbesIn=1e999 (OverflowError on int()) does not crash, falls back to (2, 45)",
    _load_outage_cfg_from({"confirmProbesIn": 1e999, "minGapSecIn": 45}) == (2, 45),
)
check(
    "F2: minGapSecIn=-1e999 (OverflowError on int()) does not crash, falls back to (2, 45)",
    _load_outage_cfg_from({"confirmProbesIn": 2, "minGapSecIn": -1e999}) == (2, 45),
)
check(
    "F2: a top-level JSON list (AttributeError on .get()) does not crash, falls back to (2, 45)",
    _load_outage_cfg_from("[1, 2, 3]") == (2, 45),
)
check(
    "F2: a top-level JSON string does not crash, falls back to (2, 45)",
    _load_outage_cfg_from('"not an object"') == (2, 45),
)
check(
    "F2: a top-level JSON number does not crash, falls back to (2, 45)",
    _load_outage_cfg_from("42") == (2, 45),
)
check(
    "F2: a top-level JSON null does not crash, falls back to (2, 45)",
    _load_outage_cfg_from("null") == (2, 45),
)
check(
    "F2: the weakest accepted value {confirmProbesIn:1, minGapSecIn:0} (kill-on-first-probe by "
    "one edited number) is now out of bounds, falls back to (2, 45)",
    _load_outage_cfg_from({"confirmProbesIn": 1, "minGapSecIn": 0}) == (2, 45),
)
check(
    "F2: confirmProbesIn=10**30 (outage never declared) is out of bounds, falls back to (2, 45)",
    _load_outage_cfg_from({"confirmProbesIn": 10 ** 30, "minGapSecIn": 45}) == (2, 45),
)
check(
    "F2: minGapSecIn=10**30 (outage never declared) is out of bounds, falls back to (2, 45)",
    _load_outage_cfg_from({"confirmProbesIn": 2, "minGapSecIn": 10 ** 30}) == (2, 45),
)
check(
    "F2 positive control: a valid in-bounds config is used as-is, not clamped away",
    _load_outage_cfg_from({"confirmProbesIn": 3, "minGapSecIn": 60}) == (3, 60),
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
