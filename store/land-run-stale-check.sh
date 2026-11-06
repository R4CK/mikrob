#!/usr/bin/env bash
# land-run-stale-check.sh -- find land-run-journal.sh runs that started and never finished, and
# whose last sign of life is older than the threshold (card 88b67fb4, requirement 3).
#
# A run counts as STALE when: it has a `started` event, it has NO `finished` event, and its most
# recent event (the last `heartbeat`, or `started` itself if no heartbeat ever arrived) is more
# than STALE_AFTER_SECONDS old. That last clause is what a `kill -9` produces: the process is
# simply gone, so no `finished` line is ever written -- the gap IS the signal, not an error path
# that logs anything. heartbeat-consolidated calls this on a schedule and tells the owner + MikroB.
#
# Usage: land-run-stale-check.sh
# Output: one line per stale run, then a summary line `ALERT:yes` / `ALERT:no` (same convention as
#         store/fleet-concurrency-checks.sh, so a caller can branch on the last line alone).
# Exit:   always 0 -- this is a report, not a gate.
set -uo pipefail

JOURNAL_FILE="${LAND_RUN_JOURNAL_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/land-runs.jsonl}"
STALE_AFTER_SECONDS="${STALE_AFTER_SECONDS:-600}"
# card 88b67fb4, MikroB's live-D/5 gap 1 (msg_id:16818): a `finished` line written BEFORE this
# card's pid/pid_start fix has neither field at all (not a mismatch -- genuinely absent), so it
# used to be indistinguishable from QA FAIL 28614's actual forgery and alerted as UNTRUSTED-FINISH
# forever, on every run, until the journal file rotates away. This state file remembers which
# run_ids were already reported once as LEGACY so a stale pre-fix line stops being news after its
# first report, without ever being treated as untrusted (it is honored as a real finish).
LEGACY_SEEN_FILE="${LAND_RUN_LEGACY_SEEN_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/land-run-legacy-seen.jsonl}"
# A missing pid/pid_start pair is ONLY safely "pre-fix legacy" if the finished line itself is
# OLDER than the commit that started always filling those fields in -- a missing pair written
# AFTER that point is QA FAIL 28614's exact forgery shape (the raw-append technique has no reason
# to know the field exists) and must stay UNTRUSTED-FINISH, never be waved through as legacy.
# This epoch is this fix's own landing time (git show -s --format=%ct f2ec47ddb5722ba1369363de3a3bec7b02c3952c).
PID_FIELDS_EPOCH="${LAND_RUN_PID_FIELDS_EPOCH:-1793995751}"

if [ ! -f "$JOURNAL_FILE" ]; then
  echo "ALERT:no"
  exit 0
fi

# WhiteHat M2 (card 88b67fb4 delta): one malformed journal line used to kill this whole script
# with an uncaught traceback and NO "ALERT:" line at all -- D/5's caller branches on ALERT:yes /
# ALERT:no, so a crash with neither reads as silent-quiet, not as "something is wrong". Every line
# is now type-checked on its own (never trusted past json.loads succeeding); a bad line is SKIPPED
# for run-state purposes but COUNTED, and any count > 0 forces ALERT:yes on its own -- a journal an
# agent can corrupt one line of is itself something to flag, not something to quietly tolerate. The
# whole body also runs under one more try/except so a bug here can never again come back as a
# missing final line.
python3 -c '
import json, sys, time

journal_file, threshold, legacy_seen_file, pid_fields_epoch = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4])

def is_valid(rec):
    if not isinstance(rec, dict):
        return False
    rid = rec.get("run_id")
    if not isinstance(rid, (str, int)) or str(rid) == "":
        return False
    event = rec.get("event")
    if event not in ("started", "heartbeat", "finished"):
        return False
    ts = rec.get("ts", 0)
    if ts is not None and not isinstance(ts, (int, float)):
        return False
    return True

try:
    legacy_seen = set()
    try:
        with open(legacy_seen_file, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    legacy_seen.add(str(json.loads(line).get("run_id")))
                except Exception:
                    continue
    except FileNotFoundError:
        pass

    records = []
    malformed = 0

    with open(journal_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                malformed += 1
                continue
            if not is_valid(rec):
                malformed += 1
                continue
            records.append(rec)

    # First pass: collect the `started` pid/pid_start recorded for each run_id -- this is the only event the
    # ORIGINATING land script itself ever writes with a verified identity (land-run-journal.sh
    # binds it to the caller process group at write time). A `finished` line is only trustworthy
    # if it carries the SAME pid/pid_start back (QA FAIL 28614, card 88b67fb4 delta): a raw
    # a raw append of a fabricated finished line bypasses land-run-journal.sh entirely, so it
    # never gets those fields filled in correctly, and is caught here instead.
    started_identity = {}  # run_id -> (pid, pid_start)
    runs = {}  # run_id -> {trusted_finished, last_ts, script, agent, card, started_ts}
    for rec in records:
        if rec.get("event") != "started":
            continue
        rid = str(rec.get("run_id"))
        started_identity[rid] = (rec.get("pid"), rec.get("pid_start"))
        r = runs.setdefault(rid, {"last_ts": 0})
        ts = rec.get("ts", 0) or 0
        r["last_ts"] = max(r["last_ts"], ts)
        r["script"] = rec.get("script", "?")
        r["agent"] = rec.get("agent", "?")
        r["card"] = rec.get("card", "-")
        r["started_ts"] = ts

    untrusted_finish = 0
    new_legacy = []  # run_ids seeing their first-ever LEGACY report this run
    for rec in records:
        event = rec.get("event")
        if event == "started":
            continue
        rid = str(rec.get("run_id"))
        r = runs.setdefault(rid, {"last_ts": 0})
        ts = rec.get("ts", 0) or 0
        if event == "heartbeat":
            r["last_ts"] = max(r["last_ts"], ts)
        elif event == "finished":
            want = started_identity.get(rid)
            got = (rec.get("pid"), rec.get("pid_start"))
            if want is not None and want == got and want[0] is not None:
                r["trusted_finished"] = True
                r["last_ts"] = max(r["last_ts"], ts)
            elif got == (None, None) and ts and ts < pid_fields_epoch:
                # LEGACY: a finished line OLDER than the commit that started always filling in
                # pid/pid_start genuinely predates the field existing -- honor it as a real finish
                # (it is not a forgery), but report it only once per run_id ever. A missing pair
                # on a line AT OR AFTER that epoch does NOT qualify here (falls to the else branch
                # below) -- it has no excuse not to carry the fields, so it stays untrusted.
                r["trusted_finished"] = True
                r["last_ts"] = max(r["last_ts"], ts)
                if rid not in legacy_seen:
                    new_legacy.append(rid)
                    legacy_seen.add(rid)
                # else: already reported before -- stay silent, per the "reported once" decision
            else:
                # pid/pid_start PRESENT but WRONG: a genuine mismatch, QA FAIL 28614s actual
                # forgery shape. Does NOT extend last_ts and does NOT count as finished -- an
                # untrusted finished line must never make a genuinely stale/killed run look fresh.
                untrusted_finish += 1

    now = time.time()
    stale = []
    for rid, r in runs.items():
        if r.get("trusted_finished"):
            continue
        if "started_ts" not in r:
            continue  # a heartbeat/finished line with no matching started line -- nothing to flag
        age = now - r["last_ts"]
        if age > threshold:
            stale.append((rid, r, age))

    for rid, r, age in sorted(stale, key=lambda x: -x[2]):
        script = r["script"]; agent = r["agent"]; card = r["card"]
        print(f"STALE run_id={rid} script={script} agent={agent} card={card} age_min={age/60:.1f}")

    if malformed:
        print(f"MALFORMED count={malformed} -- one or more journal lines could not be parsed/validated; treated as a stale-equivalent signal")
    if untrusted_finish:
        print(f"UNTRUSTED-FINISH count={untrusted_finish} -- a finished line did not match the recorded pid/pid_start for its run; not honored as a finish")
    if new_legacy:
        legacy_ids_joined = ",".join(new_legacy)
        print(f"LEGACY count={len(new_legacy)} run_ids={legacy_ids_joined} -- pre-fix finished line(s) with no pid/pid_start at all, honored as a real finish; reported once, will not repeat")
        try:
            with open(legacy_seen_file, "a", encoding="utf-8") as f:
                for rid in new_legacy:
                    f.write(json.dumps({"run_id": rid}) + "\n")
        except Exception:
            pass

    # LEGACY is informational (a one-time notice about pre-fix data), not an incident -- it never
    # forces ALERT:yes on its own, unlike a genuine stale run, a malformed line, or a real forgery.
    print("ALERT:yes" if (stale or malformed or untrusted_finish) else "ALERT:no")
except Exception as e:
    print(f"ERROR: land-run-stale-check crashed: {e}", file=sys.stderr)
    print("ALERT:yes")
' "$JOURNAL_FILE" "$STALE_AFTER_SECONDS" "$LEGACY_SEEN_FILE" "$PID_FIELDS_EPOCH"
