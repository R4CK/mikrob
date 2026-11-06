#!/usr/bin/env bash
# Self-test for land-run-journal.sh + land-run-stale-check.sh (card 88b67fb4, requirement 2+3).
# Uses a throwaway journal file -- never touches the real store/land-runs.jsonl.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export LAND_RUN_JOURNAL_FILE="$WORK/land-runs.jsonl"

ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; fail=1; }

# 1. A run that starts and finishes cleanly is never reported stale -- checked with a 0-second
#    threshold so an un-excluded finished run would ALWAYS show up (proves the "finished" check
#    in land-run-stale-check.sh is actually doing something, not just passing on age alone).
rid="$(bash "$HERE/land-run-journal.sh" start marveen-land.sh backend cardA)"
[ -n "$rid" ] || bad "start printed no run_id"
bash "$HERE/land-run-journal.sh" finish "$rid" 0
out="$(STALE_AFTER_SECONDS=0 bash "$HERE/land-run-stale-check.sh")"
case "$out" in
  *ALERT:no*) ok "a cleanly finished run is not stale (even at threshold=0)" ;;
  *) bad "a cleanly finished run was reported stale: $out" ;;
esac

# 2. A run that started 15 minutes ago and never finished (kill -9 simulation: just never call
#    finish) IS reported stale under a 10-minute threshold.
python3 -c '
import json, sys, time
old_ts = int(time.time()) - 900
with open(sys.argv[1], "a") as fh:
    fh.write(json.dumps({"run_id": "killed-1", "event": "started", "script": "marveen-land.sh",
                          "agent": "backend2", "card": "cardB", "ts": old_ts, "pid": 1}) + "\n")
' "$LAND_RUN_JOURNAL_FILE"
out="$(STALE_AFTER_SECONDS=600 bash "$HERE/land-run-stale-check.sh")"
case "$out" in
  *"STALE run_id=killed-1"*ALERT:yes*) ok "a killed run (no finish, >10min old) is reported stale" ;;
  *) bad "a killed run was not reported stale: $out" ;;
esac

# 3. A heartbeat updates last-activity, so a run heartbeating recently (even if started long ago)
#    is NOT stale.
python3 -c '
import json, sys, time
old_ts = int(time.time()) - 900
recent_ts = int(time.time()) - 30
with open(sys.argv[1], "a") as fh:
    fh.write(json.dumps({"run_id": "alive-1", "event": "started", "script": "marveen-land.sh",
                          "agent": "backend", "card": "cardC", "ts": old_ts, "pid": 2}) + "\n")
    fh.write(json.dumps({"run_id": "alive-1", "event": "heartbeat", "ts": recent_ts}) + "\n")
' "$LAND_RUN_JOURNAL_FILE"
out="$(STALE_AFTER_SECONDS=600 bash "$HERE/land-run-stale-check.sh")"
case "$out" in
  *"run_id=alive-1"*) bad "a recently-heartbeating run was reported stale: $out" ;;
  *) ok "a recently-heartbeating run is not reported stale" ;;
esac

echo "land-run-journal selftest done"
[ "$fail" -eq 0 ] && echo "selftest: PASS" || echo "selftest: FAIL"
exit "$fail"
