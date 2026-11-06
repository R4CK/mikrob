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

journal_file, threshold = sys.argv[1], int(sys.argv[2])

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
    runs = {}  # run_id -> {started, finished, last_ts, script, agent, card}
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
            rid = str(rec.get("run_id"))
            r = runs.setdefault(rid, {"last_ts": 0})
            ts = rec.get("ts", 0) or 0
            r["last_ts"] = max(r["last_ts"], ts)
            event = rec.get("event")
            if event == "started":
                r["script"] = rec.get("script", "?")
                r["agent"] = rec.get("agent", "?")
                r["card"] = rec.get("card", "-")
                r["started_ts"] = ts
            elif event == "finished":
                r["finished"] = True

    now = time.time()
    stale = []
    for rid, r in runs.items():
        if r.get("finished"):
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

    print("ALERT:yes" if (stale or malformed) else "ALERT:no")
except Exception as e:
    print(f"ERROR: land-run-stale-check crashed: {e}", file=sys.stderr)
    print("ALERT:yes")
' "$JOURNAL_FILE" "$STALE_AFTER_SECONDS"
