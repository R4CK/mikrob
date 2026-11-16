#!/usr/bin/env bash
# Card d5638d28 round 2 LOW (CYBERED NO-GO 32207, MikroB Fix-Direction 32209): shared helper so
# mopsion-land.sh and mopsi-land.sh can run the SAME degraded-orchestrator kill-switch check
# store/marveen-land.sh runs, without a second hand-copied implementation (the incident this card
# exists to fix, scoped down -- a copy that drifts is exactly how the TS/bash split RedHat
# measured for F3 happened in the first place). Meant to be sourced, not executed.
#
# The switch file is the MikroB fleet's OWN store path, not any caller's $MAIN -- the switch is
# about the fleet orchestrator being degraded (quota-out), not about the product repo being
# landed. DEGRADED_ORCHESTRATOR_SWITCH env override matches marveen-land.sh and the TS guard
# (degradedOrchestratorSwitchPath() in src/degraded-orchestrator-guard.ts) so a test can point all
# three at the same temp fixture.
# Round 3 (CYBERED NO-GO 32245 F1, MikroB decision 32246, same fix as marveen-land.sh's own
# inline copy): capture whether the caller explicitly set this env var, BEFORE applying the
# default. Kesz ha #1 now reads: "default path absent = OFF; explicit override to a missing path
# = refuse; override to {"enabled": false} = OFF".
_DEGRADED_ORCHESTRATOR_SWITCH_OVERRIDE_SET=0
[ -n "${DEGRADED_ORCHESTRATOR_SWITCH:-}" ] && _DEGRADED_ORCHESTRATOR_SWITCH_OVERRIDE_SET=1
DEGRADED_ORCHESTRATOR_SWITCH="${DEGRADED_ORCHESTRATOR_SWITCH:-/home/neon/marveen/store/degraded-orchestrator-enabled.json}"

degraded_orchestrator_is_on() {
  # python3 missing from PATH means this check CANNOT RUN AT ALL -- the old code let a 127
  # (command not found) from the subprocess below propagate as this function's own nonzero exit,
  # which the caller read as "not on", landing proceeded. Every way the check cannot run is
  # degraded, same posture as the unreadable/corrupt file case below.
  command -v python3 >/dev/null 2>&1 || return 0
  if [ ! -e "$DEGRADED_ORCHESTRATOR_SWITCH" ]; then
    [ "$_DEGRADED_ORCHESTRATOR_SWITCH_OVERRIDE_SET" = 1 ] && return 0 # explicit override to nowhere: can't verify, fail closed (ON)
    return 1 # default path never written: legit OFF (Kesz ha #1)
  fi
  python3 -c '
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
except Exception:
    sys.exit(0)  # unreadable/corrupt: fail closed, treat as ON
if not isinstance(data, dict) or list(data.keys()) != ["enabled"] or not isinstance(data["enabled"], bool):
    sys.exit(0)  # wrong shape/type/extra/typo key: same fail-closed rule as the TS guard
sys.exit(0 if data["enabled"] else 1)
' "$DEGRADED_ORCHESTRATOR_SWITCH"
  # Round 3 (RedHat 32245 F1): three-valued read on the subprocess's own exit code -- ONLY an
  # explicit exit 1 (the python script's own `sys.exit(1)` for a confirmed {"enabled": false})
  # means OFF. Anything else (0 explicit ON, or an unexpected 126/127/139/etc from python3 itself
  # crashing/being killed) means ON, so a corrupted interpreter state cannot silently read as OFF
  # the way a bare nonzero-vs-zero check would.
  [ $? = 1 ] && return 1
  return 0
}

check_degraded_orchestrator_guard() { # $1 = actor (may be empty)
  local actor="${1:-}"
  [ "$actor" = "mikrob" ] && return 0
  if degraded_orchestrator_is_on; then
    die 3 "degraded-orchestrator mode is ON ($DEGRADED_ORCHESTRATOR_SWITCH) -- landing is not allowed while degraded (card d5638d28). Owner override: --actor mikrob."
  fi
}
