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
#   land-run-journal.sh start     <script> <agent> <card-or-dash> <caller-pid>  -> prints a run_id
#   land-run-journal.sh heartbeat <run_id>
#   land-run-journal.sh finish    <run_id> <exit-code> [note] [result]
#
# <caller-pid> (WhiteHat NO-GO 28731, B1, msg_id:16824): the LAND SCRIPT's own $$, passed in by
# the call site itself -- the one value it can state about itself with certainty, since $$ is
# unchanged across any depth of synchronous command substitution. See the binding note below for
# why this replaced the earlier process-group approach.
#
# [result] (card 88b67fb4, MikroB's live-D/5 gap 2, msg_id:16818): a deliberate stop (SIGTERM) is
# not a crash, but without an explicit way to say so, land-run-stale-check.sh has no choice but to
# treat it the same as a killed process -- a correct detection, but one that reads as an incident
# when it was actually requested. If given, [result] OVERRIDES the exit-code-derived "ok"/"fail"
# verbatim (e.g. "aborted"); the caller is expected to use this only for a genuinely deliberate
# stop it is recording itself (a TERM trap), not to launder a real failure's exit code.
#
# Every call is BEST-EFFORT in the sense that a journal write failure must never fail the landing
# it is watching (same principle as kanban-comment-lib.sh's functions) -- but `start` still prints
# the run_id it generated even if the write itself failed, so the caller's later heartbeat/finish
# calls stay harmless no-ops instead of operating on an empty id.
#
# FINISH IS BOUND TO THE ORIGINATING PROCESS (card 88b67fb4 delta, WhiteHat M3: "any process can
# call finish and flip a stale run to ALERT:no"). `start` records the land script's OWN pid (the
# <caller-pid> argument above) plus its /proc creation time; `finish` -- called as a PLAIN,
# UNWRAPPED command (`bash land-run-journal.sh finish ...`, never inside `$(...)`) -- is therefore
# a DIRECT CHILD of the land script, and its own $PPID bash variable IS that land script's pid,
# with zero ambiguity: refuse unless $PPID matches the recorded pid AND that pid's /proc creation
# time still matches (rules out a later, unrelated process recycling the same numeric pid after
# the real land script has exited). A forged `finish` from an unrelated process has a different
# parent and is refused outright.
#
# WHY NOT THE PROCESS GROUP (the previous approach, WhiteHat NO-GO 28731 B1): a process's pgid is
# shared with whoever LAUNCHED it into that group, and a land script started in the background
# (`nohup bash marveen-land.sh <agent> > log 2>&1 &`, `setsid ... &`, measured at ~348 such
# invocations across the fleet's own history) often shares its pgid with a launching shell that
# exits moments later. Once that pgid's original leader pid is gone, `/proc/<pgid>`'s creation
# time read at finish-time can no longer be confirmed, and the match was designed to refuse in
# that exact ambiguous case -- correctly rejecting a genuinely unrelated forger, but ALSO a
# perfectly healthy backgrounded land run, which then read as a false STALE 10 minutes later. The
# land script's own $$ never has this problem: it identifies ONE specific process (itself), not a
# group that can outlive or be shared with something else.
set -u

JOURNAL_FILE="${LAND_RUN_JOURNAL_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/land-runs.jsonl}"

_lrj_append() { # $1 = one-line JSON object (already built)
  printf '%s\n' "$1" >>"$JOURNAL_FILE" 2>/dev/null || true
}

_lrj_now() { date -u +%s; }

# Card 9d1ee327 (CYBERSEC NO-GO 28823 LOW item 3): the inode mtime of /proc/<pid> (what `stat -c
# %Y` reads) is NOT the real process start time -- measured: 36 of 217 live pids differed from
# the real starttime while each individual reading stayed STABLE over a 90s window, so this was
# not transient noise, just the wrong signal. /proc/<pid>/stat field 22 (starttime, clock ticks
# since boot) is the kernel's own, unambiguous answer. The comm field (2nd, in parens) can itself
# contain spaces or even parentheses, so this splits on the LAST ')' rather than counting raw
# whitespace-separated fields from the start of the line.
_lrj_proc_starttime() {
  python3 -c '
import sys
try:
    with open(f"/proc/{sys.argv[1]}/stat", encoding="utf-8") as f:
        data = f.read()
    rest = data.rsplit(")", 1)[1].split()
    print(rest[19])
except Exception:
    print(0)
' "$1" 2>/dev/null
}

cmd="${1:-}"
case "$cmd" in
  start)
    script="${2:?usage: land-run-journal.sh start <script> <agent> <card-or-dash> <caller-pid>}"
    agent="${3:-unknown}"
    card="${4:--}"
    owner_pid="${5:-}"
    # The land script's OWN $$, passed in by the caller (see file header) -- not computed here,
    # since `start` itself is invoked via `$(...)`, so ITS OWN $$ is a transient subshell pid, not
    # the land script's. Numeric-validate; an empty/non-numeric value is a caller bug, not a
    # reason to guess at a value that would only ever be wrong.
    case "$owner_pid" in
      ''|*[!0-9]*) owner_pid="" ;;
    esac
    run_id="$(_lrj_now)-${owner_pid:-$$}-$RANDOM"
    owner_pid_start="$([ -n "$owner_pid" ] && _lrj_proc_starttime "$owner_pid" || echo 0)"
    [ -n "$owner_pid_start" ] || owner_pid_start=0
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
    run_id="${2:?usage: land-run-journal.sh finish <run_id> <exit-code> [note] [result]}"
    code="${3:-}"
    note="${4:-}"
    result_override="${5:-}"
    [ -n "$run_id" ] || exit 0
    # $PPID: finish is always invoked as a plain, unwrapped command (never inside `$(...)`), so
    # this bash builtin IS the land script's own pid directly -- see the file header.
    caller_pid="$PPID"
    caller_pid_start="$(_lrj_proc_starttime "$caller_pid")"
    [ -n "$caller_pid_start" ] || caller_pid_start=0
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
    print(f"ok|{rec_pid}|{rec_pid_start}")
else:
    print("mismatch")
' "$JOURNAL_FILE" "$run_id" "$caller_pid" "$caller_pid_start" 2>/dev/null)" || verdict="mismatch"
    case "$verdict" in
      ok\|*) rec_pid="${verdict#ok|}"; rec_pid="${rec_pid%|*}"; rec_pid_start="${verdict##*|}" ;;
      *)
        echo "land-run-journal: REFUSED finish for run $run_id -- caller's parent (pid $caller_pid) does not match the process that called start ($verdict). Not marking finished." >&2
        exit 1
        ;;
    esac
    # QA FAIL 28614 (card 88b67fb4 delta): a raw `echo '{"event":"finished",...}' >> journal` never
    # goes through this script at all, so the caller-identity check above cannot see it. Embedding
    # the VALIDATED pid/pid_start into the finished event itself lets the READER (land-run-stale-
    # check.sh) reject a `finished` line whose pid/pid_start do not match its own `started` record --
    # catching exactly the naive forgery QA demonstrated (a finished event with no matching pid
    # data at all). This is NOT tamper-evidence against a forger who deliberately copies the
    # started record's own pid/pid_start fields (same-uid readable, no secret involved) -- that
    # residual gap needs an other-uid writer or a per-run secret never written to disk, per
    # WhiteHat's own framing of M3 as crash detection, not tamper evidence.
    payload="$(python3 -c '
import json, sys
override = sys.argv[7]
print(json.dumps({
    "run_id": sys.argv[1], "event": "finished", "ts": int(sys.argv[2]),
    "result": (override if override else ("ok" if sys.argv[3] == "0" else "fail")),
    "exit_code": sys.argv[3], "note": sys.argv[4],
    "pid": int(sys.argv[5]), "pid_start": sys.argv[6],
}))' "$run_id" "$(_lrj_now)" "${code:-unknown}" "$note" "$rec_pid" "$rec_pid_start" "$result_override" 2>/dev/null)" || payload=""
    [ -n "$payload" ] && _lrj_append "$payload"
    ;;
  _procstart)
    # Test/diagnostic entry point only -- exposes _lrj_proc_starttime over the CLI so a selftest
    # can exercise it without sourcing this file (the file header's own "never sourced" rule).
    pid="${2:?usage: land-run-journal.sh _procstart <pid>}"
    _lrj_proc_starttime "$pid"
    ;;
  *)
    echo "usage: land-run-journal.sh start|heartbeat|finish ..." >&2
    exit 2
    ;;
esac
