#!/usr/bin/env bash
# Periodic tick for the load-guard state machine (card edd8b398, Feladat 1's systemd wiring).
# Invoked by the mikrob-load-guard.timer every 5-10s (a heartbeat's ~10min cron-cadence would be
# far too slow for a load spike). Runs load-guard-eval.sh once and appends to store/load-guard.log
# ONLY on a state CHANGE -- logging every tick at a 5-10s cadence would flood the file for no
# reason (matches the dashboard-watchdog/channel-watchdog convention of quiet-unless-notable).
#
# --config/--state/--metrics-json/--now/--log are test-only overrides (passed straight through to
# load-guard-eval.sh except --log); production invocations pass none of them, EXCEPT --cgroup.
#
# --cgroup (card d7a28a0a, Feladat 2 of 19f3bbb5): opt-in, OFF by default. When passed, every tick
# (not just on a state CHANGE -- the throttle must apply/release continuously while the confirmed
# state stays "hard", not only at the transition edge) also calls load-guard-cgroup.sh with the
# tick's own already-computed action, best-effort (a cgroup-layer failure never breaks this
# daemon's Feladat-1 log_only/stop_new_dispatch layer, which is why it's `|| true`). Opt-in and
# not a bash-level default specifically so the EXISTING Feladat-1 daemon tests (which call this
# script without --cgroup) stay byte-identical -- zero regression risk. Production turns it on via
# scripts/install-guard-timers.sh's ExecStart, not this script's default.
#
# --sigstop (card 2bfbf805, Feladat 3 of 19f3bbb5): same opt-in shape as --cgroup, independent
# flag -- either can run without the other. Every tick also calls load-guard-sigstop.sh with the
# tick's own action, best-effort (`|| true`, same reasoning as --cgroup: a signal-layer failure
# never breaks the lower tiers). "critical" only fires once "hard" (cgroup_throttle) has already
# been sustained and load STILL climbed past it, so --cgroup and --sigstop are meant to run
# together in production, not as alternatives.
#
# --bookkeeping (card 1128002b, Feladat 4 of 19f3bbb5): same opt-in shape again, runs LAST (after
# --cgroup/--sigstop, best-effort) so it reads this tick's freshly-written throttle/freeze state,
# not last tick's. Maintains store/load-paused-agents.json (consulted by store/redispatch-guard.sh
# and the stuck-card-monitor scheduled task so a paused agent's card is never mistaken for stuck),
# posts PAUSED-LOAD/RESUMED-LOAD kanban comments on transitions, and alerts Telegram only for
# repeated pausing of the same agent -- see load-guard-bookkeeping.sh's own header for the detail.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$INSTALL_DIR/store/load-guard.log"
EVAL_ARGS=()
CGROUP=0
SIGSTOP=0
BOOKKEEPING=0

while [ $# -gt 0 ]; do
  case "$1" in
    --log) LOG="$2"; shift 2 ;;
    --cgroup) CGROUP=1; shift ;;
    --sigstop) SIGSTOP=1; shift ;;
    --bookkeeping) BOOKKEEPING=1; shift ;;
    --config|--state|--metrics-json|--now) EVAL_ARGS+=("$1" "$2"); shift 2 ;;
    *) echo "load-guard-daemon.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# Cybersec NO-GO (card 2bfbf805, Gate-SHA a68c5ce8): under `set -e`, a failing load-guard-eval.sh
# (e.g. a corrupted/half-written load-guard-config.json -- the SAME file --sigstop's own kill-switch
# reads every tick) used to kill this script BEFORE it ever reached --cgroup/--sigstop below, even
# though those calls are already `|| true`-protected. That meant a persistently-failing eval step
# could leave a SIGSTOP-frozen process frozen past its own 90s cap -- the daemon just stopped
# ticking, so the cap-check code inside load-guard-sigstop-apply.sh never got to run at all. This
# degrades to the SAFEST action (log_only) instead of dying, which is enough on its own: any action
# other than "sigstop_freeze"/"cgroup_throttle" already RELEASES a held pid/scope on the very next
# tick (load-guard-sigstop-apply.sh's own "prev_pid != desired_pid" branch), independent of whether
# 90s have actually elapsed -- restoring the "release is independent of load" guarantee the card
# already promised, without needing eval.sh itself to succeed.
if ! RESULT=$("$INSTALL_DIR/store/load-guard-eval.sh" "${EVAL_ARGS[@]}"); then
  RESULT='{"changed": false, "action": "log_only", "state": "watch", "since": 0}'
fi
CHANGED=$(printf '%s' "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['changed'])")
ACTION=$(printf '%s' "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['action'])")

if [ "$CHANGED" = "True" ]; then
  echo "$(ts) $RESULT" >> "$LOG"
fi

if [ "$CGROUP" = "1" ]; then
  "$INSTALL_DIR/store/load-guard-cgroup.sh" --action "$ACTION" || true
fi

if [ "$SIGSTOP" = "1" ]; then
  "$INSTALL_DIR/store/load-guard-sigstop.sh" --action "$ACTION" || true
fi

if [ "$BOOKKEEPING" = "1" ]; then
  "$INSTALL_DIR/store/load-guard-bookkeeping.sh" || true
fi
