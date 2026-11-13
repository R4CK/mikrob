#!/usr/bin/env bash
# Pre-check gate for the `quota-reset-resume` scheduled task.
#
# The scheduler calls this via the task's `preCheck` field BEFORE waking the LLM.
# Protocol (see src/web/schedule-runner.ts runPreCheck):
#   stdout == "SKIP"  -> scheduler skips the LLM entirely (no context reload)
#   stdout non-empty  -> LLM runs with stdout as context prefix
#   stdout empty / non-zero exit -> fail-open, LLM runs normally
#
# This gate is READ-ONLY: it must NOT perform the resume itself (that has side
# effects and would clear the countdown, so the subsequent LLM run would see
# no-countdown and stay silent instead of dispatching + notifying). It only
# mirrors quota-resume.sh's own STATE decision from the countdown file:
#   - no countdown file        -> nothing to resume        -> SKIP
#   - countdown, deadline ahead, outside the early-probe window -> SKIP
#   - countdown, within EARLY_PROBE_WINDOW_SEC of deadline, early probe not
#     yet attempted this outage -> run LLM (one early probe, card 7f112c2f pt.1)
#   - countdown, deadline due, but a resume-backoff is still pending -> SKIP
#   - countdown, deadline due, backoff elapsed (or no backoff yet) -> run LLM
#
# Effect: the quota-reset-resume task wakes the LLM only once at deadline-3min,
# and then on a 15 -> 30 -> 60 min (capped) backoff after each STILL-LIMITED
# result once the deadline has actually passed -- not every 15 min flat
# (card 7f112c2f point 1; see store/quota-switchback.py's compute_backoff_sec,
# and quota-resume.sh, which writes store/quota-resume-backoff.json after each
# attempt). quota-resume.sh is still the source of truth and is run by the LLM
# when this gate lets it through.
set -uo pipefail
STORE="/home/neon/marveen/store"
CD="$STORE/quota-reset-countdown.json"
BACKOFF="$STORE/quota-resume-backoff.json"

# No active countdown -> nothing for the LLM to do.
[ -f "$CD" ] || { echo SKIP; exit 0; }

decision=$(python3 - "$CD" "$BACKOFF" <<'PY' 2>/dev/null
import json, sys, time
cd_path, backoff_path = sys.argv[1], sys.argv[2]
EARLY_PROBE_WINDOW_SEC = 180

try:
    with open(cd_path) as f:
        cd = json.load(f)
    deadline = cd.get("deadline", 9e18)
except (OSError, ValueError):
    print("SKIP"); sys.exit(0)

now = time.time()
remaining = deadline - now

try:
    with open(backoff_path) as f:
        backoff = json.load(f)
    next_probe_at = backoff.get("nextProbeAt", 0)
    early_probe_done = backoff.get("earlyProbeDone", False)
except (OSError, ValueError):
    next_probe_at, early_probe_done = 0, False

if remaining > EARLY_PROBE_WINDOW_SEC:
    print("SKIP")
elif remaining > 0:
    # Within the early-probe window, deadline not yet reached: one probe allowed.
    print("SKIP" if early_probe_done else "RUN")
else:
    # Deadline reached or passed: gated by backoff only (the early probe is spent).
    print("SKIP" if now < next_probe_at else "RUN")
PY
)
[ "$decision" = "RUN" ] || { echo SKIP; exit 0; }

# Let the LLM run (it will execute quota-resume.sh, perform the Esc + agent
# restart, and on RESULT:RESUMED dispatch work + notify Peti). Empty stdout =
# "run LLM normally".
exit 0
