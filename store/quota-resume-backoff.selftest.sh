#!/usr/bin/env bash
# Selftest for card 7f112c2f Kesz-ha 1: "3 consecutive STILL-LIMITED produce probe gaps
# 15/30/60 min (fake clock)".
#
# M1 (Cybersec NO-GO @f859c361b): this used to drive its OWN embedded copies of the precheck's
# decide() logic and the backoff writer -- a mutation to the REAL formula in quota-resume.sh
# (backoff cap removed) or sched-precheck-quota-reset-resume.sh (RUN/SKIP inverted) left this
# selftest 10/10 green, because it never ran the production code at all. It now drives the real
# scripts (sched-precheck-quota-reset-resume.sh and quota-resume-backoff-write.py, the latter the
# exact script quota-resume.sh itself calls) against synthetic countdown/backoff files in a
# scratch dir, with QUOTA_COUNTDOWN_FILE/QUOTA_RESUME_BACKOFF_FILE/QUOTA_PRECHECK_FAKE_NOW env
# overrides -- never touches the real store/quota-reset-countdown.json or
# store/quota-resume-backoff.json, and the fake clock never has to fake time.time() process-wide.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export QUOTA_COUNTDOWN_FILE="$TMP/quota-reset-countdown.json"
export QUOTA_RESUME_BACKOFF_FILE="$TMP/quota-resume-backoff.json"
pass=0; fail=0

decide() { # $1 = now (fake epoch) -- normalizes the real script's protocol (stdout "SKIP", or
           # EMPTY stdout meaning "run normally", per its own header comment) to SKIP/RUN for
           # this test's comparisons; the decision itself is the real script's, not reimplemented.
  local out
  out=$(QUOTA_PRECHECK_FAKE_NOW="$1" bash "$SCRIPT_DIR/sched-precheck-quota-reset-resume.sh")
  if [ "$out" = "SKIP" ]; then echo "SKIP"; else echo "RUN"; fi
}

record_still_limited() { # $1 = now, $2 = early_probe (0/1)
  QUOTA_PRECHECK_FAKE_NOW="$1" python3 "$SCRIPT_DIR/quota-resume-backoff-write.py" \
    "$QUOTA_RESUME_BACKOFF_FILE" "$2" 2>/dev/null
}

check() {
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "ok   $1 ($3)";
  else fail=$((fail+1)); echo "FAIL $1 (expected $3, got $2)"; fi
}

NOW=1000000
DEADLINE=$((NOW + 1000))
python3 -c "import json; json.dump({'deadline': $DEADLINE}, open('$QUOTA_COUNTDOWN_FILE', 'w'))"

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
gap1=$(python3 -c "import json;print(int(json.load(open('$QUOTA_RESUME_BACKOFF_FILE'))['nextProbeAt'] - $D1))")
check "1st STILL-LIMITED backoff gap" "$gap1" "900"

check "before 1st backoff elapses" "$(decide $((D1 + 100)))" "SKIP"
D2=$((D1 + gap1))
check "exactly at 1st backoff -> RUN" "$(decide $D2)" "RUN"
record_still_limited "$D2" 0
gap2=$(python3 -c "import json;print(int(json.load(open('$QUOTA_RESUME_BACKOFF_FILE'))['nextProbeAt'] - $D2))")
check "2nd STILL-LIMITED backoff gap" "$gap2" "1800"

D3=$((D2 + gap2))
check "exactly at 2nd backoff -> RUN" "$(decide $D3)" "RUN"
record_still_limited "$D3" 0
gap3=$(python3 -c "import json;print(int(json.load(open('$QUOTA_RESUME_BACKOFF_FILE'))['nextProbeAt'] - $D3))")
check "3rd STILL-LIMITED backoff gap" "$gap3" "3600"

echo
echo "quota-resume-backoff.selftest: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
