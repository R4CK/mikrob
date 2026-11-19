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
import sys
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


def confirm_outage(probe_log, confirm_probes=2, min_gap_sec=45, max_age_sec=None, now=None):
    """ENTRY-SIDE mirror of confirm_switchback, for card f490ae53: a single mikrob_down()==True
    reading used to be enough (quota-bridge.py's old banner_streak counter had no minimum time
    span, only a consecutive-count), and a 2026-11-18 quota-bridge.log flap (SIGTERM at 21:52:31,
    "MikroB recovered" 4s later at 21:52:35, repeated many times that day) showed that count alone
    does not bound real elapsed time -- a process restart between two polls can produce two
    "down" readings a fraction of a second apart. True only when the trailing run of probes is
    ALL down (ok=False), that run has at least `confirm_probes` entries, and the oldest-to-newest
    span of that trailing down-run is >= min_gap_sec. A single ok=True probe anywhere in the
    trailing window resets the run to zero, exactly like confirm_switchback -- so a down-then-up
    flap of any length never confirms, independent of the gap check.

    F1b (Cybersec NO-GO 33392/33574, Cybered NO-GO 33404/33576): without `max_age_sec`, a
    probe_log persisted across a process restart (or a long gap in polling) can carry one down
    reading from hours or days earlier plus ONE fresh down reading -- the span between them
    trivially satisfies min_gap_sec, so the stale reading alone supplies the "confirm_probes-th"
    entry the fresh reading needs, confirming on data that is no longer evidence of a CURRENT
    outage. When `max_age_sec` is given, entries dropped from the trailing run BEFORE the
    count/span check are the ones whose age (relative to `now`, default time.time()) falls
    OUTSIDE [0, max_age_sec] -- too old, so a stale entry can no longer stand in for a missing
    fresh one; OR appearing to be in the future, because `time.time()` is not monotonic and a
    backward clock step (NTP correction, resume-from-suspend) would otherwise make an old entry's
    (now - ts) go NEGATIVE, which is "<= max_age_sec" and would wrongly un-expire it forever
    (Cybered NO-GO 33576 item 4, reproduced: a 1h step either direction between two down readings
    confirmed). Rejecting age < 0 too closes that: a timestamp the current clock thinks is in the
    future is exactly as untrustworthy as one that is stale."""
    if confirm_probes < 1:
        return False
    run = []
    for entry in reversed(probe_log):
        if entry.get("ok"):
            break
        run.append(entry)
    if max_age_sec is not None:
        now = time.time() if now is None else now
        run = [entry for entry in run if 0 <= (now - entry["ts"]) <= max_age_sec]
    if len(run) < confirm_probes:
        return False
    newest_ts = run[0]["ts"]
    oldest_ts = run[confirm_probes - 1]["ts"]
    return (newest_ts - oldest_ts) >= min_gap_sec


# F2 (Cybersec NO-GO 33392/33574): sane bounds for the entry-side confirm config. Outside these,
# the value is not trusted (clamped TO THE DEFAULTS, not to the boundary) -- a value this far off
# is treated the same as a missing/corrupt file, not as a deliberately extreme but valid setting.
OUTAGE_CONFIRM_PROBES_BOUNDS = (2, 10)
OUTAGE_MIN_GAP_SEC_BOUNDS = (15, 3600)


def load_outage_confirm_config(path=HYSTERESIS_CONFIG):
    """I/O: entry-side (outage-DECLARATION) confirm-over-N-probes config, same file as
    load_hysteresis_config, different keys (confirmProbesIn/minGapSecIn) so one file documents
    both directions of the same rule. Defaults reproduce quota-bridge.py's pre-fix intent:
    CONFIRM_CHECKS=2 consecutive checks, POLL_HEALTHY_SEC=45s apart -- i.e. the two numbers the
    old code already used, just with an explicit minimum real-time span instead of a bare count.

    F2 (Cybersec NO-GO 33392/33574): the entry-side values gate a kill of the live Telegram
    poller, so a malformed or hostile switchback-hysteresis.json must neither crash the bridge
    at startup (an uncaught OverflowError/AttributeError here means quota-bridge.py dies in
    main() before the loop, so there is no fallback takeover during a real outage) nor be
    accepted outside a sane window (confirmProbesIn=1/minGapSecIn=0 reintroduces kill-on-first-
    probe by one edited number; 10**30 for either means an outage is never declared). Any
    exception (bad JSON, non-dict root, oversized/negative/non-numeric values -- including
    OverflowError from int(1e999) and AttributeError from a non-dict root) or an out-of-bounds
    result falls back to the documented defaults (2, 45), with a warning on stderr so a
    misconfigured file is visible without crash-looping."""
    try:
        with open(path) as f:
            raw = json.load(f)
        if not isinstance(raw, dict):
            raise ValueError("config root is not a JSON object")
        confirm_probes = int(raw.get("confirmProbesIn", 2))
        min_gap_sec = int(raw.get("minGapSecIn", 45))
    except Exception as exc:
        print(f"quota-switchback: {path} unreadable/malformed for outage-confirm config "
              f"({exc!r}) -- falling back to defaults (2, 45)", file=sys.stderr)
        return 2, 45
    lo_p, hi_p = OUTAGE_CONFIRM_PROBES_BOUNDS
    lo_g, hi_g = OUTAGE_MIN_GAP_SEC_BOUNDS
    if not (lo_p <= confirm_probes <= hi_p) or not (lo_g <= min_gap_sec <= hi_g):
        print(f"quota-switchback: outage-confirm config out of sane bounds "
              f"(confirmProbesIn={confirm_probes}, minGapSecIn={min_gap_sec}; expected "
              f"{lo_p}..{hi_p} and {lo_g}..{hi_g}) -- falling back to defaults (2, 45)",
              file=sys.stderr)
        return 2, 45
    return confirm_probes, min_gap_sec


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


