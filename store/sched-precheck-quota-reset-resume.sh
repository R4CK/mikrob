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
#   - countdown, deadline ahead -> STATE:counting (silent) -> SKIP
#   - countdown, deadline due   -> the LLM run will resume  -> run LLM (empty out)
#
# Effect: the quota-reset-resume task only wakes the LLM when a reset is actually
# due, instead of every 15 min. quota-resume.sh is still the source of truth and
# is run by the LLM when this gate lets it through.
set -uo pipefail
CD="/home/neon/marveen/store/quota-reset-countdown.json"

# No active countdown -> nothing for the LLM to do.
[ -f "$CD" ] || { echo SKIP; exit 0; }

# Deadline still in the future -> counting, LLM would stay silent anyway.
due=$(python3 -c "import json,time;d=json.load(open('$CD'));print(1 if time.time()>=d.get('deadline',9e18) else 0)" 2>/dev/null || echo 0)
if [ "$due" != "1" ]; then echo SKIP; exit 0; fi

# Deadline reached: let the LLM run (it will execute quota-resume.sh, perform the
# Esc + agent restart, and on RESULT:RESUMED dispatch work + notify Peti).
# Empty stdout = "run LLM normally".
exit 0
