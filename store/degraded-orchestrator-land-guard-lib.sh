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
DEGRADED_ORCHESTRATOR_SWITCH="${DEGRADED_ORCHESTRATOR_SWITCH:-/home/neon/marveen/store/degraded-orchestrator-enabled.json}"

degraded_orchestrator_is_on() {
  [ -e "$DEGRADED_ORCHESTRATOR_SWITCH" ] || return 1
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
}

check_degraded_orchestrator_guard() { # $1 = actor (may be empty)
  local actor="${1:-}"
  [ "$actor" = "mikrob" ] && return 0
  if degraded_orchestrator_is_on; then
    die 3 "degraded-orchestrator mode is ON ($DEGRADED_ORCHESTRATOR_SWITCH) -- landing is not allowed while degraded (card d5638d28). Owner override: --actor mikrob."
  fi
}
