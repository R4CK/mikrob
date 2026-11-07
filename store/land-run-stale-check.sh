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

# WhiteHat NO-GO 28731, L2: a missing journal (or a directory in its place, which `-f` also
# excludes) used to print a bare "ALERT:no" -- indistinguishable from "checked, genuinely zero
# runs". A deleted journal is a DIFFERENT fact (nothing to check at all, possibly covering up an
# incident) and must say so, even though the verdict itself stays ALERT:no (there is nothing to
# be stale).
if [ ! -f "$JOURNAL_FILE" ]; then
  echo "NO-JOURNAL path=$JOURNAL_FILE -- no journal file found, nothing to check (not the same as a checked, zero-runs journal)"
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
import json, os, subprocess, sys, time

journal_file = sys.argv[1]

# WhiteHat NO-GO 28823 (card 88b67fb4, re-gate of 28731), B-new BLOCKING: the age-only threshold
# flags most HEALTHY landings as STALE, because the land scripts write no periodic heartbeat (a
# heartbeat only happens on a lost-push-race retry) and a real landing commonly runs 13-23 minutes,
# well past the 600s default -- paging the owner + Peti for ordinary, still-running work. Fix: a
# run with a recorded owner pid/pid_start is "alive" when `kill -0 <pid>` succeeds AND the current
# /proc/<pid> creation stamp still matches the one recorded at start time (rules out a reused pid
# taken over by an unrelated later process) -- an alive, matching owner is NEVER stale regardless
# of age. A confirmed-DEAD owner is stale IMMEDIATELY, not after waiting out the threshold (this
# also catches a killed lander at the next sweep instead of up to 10 minutes later). Only when
# liveness cannot be determined at all (no pid recorded -- e.g. a line written directly, not
# through land-run-journal.sh) does this fall back to the original age-based check.
def _pid_start_now(pid):
    try:
        out = subprocess.run(["stat", "-c", "%Y", f"/proc/{pid}"], capture_output=True, text=True, timeout=2)
    except Exception:
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip()

def _pid_alive(pid):
    try:
        pid_int = int(pid)
    except (TypeError, ValueError):
        return False
    if pid_int <= 0:
        return False  # pid 0/negative is never a real owner; signalling 0 hits our own process group
    try:
        os.kill(pid_int, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # process exists (we just cannot signal it -- different uid), still alive
    except Exception:
        return False
    return True

def owner_liveness(pid, pid_start):
    # Returns True (confirmed alive, same process), False (confirmed dead/replaced), or None
    # (cannot determine -- caller falls back to the age-based check).
    if pid is None:
        return None
    if not _pid_alive(pid):
        return False
    if not pid_start or pid_start in ("0", 0, ""):
        return None  # no trustworthy start-stamp recorded -- cannot confirm identity, not liveness
    cur = _pid_start_now(pid)
    if cur is None:
        return None
    return str(cur) == str(pid_start)

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
    # WhiteHat NO-GO 28731, L2: STALE_AFTER_SECONDS=<non-numeric> used to crash here with an
    # unhandled ValueError, OUTSIDE this try block -- no ALERT line at all, the exact "crashed
    # silently" failure mode M2 already fixed for malformed journal LINES, just reachable through
    # a different input. Parsing it inside the try makes a bad threshold land in the same
    # guaranteed-final-ALERT-line path as every other internal failure.
    threshold = int(sys.argv[2])
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
            else:
                # Does NOT extend last_ts and does NOT count as finished -- an untrusted finished
                # line must never make a genuinely stale/killed run look fresh or done.
                untrusted_finish += 1

    now = time.time()
    stale = []
    for rid, r in runs.items():
        if r.get("trusted_finished"):
            continue
        if "started_ts" not in r:
            continue  # a heartbeat/finished line with no matching started line -- nothing to flag
        age = now - r["last_ts"]
        pid, pid_start = started_identity.get(rid, (None, None))
        alive = owner_liveness(pid, pid_start)
        if alive is True:
            continue  # confirmed alive, same process as started it -- never stale, regardless of age
        if alive is False:
            stale.append((rid, r, age))  # confirmed dead/replaced -- stale now, not after the threshold
            continue
        # alive is None: liveness undeterminable (no pid recorded) -- fall back to age alone
        if age > threshold:
            stale.append((rid, r, age))

    for rid, r, age in sorted(stale, key=lambda x: -x[2]):
        script = r["script"]; agent = r["agent"]; card = r["card"]
        print(f"STALE run_id={rid} script={script} agent={agent} card={card} age_min={age/60:.1f}")

    if malformed:
        print(f"MALFORMED count={malformed} -- one or more journal lines could not be parsed/validated; treated as a stale-equivalent signal")
    if untrusted_finish:
        print(f"UNTRUSTED-FINISH count={untrusted_finish} -- a finished line did not match the recorded pid/pid_start for its run; not honored as a finish")

    print("ALERT:yes" if (stale or malformed or untrusted_finish) else "ALERT:no")
except Exception as e:
    print(f"ERROR: land-run-stale-check crashed: {e}", file=sys.stderr)
    print("ALERT:yes")
' "$JOURNAL_FILE" "$STALE_AFTER_SECONDS"
