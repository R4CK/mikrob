#!/usr/bin/env bash
# Self-test for the TERM trap inside marveen-land.sh's land_with_retry() (card 88b67fb4,
# MikroB's live-D/5 gap 2, msg_id:16818). Same extraction pattern as
# mopsion-land-trap-chain.selftest.sh: pull the REAL, currently-committed function body out of
# the running script ($0's sibling, land_with_retry() is defined after this script's own
# --selftest block exits, so it is never in scope there) and exercise it in a tiny harness with
# land_one/say stubbed -- a future edit that drops or breaks the TERM trap breaks this test too.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAND_SCRIPT="$HERE/marveen-land.sh"
fail=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export LAND_RUN_JOURNAL_FILE="$WORK/land-runs.jsonl"

ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; fail=1; }

FN_SRC="$(awk '/^land_with_retry\(\) \{$/{p=1} p{print} p&&/^}$/{exit}' "$LAND_SCRIPT")"
[ -n "$FN_SRC" ] || { echo "FATAL: could not extract land_with_retry from $LAND_SCRIPT -- anchors moved" >&2; exit 1; }
case "$FN_SRC" in
  *"' TERM"*) : ;;
  *) echo "FATAL: extracted land_with_retry has no TERM trap" >&2; exit 1 ;;
esac

out_file="$WORK/rid.txt"
rc_file="$WORK/rc.txt"
bash -c '
MAX_ATTEMPTS=5
land_one() { echo "$_run_id_probe" >"'"$out_file"'"; sleep 30; }
say() { :; }
'"$FN_SRC"'
land_with_retry backend 0 ""
' "$LAND_SCRIPT" &
bg_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  grep -q . "$LAND_RUN_JOURNAL_FILE" 2>/dev/null && break
  sleep 0.2
done
kill -TERM "$bg_pid" 2>/dev/null || true
wait "$bg_pid" 2>/dev/null; echo $? >"$rc_file"
rc="$(cat "$rc_file" 2>/dev/null)"

rid="$(python3 -c '
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("event") == "started":
            print(rec.get("run_id"))
            break
' "$LAND_RUN_JOURNAL_FILE")"

if [ -z "$rid" ]; then
  bad "no started record found in the journal -- land_with_retry never reached land_one"
else
  if [ "$rc" = "143" ]; then
    ok "a SIGTERM'd land_with_retry exits 143"
  else
    bad "a SIGTERM'd land_with_retry exited $rc, expected 143"
  fi
  if python3 -c '
import json, sys
rid = sys.argv[2]
found = False
with open(sys.argv[1], encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("run_id") == rid and rec.get("event") == "finished" and rec.get("result") == "aborted":
            found = True
sys.exit(0 if found else 1)
' "$LAND_RUN_JOURNAL_FILE" "$rid"; then
    ok "journal has a finished/aborted line for the SIGTERM'd run -- not a crash, not a plain fail"
  else
    bad "no finished/aborted line for run_id=$rid -- a deliberate stop would read as a killed process"
  fi
fi

# WhiteHat NO-GO 28731, L4: `land_one` can call `die()` (marveen-land.sh lines 569/579ish), which
# is a plain `exit N` -- no signal involved -- that used to terminate the whole script before any
# of land_with_retry's finish call sites (which only run AFTER land_one RETURNS) ever got a
# chance, so a clean refusal read as STALE forever. The EXIT trap fixes this: it fires on ANY
# shell exit, including an internal `exit N` from a function still on the call stack.
case "$FN_SRC" in
  *"' EXIT"*) : ;;
  *) echo "FATAL: extracted land_with_retry has no EXIT trap (L4 fix missing)" >&2; exit 1 ;;
esac

rm -f "$LAND_RUN_JOURNAL_FILE"
die_rc=0
bash -c '
MAX_ATTEMPTS=5
die() { echo "REFUSED: $2" >&2; exit "$1"; }
land_one() { die 3 "simulated hard refusal mid-landing"; }
say() { :; }
'"$FN_SRC"'
land_with_retry backend 0 ""
' "$LAND_SCRIPT" || die_rc=$?

if [ "$die_rc" = "3" ]; then
  ok "L4: land_one's die() still propagates its own exit code (3) out of land_with_retry"
else
  bad "L4: expected land_with_retry to exit 3 after land_one's die(), got $die_rc"
fi

die_rid="$(python3 -c '
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("event") == "started":
            print(rec.get("run_id"))
            break
' "$LAND_RUN_JOURNAL_FILE" 2>/dev/null)"
if [ -z "$die_rid" ]; then
  bad "L4: no started record found -- land_with_retry never reached land_one"
else
  if python3 -c '
import json, sys
rid = sys.argv[2]
found = False
with open(sys.argv[1], encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("run_id") == rid and rec.get("event") == "finished" and rec.get("exit_code") == "3":
            found = True
sys.exit(0 if found else 1)
' "$LAND_RUN_JOURNAL_FILE" "$die_rid"; then
    ok "L4: journal has a finished/exit_code=3 line for land_one's die() -- the EXIT trap caught it"
  else
    bad "L4: no finished line (exit_code=3) for run_id=$die_rid -- die() would read as STALE forever"
  fi
fi

echo "marveen-land.sh land_with_retry TERM-trap selftest done"
[ "$fail" -eq 0 ] && echo "selftest: PASS" || echo "selftest: FAIL"
exit "$fail"
