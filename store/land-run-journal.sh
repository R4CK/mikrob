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
#
# FINISH IS BOUND TO THE ORIGINATING PROCESS (card 88b67fb4 delta, WhiteHat M3: "any process can
# call finish and flip a stale run to ALERT:no"). The binding uses the PROCESS GROUP id, not
# $PPID: both land scripts call `start` as `_RID="$(bash land-run-journal.sh start ... 2>/dev/null
# || true)"`. The `|| true` after a command inside `$(...)` stops bash's own "exec the last
# command instead of forking" optimization from applying, so that command substitution forks a
# REAL, short-lived subshell whose $PPID (as seen from inside `start`) is that transient
# subshell's pid, already gone by the time `finish` runs minutes later -- not the long-lived land
# script's pid. The process GROUP id does not have this problem: a synchronous subshell/command-
# substitution chain never starts a new process group (that only happens for a backgrounded job or
# a new session), so `ps -o pgid= -p $$` returns the SAME value -- the original land script's own
# pid -- at every depth of that chain, verified end to end before shipping this fix. `start`
# records that pgid plus its /proc creation time; `finish` recomputes its own pgid the same way and
# refuses (no `finished` line written) unless both match what `start` recorded. A forged `finish`
# from an unrelated process, or one called after the real land script already died, lands in a
# different process group and is refused.
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
    # Process GROUP id of $$, not $PPID -- see the file header. This equals the long-lived land
    # script's own pid regardless of how many command-substitution layers sit between it and us.
    owner_pid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d '[:space:]')"
    [ -n "$owner_pid" ] || owner_pid="$$"
    owner_pid_start="$(stat -c %Y "/proc/$owner_pid" 2>/dev/null || echo 0)"
    payload="$(python3 -c '
import json, sys
print(json.dumps({
    "run_id": sys.argv[1], "event": "started", "script": sys.argv[2],
    "agent": sys.argv[3], "card": sys.argv[4], "ts": int(sys.argv[5]), "pid": int(sys.argv[6]),
    "pid_start": sys.argv[7],
}))' "$run_id" "$script" "$agent" "$card" "$(_lrj_now)" "$owner_pid" "$owner_pid_start" 2>/dev/null)" || payload=""
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
    caller_pid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d '[:space:]')"
    [ -n "$caller_pid" ] || caller_pid="$$"
    caller_pid_start="$(stat -c %Y "/proc/$caller_pid" 2>/dev/null || echo 0)"
    verdict="$(python3 -c '
import json, sys
journal_file, run_id, caller_pid, caller_pid_start = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
rec_pid = rec_pid_start = None
try:
    with open(journal_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if not isinstance(rec, dict):
                continue
            if rec.get("event") == "started" and str(rec.get("run_id")) == run_id:
                rec_pid, rec_pid_start = rec.get("pid"), rec.get("pid_start")
except FileNotFoundError:
    pass
if rec_pid is None:
    print("no-started-record")
elif caller_pid_start not in ("0", "") and str(rec_pid) == caller_pid and str(rec_pid_start) == caller_pid_start:
    print("ok")
else:
    print("mismatch")
' "$JOURNAL_FILE" "$run_id" "$caller_pid" "$caller_pid_start" 2>/dev/null)" || verdict="mismatch"
    if [ "$verdict" != "ok" ]; then
      echo "land-run-journal: REFUSED finish for run $run_id -- caller (process group $caller_pid) does not match the process that called start ($verdict). Not marking finished." >&2
      exit 1
    fi
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
