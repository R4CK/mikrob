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

Every function here is pure (no clock, no filesystem, no network) except the two explicitly
marked I/O helpers at the bottom (load_hysteresis_config, gpu_lock_held) -- kept pure for exactly
the reason quota-bridge.py's own docstrings give for its fail-safe functions: this is the easiest
code to unit-test with a fake clock, and the hardest code to safely get wrong.
"""
import json
import os
import subprocess
import time

STORE = os.path.dirname(os.path.abspath(__file__))
HYSTERESIS_CONFIG = f"{STORE}/switchback-hysteresis.json"
GPU_LOCK_DEFAULT = "/tmp/local-llm-gpu.lock"

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


def gpu_lock_held(lock_path=GPU_LOCK_DEFAULT):
    """I/O: True if another process currently holds the local-llm GPU flock (store/local-llm.sh's
    GEN_CMD wraps its ollama call in `flock "$GPU_LOCK"`). Non-blocking probe via the same `flock`
    binary the generation path uses, so this never contends for or waits on the lock itself.
    A missing lock FILE (nothing has ever generated) is not held."""
    if not os.path.exists(lock_path):
        return False
    try:
        r = subprocess.run(["flock", "-n", lock_path, "true"], capture_output=True, timeout=5)
        return r.returncode != 0
    except (OSError, subprocess.TimeoutExpired):
        # Cannot determine -> assume held (fail toward NOT interrupting a possibly-running job).
        return True


def wait_for_local_job(max_wait_sec=600, poll_sec=2, lock_path=GPU_LOCK_DEFAULT,
                        sleep_fn=time.sleep, now_fn=time.time, held_fn=None):
    """Card 7f112c2f point 3: poll up to max_wait_sec for the GPU lock to clear. Returns True if
    it cleared in time, False if it is still held after max_wait_sec (caller must then NOT kill
    the holder -- "continues in background"). `held_fn`/`sleep_fn`/`now_fn` are injection points
    for the selftest's fake clock; production calls use the real gpu_lock_held/time.sleep/time.time."""
    held_fn = held_fn or (lambda: gpu_lock_held(lock_path))
    deadline = now_fn() + max_wait_sec
    while held_fn() and now_fn() < deadline:
        sleep_fn(poll_sec)
    return not held_fn()
