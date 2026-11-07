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
rid="$(bash "$HERE/land-run-journal.sh" start marveen-land.sh backend cardA "$$")"
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

# 4. M3 delta (WhiteHat), rebound in the B1 round (28731) to the land script's OWN pid via $PPID
#    instead of its process group. Start a run normally (owner = this test script's own pid), age
#    it past the threshold, confirm it reads as stale, then attempt a FORGED finish from a
#    genuinely DIFFERENT parent process -- simulating "any [other] process" (a separate
#    agent/shell on the same box, same uid, no relation to the one that called start) -- and
#    confirm it is refused and the run is still stale afterward.
#
# MUST use `setsid --fork`, not bare `setsid` or a backgrounded subshell: a plain `setsid cmd`
# does NOTHING (runs cmd as a normal direct child, same $PPID as the caller) when the invoking
# shell is already its own process-group leader -- measured to vary by invocation context (a
# one-off standalone command vs. running inside this very selftest script), making a bare
# `setsid` an unreliable forgery simulation. A backgrounded subshell (`( cmd ) &`) does not help
# either: $PPID is the OS-level parent, and a backgrounded job's parent is still the shell that
# forked it, same as a plain direct call. `--fork` makes setsid ALWAYS fork and detach the child
# into a new session regardless of leadership, reliably producing a $PPID the recorded pid can
# never match (measured: the detached child's PPID becomes a session-reaper pid, e.g. 300 here).
dead_rid="$(bash "$HERE/land-run-journal.sh" start mopsion-land.sh backend2 cardDead "$$")"
if [ -z "$dead_rid" ]; then
  bad "start printed no run_id"
else
  python3 -c '
import json, sys, time
old_ts = int(time.time()) - 900
path, rid = sys.argv[1], sys.argv[2]
out = []
with open(path, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        if rec.get("run_id") == rid and rec.get("event") == "started":
            rec["ts"] = old_ts
        out.append(json.dumps(rec))
with open(path, "w", encoding="utf-8") as f:
    f.write("\n".join(out) + "\n")
' "$LAND_RUN_JOURNAL_FILE" "$dead_rid"

  out="$(STALE_AFTER_SECONDS=600 bash "$HERE/land-run-stale-check.sh")"
  case "$out" in
    *"run_id=$dead_rid"*ALERT:yes*) ok "the run reads as stale before any forge attempt" ;;
    *) bad "the run was not stale before the forge attempt: $out" ;;
  esac

  # `setsid --fork` detaches immediately and always returns 0 itself (it does not wait for the
  # detached child) -- so success here is judged by the JOURNAL CONTENT (no new finished line),
  # not by this command's own exit code. The sleep gives the detached child time to run and
  # write (or refuse to write) before we check.
  setsid --fork bash "$HERE/land-run-journal.sh" finish "$dead_rid" 0 >"$WORK/forge.out" 2>&1
  sleep 0.5
  if grep -q "\"run_id\": *\"$dead_rid\".*\"event\": *\"finished\"" "$LAND_RUN_JOURNAL_FILE" 2>/dev/null; then
    bad "forged finish (called from a different parent process) was ACCEPTED: $(cat "$WORK/forge.out")"
  else
    ok "forged finish (different parent process) was refused: $(cat "$WORK/forge.out")"
  fi

  out="$(STALE_AFTER_SECONDS=600 bash "$HERE/land-run-stale-check.sh")"
  case "$out" in
    *"run_id=$dead_rid"*ALERT:yes*) ok "the run is still reported stale after the forged finish attempt" ;;
    *) bad "the forged finish silently cleared the stale flag: $out" ;;
  esac
fi

# Legitimate finish from the SAME process that called start must still work (M3's fix must not
# break the real caller, only an impostor).
same_rid="$(bash "$HERE/land-run-journal.sh" start marveen-land.sh backend cardSame "$$")"
legit_rc=0
bash "$HERE/land-run-journal.sh" finish "$same_rid" 0 >"$WORK/legit.out" 2>&1 || legit_rc=$?
if [ "$legit_rc" -ne 0 ]; then
  bad "legitimate finish (same caller as start) was refused: $(cat "$WORK/legit.out")"
else
  ok "legitimate finish (same caller as start) still succeeds"
fi

# 5. M2 delta (WhiteHat): malformed journal lines must never crash the stale check, must always
#    produce a final ALERT line, and must be counted and reported rather than silently dropped.
python3 -c '
import sys
with open(sys.argv[1], "a") as fh:
    fh.write("not json at all\n")
    fh.write("[1, 2, 3]\n")
    fh.write("\"just a string\"\n")
    fh.write("{\"run_id\": \"x\", \"event\": \"started\", \"ts\": \"not-a-number\"}\n")
' "$LAND_RUN_JOURNAL_FILE"
rc=0
out="$(STALE_AFTER_SECONDS=600 bash "$HERE/land-run-stale-check.sh" 2>"$WORK/m2.err")" || rc=$?
if [ "$rc" -ne 0 ]; then
  bad "stale-check exited non-zero ($rc) with malformed journal lines present"
else
  ok "stale-check still exits 0 with malformed journal lines present"
fi
if [ -s "$WORK/m2.err" ]; then
  bad "stale-check wrote to stderr on malformed lines (traceback?): $(cat "$WORK/m2.err")"
else
  ok "no stderr output (no traceback) on malformed lines"
fi
case "$out" in
  *"MALFORMED count="*) ok "malformed lines are counted and reported" ;;
  *) bad "malformed lines were not reported: $out" ;;
esac
case "$out" in
  *ALERT:yes*) ok "malformed journal lines force ALERT:yes" ;;
  *) bad "malformed journal lines did not force ALERT:yes: $out" ;;
esac

# 6. QA FAIL 28614 delta: a RAW file append (not through land-run-journal.sh at all -- the exact
#    technique QA demonstrated) of a fabricated `finished` event must not be honored. Start a run
#    normally, age it past the threshold, confirm stale, then directly append a forged finished
#    line with NO pid/pid_start fields (QA's own reproduction used the plain documented JSON shape,
#    which had no such fields before this delta) and confirm the run is still reported stale.
raw_rid="$(bash "$HERE/land-run-journal.sh" start marveen-land.sh backend2 cardRaw "$$")"
if [ -z "$raw_rid" ]; then
  bad "raw-forgery-test start printed no run_id"
else
  python3 -c '
import json, sys, time
old_ts = int(time.time()) - 900
path, rid = sys.argv[1], sys.argv[2]
out = []
with open(path, encoding="utf-8") as f:
    for line in f:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            rec = json.loads(stripped)
        except Exception:
            rec = None
        if not isinstance(rec, dict):
            out.append(stripped)  # pass pre-existing malformed lines through unchanged
            continue
        if rec.get("run_id") == rid and rec.get("event") == "started":
            rec["ts"] = old_ts
        out.append(json.dumps(rec))
with open(path, "w", encoding="utf-8") as f:
    f.write("\n".join(out) + "\n")
' "$LAND_RUN_JOURNAL_FILE" "$raw_rid"

  # The forgery itself: a plain shell append, no knowledge of the pid/pid_start binding at all.
  python3 -c '
import json, sys, time
with open(sys.argv[1], "a", encoding="utf-8") as f:
    f.write(json.dumps({"run_id": sys.argv[2], "event": "finished", "ts": int(time.time()),
                         "result": "ok", "exit_code": "0", "note": "forged"}) + "\n")
' "$LAND_RUN_JOURNAL_FILE" "$raw_rid"

  out="$(STALE_AFTER_SECONDS=600 bash "$HERE/land-run-stale-check.sh")"
  case "$out" in
    *"run_id=$raw_rid"*ALERT:yes*) ok "a raw-appended forged finished line (no pid binding) does not clear the stale flag" ;;
    *) bad "a raw-appended forged finished line cleared the stale flag: $out" ;;
  esac
  case "$out" in
    *"UNTRUSTED-FINISH count="*) ok "the untrusted finished line is reported as such" ;;
    *) bad "the untrusted finished line was not flagged: $out" ;;
  esac
fi

# 7. MikroB's live-D/5 gap 2 (msg_id:16818, card 40cfee40): an explicit [result] override on `finish` is written
#    verbatim, for the TERM-trap "aborted" case (land scripts record this on a deliberate stop).
abort_rid="$(bash "$HERE/land-run-journal.sh" start marveen-land.sh backend cardAbort "$$")"
bash "$HERE/land-run-journal.sh" finish "$abort_rid" 143 "deliberate stop (SIGTERM)" aborted
abort_result="$(python3 -c '
import json, sys
rid = sys.argv[2]
with open(sys.argv[1], encoding="utf-8") as f:
    for line in f:
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if isinstance(rec, dict) and rec.get("run_id") == rid and rec.get("event") == "finished":
            print(rec.get("result"))
' "$LAND_RUN_JOURNAL_FILE" "$abort_rid")"
if [ "$abort_result" = "aborted" ]; then
  ok "finish with an explicit [result] override writes that result verbatim (aborted)"
else
  bad "finish with [result]=aborted wrote result='$abort_result' instead"
fi
# Without an override, the exit-code-derived mapping is unchanged (regression check).
plain_rid="$(bash "$HERE/land-run-journal.sh" start marveen-land.sh backend cardPlainFail "$$")"
bash "$HERE/land-run-journal.sh" finish "$plain_rid" 1
plain_result="$(python3 -c '
import json, sys
rid = sys.argv[2]
with open(sys.argv[1], encoding="utf-8") as f:
    for line in f:
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if isinstance(rec, dict) and rec.get("run_id") == rid and rec.get("event") == "finished":
            print(rec.get("result"))
' "$LAND_RUN_JOURNAL_FILE" "$plain_rid")"
if [ "$plain_result" = "fail" ]; then
  ok "finish with no override still derives result from exit code (fail)"
else
  bad "finish with no override wrote result='$plain_result' instead of 'fail'"
fi

# 8. WhiteHat NO-GO 28731, B1 (BLOCKING): a land script launched in the BACKGROUND (the shape of
#    `nohup bash marveen-land.sh <agent> > log 2>&1 &`, measured at ~348 such invocations across
#    the fleet's own history) whose LAUNCHING shell exits before the land script's own finish
#    must still be honored -- a healthy backgrounded landing is not a forgery. Simulates the
#    launcher exiting (`disown` + not waiting on it) while the land script itself (a `bash -c`
#    subshell standing in for the long-lived land script) does its own start+finish.
rm -f "$LAND_RUN_JOURNAL_FILE"
rid_file="$WORK/b1-rid.txt"
bash -c '
_ljd="'"$HERE"'/land-run-journal.sh"
rid="$(bash "$_ljd" start marveen-land.sh backend cardBG "$$")"
sleep 0.5
bash "$_ljd" finish "$rid" 0
echo "$rid" >"'"$rid_file"'"
' &
launcher_pid=$!
sleep 0.2
disown "$launcher_pid" 2>/dev/null
wait "$launcher_pid" 2>/dev/null
sleep 0.8
b1_rid="$(cat "$rid_file" 2>/dev/null)"
if [ -z "$b1_rid" ]; then
  bad "B1 simulation: the backgrounded land script never reached finish"
else
  out="$(STALE_AFTER_SECONDS=600 bash "$HERE/land-run-stale-check.sh")"
  case "$out" in
    *"run_id=$b1_rid"*) bad "B1: a cleanly-finished backgrounded land run was reported STALE: $out" ;;
    *) ok "B1: a backgrounded land run (launcher already exited) finishes cleanly, not STALE" ;;
  esac
fi

# 9. WhiteHat NO-GO 28731, L2: a non-numeric STALE_AFTER_SECONDS must not crash with no ALERT
#    line (it used to raise an unhandled ValueError before the try block, rc 0, empty stdout).
l2_rc=0
l2_out="$(STALE_AFTER_SECONDS=abc bash "$HERE/land-run-stale-check.sh" 2>"$WORK/l2.err")" || l2_rc=$?
case "$l2_out" in
  *ALERT:yes*) ok "a non-numeric STALE_AFTER_SECONDS still produces a final ALERT line (yes)" ;;
  *) bad "a non-numeric STALE_AFTER_SECONDS produced no ALERT line: [$l2_out] stderr=[$(cat "$WORK/l2.err")]" ;;
esac

# L2, second half: a missing journal file must say so distinctly, not just a bare ALERT:no that
# looks identical to "checked, genuinely zero runs".
rm -f "$LAND_RUN_JOURNAL_FILE"
l2b_out="$(bash "$HERE/land-run-stale-check.sh")"
case "$l2b_out" in
  *"NO-JOURNAL"*ALERT:no*) ok "a missing journal file is reported distinctly (NO-JOURNAL), not a bare ALERT:no" ;;
  *) bad "a missing journal file did not say NO-JOURNAL: $l2b_out" ;;
esac

echo "land-run-journal selftest done"
[ "$fail" -eq 0 ] && echo "selftest: PASS" || echo "selftest: FAIL"
exit "$fail"
