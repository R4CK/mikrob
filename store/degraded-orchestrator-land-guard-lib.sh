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

# Card 2ba008f2 (WhiteHat2 probe on origin/develop, round 3): the --actor mikrob bypass below is
# self-declared, just like src/kanban-force-actors.ts's isForceActor() -- same shared-token
# caller can send it. That module already refuses the bypass outright while a session outage is
# active (store/mikrob-session-outage.json), regardless of the switch's own state; this ports the
# SAME check here so the bash landers cannot grant via --actor what the TS guard now denies via
# force+actor. Mirrors isSessionOutageActive() field-for-field (active/heartbeat, same staleness
# and future-skew windows, same fail-closed-on-malformed rule) -- not imported (bash cannot import
# a TS module), kept in exact lockstep the same way the switch-file contract above already is.
_MIKROB_SESSION_OUTAGE_PATH="${MIKROB_SESSION_OUTAGE_PATH:-/home/neon/marveen/store/mikrob-session-outage.json}"
# Round 4 (CYBERSEC NO-GO 32558 F1, Fix-Direction): the previous version read the subprocess exit
# code as `[ $? = 0 ]` -- ONLY an exact python exit 0 meant "active". Exit 1 was the intended
# "normal" signal, but EVERY other outcome (an uncaught exception default exit 1, a kill 137, a
# segfault 139, a failed interpreter start from a bad PYTHONHOME, rc 127) ALSO fell into "not
# active", wrongly granting the --actor mikrob bypass on a crash. Sentinel-based now, same shape
# as degraded_orchestrator_is_on's own three-valued read a few lines up: ONLY a dedicated,
# unlikely-to-collide sentinel exit code (3, not 0 or 1, which real crashes commonly produce)
# means "normal" (not active); everything else -- the explicit fail-closed exit 0, a plain
# exception's default exit 1, or any crash code -- means active (deny the bypass). The whole body
# is wrapped in try/except BaseException so nothing can escape as an unsentineled exit. `-I`
# (isolated mode) stops a cwd-local json.py or stray PYTHON* env var from shadowing the stdlib
# modules this depends on.
_session_outage_active() {
  # Same posture as degraded_orchestrator_is_on: if the check cannot run at all, that is not
  # "verified inactive" -- fail closed (deny the bypass). degraded_orchestrator_is_on's own
  # python3-missing fail-closed-to-ON below makes the die() fire either way in that case.
  command -v python3 >/dev/null 2>&1 || return 0
  python3 -I -c '
import sys

def main():
    import json, time
    try:
        with open(sys.argv[1]) as f:
            raw = f.read()
    except FileNotFoundError:
        sys.exit(3)  # no marker: normal operation (sentinel)
    except Exception:
        sys.exit(0)  # exists but unreadable: fail closed
    try:
        data = json.loads(raw)
    except Exception:
        sys.exit(0)  # corrupt/empty: fail closed
    if not isinstance(data, dict):
        sys.exit(0)
    active = data.get("active")
    if not isinstance(active, bool):
        sys.exit(0)  # malformed active field: fail closed
    if active is False:
        sys.exit(3)  # explicitly inactive: normal operation (sentinel)
    heartbeat = data.get("heartbeat")
    if not isinstance(heartbeat, (int, float)) or isinstance(heartbeat, bool):
        sys.exit(0)  # malformed heartbeat: fail closed
    MIN_H, MAX_H = 1_600_000_000, 4_000_000_000
    if heartbeat < MIN_H or heartbeat > MAX_H:
        sys.exit(0)  # implausible value (e.g. ms instead of s): fail closed
    age_ms = (time.time() - heartbeat) * 1000
    STALE_MS, FUTURE_TOLERANCE_MS = 15 * 60 * 1000, 60 * 1000
    if age_ms > STALE_MS:
        sys.exit(3)  # genuinely stale: normal operation resumes (sentinel)
    if age_ms < -FUTURE_TOLERANCE_MS:
        sys.exit(3)  # modest clock skew beyond tolerance: normal operation (sentinel)
    sys.exit(0)  # fresh and active: fence holds

try:
    main()
except SystemExit:
    raise  # the sentinel/fail-closed exits FROM main() itself must propagate untouched
except BaseException:
    sys.exit(0)  # anything unforeseen escaping main(): fail closed, never silently "normal"
' "$_MIKROB_SESSION_OUTAGE_PATH"
  local rc=$?
  [ "$rc" = 3 ] && return 1
  return 0
}

check_degraded_orchestrator_guard() { # $1 = actor (may be empty)
  local actor="${1:-}"
  if [ "$actor" = "mikrob" ] && ! _session_outage_active; then
    return 0
  fi
  if degraded_orchestrator_is_on; then
    die 3 "degraded-orchestrator mode is ON ($DEGRADED_ORCHESTRATOR_SWITCH) -- landing is not allowed while degraded (card d5638d28). Owner override: --actor mikrob."
  fi
}
