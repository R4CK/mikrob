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

# 4. M3 delta (WhiteHat): finish is bound to the process GROUP that called start. Start a run
#    normally (owner = this test script's own process group), age it past the threshold, confirm
#    it reads as stale, then attempt a FORGED finish via `setsid` -- which puts the forging process
#    in a BRAND NEW, distinct process group/session, exactly simulating "any [other] process" (a
#    separate agent/shell on the same box, same uid, no relation to the one that called start) --
#    and confirm it is refused and the run is still stale afterward.
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

  forge_rc=0
  setsid bash "$HERE/land-run-journal.sh" finish "$dead_rid" 0 >"$WORK/forge.out" 2>&1 || forge_rc=$?
  if [ "$forge_rc" -eq 0 ]; then
    bad "forged finish (called from a different process group via setsid) was ACCEPTED: $(cat "$WORK/forge.out")"
  else
    ok "forged finish (different process group) was refused (exit $forge_rc): $(cat "$WORK/forge.out")"
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

echo "land-run-journal selftest done"
[ "$fail" -eq 0 ] && echo "selftest: PASS" || echo "selftest: FAIL"
exit "$fail"
