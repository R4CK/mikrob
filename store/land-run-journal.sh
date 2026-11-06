#!/usr/bin/env bash
# land-run-journal.sh -- append-only journal of landing-script runs (card 88b67fb4).
#
# WHY. fullstack's land run was killed (process gone) and nobody saw it: nothing recorded that a
# landing had even STARTED, so there was nothing to notice was missing. t3code's finalization-
# barrier idea (read-only, ideas only, no code copied: feature-lifecycles.md:529) is "a run is
# terminal only once its result is confirmed" -- the journal side of that here is simpler: record
# that a run STARTED, let it say it is still alive (heartbeat), and record how it ended (finished).
# A run with a `started` line, no `finished` line, and a last-activity timestamp more than 10
# minutes old is exactly the fullstack incident: something that began and never said it stopped.
# store/land-run-stale-check.sh reads this file and makes that call; this script only writes it.
#
# Usage (always a subcommand, never sourced -- keeps the two land scripts from needing to worry
# about variable-name collisions with a sourced library):
#   land-run-journal.sh start     <script> <agent> <card-or-dash>   -> prints a run_id to stdout
#   land-run-journal.sh heartbeat <run_id>
#   land-run-journal.sh finish    <run_id> <exit-code> [note]
#
# Every call is BEST-EFFORT in the sense that a journal write failure must never fail the landing
# it is watching (same principle as kanban-comment-lib.sh's functions) -- but `start` still prints
# the run_id it generated even if the write itself failed, so the caller's later heartbeat/finish
# calls stay harmless no-ops instead of operating on an empty id.
set -u

JOURNAL_FILE="${LAND_RUN_JOURNAL_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/land-runs.jsonl}"

_lrj_append() { # $1 = one-line JSON object (already built)
  printf '%s\n' "$1" >>"$JOURNAL_FILE" 2>/dev/null || true
}

_lrj_now() { date -u +%s; }

cmd="${1:-}"
case "$cmd" in
  start)
    script="${2:?usage: land-run-journal.sh start <script> <agent> <card-or-dash>}"
    agent="${3:-unknown}"
    card="${4:--}"
    run_id="$(_lrj_now)-$$-$RANDOM"
    payload="$(python3 -c '
import json, sys
print(json.dumps({
    "run_id": sys.argv[1], "event": "started", "script": sys.argv[2],
    "agent": sys.argv[3], "card": sys.argv[4], "ts": int(sys.argv[5]), "pid": int(sys.argv[6]),
}))' "$run_id" "$script" "$agent" "$card" "$(_lrj_now)" "$$" 2>/dev/null)" || payload=""
    [ -n "$payload" ] && _lrj_append "$payload"
    echo "$run_id"
    ;;
  heartbeat)
    run_id="${2:?usage: land-run-journal.sh heartbeat <run_id>}"
    [ -n "$run_id" ] || exit 0
    payload="$(python3 -c '
import json, sys
print(json.dumps({"run_id": sys.argv[1], "event": "heartbeat", "ts": int(sys.argv[2])}))' \
      "$run_id" "$(_lrj_now)" 2>/dev/null)" || payload=""
    [ -n "$payload" ] && _lrj_append "$payload"
    ;;
  finish)
    run_id="${2:?usage: land-run-journal.sh finish <run_id> <exit-code> [note]}"
    code="${3:-}"
    note="${4:-}"
    [ -n "$run_id" ] || exit 0
    payload="$(python3 -c '
import json, sys
print(json.dumps({
    "run_id": sys.argv[1], "event": "finished", "ts": int(sys.argv[2]),
    "result": ("ok" if sys.argv[3] == "0" else "fail"), "exit_code": sys.argv[3], "note": sys.argv[4],
}))' "$run_id" "$(_lrj_now)" "${code:-unknown}" "$note" 2>/dev/null)" || payload=""
    [ -n "$payload" ] && _lrj_append "$payload"
    ;;
  *)
    echo "usage: land-run-journal.sh start|heartbeat|finish ..." >&2
    exit 2
    ;;
esac
