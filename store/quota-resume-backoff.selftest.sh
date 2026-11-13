#!/usr/bin/env bash
# Selftest for card 7f112c2f Kesz-ha 1: "3 consecutive STILL-LIMITED produce probe gaps
# 15/30/60 min (fake clock)". Drives sched-precheck-quota-reset-resume.sh's own decision logic
# directly (same algorithm, lifted out so this can fake the clock without faking `time.time()`
# process-wide) against synthetic countdown/backoff JSON files in a scratch dir -- never touches
# the real store/quota-reset-countdown.json or store/quota-resume-backoff.json.
set -uo pipefail
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CD="$TMP/quota-reset-countdown.json"
BACKOFF="$TMP/quota-resume-backoff.json"
pass=0; fail=0

decide() { # $1 = now (fake epoch)
  python3 - "$CD" "$BACKOFF" "$1" <<'PY'
import json, sys
cd_path, backoff_path, now = sys.argv[1], sys.argv[2], float(sys.argv[3])
EARLY_PROBE_WINDOW_SEC = 180
try:
    with open(cd_path) as f:
        cd = json.load(f)
    deadline = cd.get("deadline", 9e18)
except (OSError, ValueError):
    print("SKIP"); sys.exit(0)
remaining = deadline - now
try:
    with open(backoff_path) as f:
        backoff = json.load(f)
    next_probe_at = backoff.get("nextProbeAt", 0)
    early_probe_done = backoff.get("earlyProbeDone", False)
except (OSError, ValueError):
    next_probe_at, early_probe_done = 0, False
if remaining > EARLY_PROBE_WINDOW_SEC:
    print("SKIP")
elif remaining > 0:
    print("SKIP" if early_probe_done else "RUN")
else:
    print("SKIP" if now < next_probe_at else "RUN")
PY
}

record_still_limited() { # $1 = now, $2 = early_probe (0/1)
  python3 - "$BACKOFF" "$2" <<PY
import json, time, os, sys
backoff_path, early_probe = "$BACKOFF", "$2" == "1"
BASE_SEC, CAP_SEC = 15 * 60, 60 * 60
try:
    with open(backoff_path) as f: state = json.load(f)
except (OSError, ValueError): state = {}
if early_probe:
    state["earlyProbeDone"] = True
    state.setdefault("consecutiveStillLimited", 0)
    state.setdefault("nextProbeAt", 0)
else:
    n = state.get("consecutiveStillLimited", 0) + 1
    backoff_sec = min(CAP_SEC, BASE_SEC * (2 ** (n - 1)))
    state["consecutiveStillLimited"] = n
    state["nextProbeAt"] = $1 + backoff_sec
    state.setdefault("earlyProbeDone", True)
with open(backoff_path, "w") as f: json.dump(state, f)
PY
}

check() {
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "ok   $1 ($3)";
  else fail=$((fail+1)); echo "FAIL $1 (expected $3, got $2)"; fi
}

NOW=1000000
DEADLINE=$((NOW + 1000))
python3 -c "import json; json.dump({'deadline': $DEADLINE}, open('$CD', 'w'))"

# Before the early-probe window: SKIP.
check "outside early-probe window" "$(decide $NOW)" "SKIP"

# At deadline-3min (early probe window): RUN once.
EARLY=$((DEADLINE - 180))
check "at deadline-3min, no probe yet" "$(decide $EARLY)" "RUN"
record_still_limited "$EARLY" 1
check "at deadline-3min again, probe already spent" "$(decide $EARLY)" "SKIP"

# Deadline passes, still limited 3 times in a row -> gaps 15/30/60 min.
D1=$DEADLINE
check "at deadline, due" "$(decide $D1)" "RUN"
record_still_limited "$D1" 0
gap1=$(python3 -c "import json;print(int(json.load(open('$BACKOFF'))['nextProbeAt'] - $D1))")
check "1st STILL-LIMITED backoff gap" "$gap1" "900"

check "before 1st backoff elapses" "$(decide $((D1 + 100)))" "SKIP"
D2=$((D1 + gap1))
check "exactly at 1st backoff -> RUN" "$(decide $D2)" "RUN"
record_still_limited "$D2" 0
gap2=$(python3 -c "import json;print(int(json.load(open('$BACKOFF'))['nextProbeAt'] - $D2))")
check "2nd STILL-LIMITED backoff gap" "$gap2" "1800"

D3=$((D2 + gap2))
check "exactly at 2nd backoff -> RUN" "$(decide $D3)" "RUN"
record_still_limited "$D3" 0
gap3=$(python3 -c "import json;print(int(json.load(open('$BACKOFF'))['nextProbeAt'] - $D3))")
check "3rd STILL-LIMITED backoff gap" "$gap3" "3600"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
