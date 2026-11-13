#!/usr/bin/env python3
"""
quota-switchback.py -- pure switch-back hysteresis + resume-backoff helpers (card 7f112c2f).

WHY: quota-bridge.log 2026-11-11 showed a 12 s flap (23:15:41 OUTAGE -> 23:15:53 recovered,
also 23:12/23:15): the old recovery check switched back the INSTANT a single probe looked
healthy, so a momentarily-clear banner bounced the channel back and forth. SWITCHBACK-HYSTERESIS-V1
(store/switchback-hysteresis.json) fixes this with one rule, applied identically by BOTH
quota-bridge.py (here) and src/gemini-fallback.ts (confirmSwitchback there) -- grep for
SWITCHBACK-HYSTERESIS-V1 to see both sides use it: switch back only after `confirmProbes`
CONSECUTIVE ok probes, with the oldest and newest of that trailing run at least `minGapSec`
apart. A single non-ok probe breaks the run; a single probe inside the gap window does not confirm.

Also covers (1) of the same card: quota-resume.sh retried the dashboard every 15 min flat with
no backoff once the deadline passed and the reset had not actually landed yet. compute_backoff_sec
gives 15 -> 30 -> 60 min (capped) based on how many STILL-LIMITED results have been seen in a row.

Every function here is pure (no clock, no filesystem, no network) except the one explicitly
marked I/O helper at the bottom (load_hysteresis_config) -- kept pure for exactly the reason
quota-bridge.py's own docstrings give for its fail-safe functions: this is the easiest code to
unit-test with a fake clock, and the hardest code to safely get wrong.

H1 (Cybersec NO-GO @f859c361b): this module used to also carry gpu_lock_held()/
wait_for_local_job(), used by quota-bridge.py's outage_loop() to wait for an in-flight local-LLM
draft before stopping the ghost runner. That wait only proved the GPU lock had cleared, not that
the runner's own `while true` loop had actually exited -- if it was still held after the 10 min
budget, the fix left the WHOLE loop running unmanaged forever (it never consults the outage
marker or its parent), which is worse than the flap it was meant to avoid. Replaced by a
stop-file the loop itself checks between ticks (gemini-ghost-runner.sh) plus waiting on the
actual process handle (quota-bridge.py's wait_for_ghost_exit) -- removed here rather than left
unused, since they were introduced by this same card and are now fully superseded.
"""
import json
import os
import time

STORE = os.path.dirname(os.path.abspath(__file__))
HYSTERESIS_CONFIG = f"{STORE}/switchback-hysteresis.json"

# Resume backoff (card 7f112c2f point 1): 15 -> 30 -> 60 min, capped. Only used AFTER the known
# reset deadline has already passed and a resume attempt came back STILL-LIMITED -- before the
# deadline, quota-resume.sh is not probed at all except the single deadline-3min early check
# (sched-precheck-quota-reset-resume.sh), so there is no "retry" to back off yet.
BACKOFF_BASE_SEC = 15 * 60
BACKOFF_CAP_SEC = 60 * 60
EARLY_PROBE_WINDOW_SEC = 180  # "deadline-3 min" early probe


def load_hysteresis_config(path=HYSTERESIS_CONFIG):
    """I/O: read the shared rule parameters. Missing/corrupt file -> the documented defaults
    (fail toward the OLD, safe-but-flappy behaviour is wrong here -- fail toward the hysteresis
    defaults instead, since those are what the rule name promises and a missing file is far more
    likely to mean "not deployed yet" than "disable the fix")."""
    try:
        with open(path) as f:
            raw = json.load(f)
        confirm_probes = int(raw.get("confirmProbes", 2))
        min_gap_sec = int(raw.get("minGapSec", 300))
        if confirm_probes < 1 or min_gap_sec < 0:
            raise ValueError("out of range")
        return confirm_probes, min_gap_sec
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return 2, 300


def record_probe(probe_log, ok, ts, max_len=20):
    """Append one probe result and trim. Returns a NEW list (no mutation of the caller's list),
    matching the pure-function style of the rest of this module."""
    new_log = list(probe_log) + [{"ok": bool(ok), "ts": float(ts)}]
    return new_log[-max_len:]


def confirm_switchback(probe_log, confirm_probes=2, min_gap_sec=300):
    """SWITCHBACK-HYSTERESIS-V1: True only when the trailing run of probes is ALL ok, that run
    has at least `confirm_probes` entries, and the oldest-to-newest span of that trailing ok-run
    is >= min_gap_sec. A single non-ok probe anywhere in the trailing window resets the run to
    zero (walking backward from the end and stopping at the first non-ok entry) -- this is what
    makes "OK, LIMITED, OK within 12s" fail: the LIMITED breaks the run, so there is only one
    trailing ok probe, which is < confirm_probes. Two back-to-back OK probes that are themselves
    only a few seconds apart ALSO fail, independently of the LIMITED case, because the span check
    below is < min_gap_sec.
    """
    if confirm_probes < 1:
        return False
    run = []
    for entry in reversed(probe_log):
        if not entry.get("ok"):
            break
        run.append(entry)
    if len(run) < confirm_probes:
        return False
    # run[0] is the newest, run[-1] is the oldest of the trailing ok streak.
    newest_ts = run[0]["ts"]
    oldest_ts = run[confirm_probes - 1]["ts"]
    return (newest_ts - oldest_ts) >= min_gap_sec


def compute_backoff_sec(consecutive_still_limited):
    """1st STILL-LIMITED -> 15 min, 2nd -> 30 min, 3rd+ -> 60 min (cap). `consecutive_still_limited`
    is the count INCLUDING the result that just happened (i.e. call this with 1 after the first
    STILL-LIMITED, not 0)."""
    if consecutive_still_limited < 1:
        return 0
    return min(BACKOFF_CAP_SEC, BACKOFF_BASE_SEC * (2 ** (consecutive_still_limited - 1)))


