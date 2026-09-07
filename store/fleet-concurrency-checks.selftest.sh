#!/usr/bin/env bash
# fleet-concurrency-checks.selftest.sh -- fixture-based checks for card 9aa455c6's two fleet-health
# reports. Never touches the live dashboard or the live project-dispatch-priority.json: every case
# points --cards-file/--priority-file/--state-file at this run's own tmpdir.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/fleet-concurrency-checks.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

PASS=0
FAIL=0
check() { # $1 desc, $2 condition (0/1 already evaluated), $3 detail-on-fail
  if [ "$2" -eq 1 ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $1"; echo "  $3"; fi
}
contains() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }

# =================================================================================================
# multi-in-progress
# =================================================================================================
STATE1="$TMPDIR/mip-state.json"

cards_no_violation() {
  cat <<'EOF'
[
  {"id":"c1","status":"in_progress","assignee":"backend","parent_id":null,"archived_at":null},
  {"id":"c2","status":"in_progress","assignee":"backend2","parent_id":null,"archived_at":null}
]
EOF
}

out="$(bash "$SCRIPT" multi-in-progress --cards-file <(cards_no_violation) --state-file "$STATE1")"
check "no violation -> ALERT:no" "$(contains "$out" 'ALERT:no' && echo 1 || echo 0)" "$out"

cards_one_violation() {
  cat <<'EOF'
[
  {"id":"c1","status":"in_progress","assignee":"backend","parent_id":null,"archived_at":null},
  {"id":"c2","status":"in_progress","assignee":"backend","parent_id":null,"archived_at":null},
  {"id":"c3","status":"in_progress","assignee":"backend2","parent_id":null,"archived_at":null}
]
EOF
}

out="$(bash "$SCRIPT" multi-in-progress --cards-file <(cards_one_violation) --state-file "$STATE1")"
check "a real violation -> ALERT:yes, names the assignee" \
  "$(contains "$out" 'ALERT:yes' && contains "$out" 'backend:' && echo 1 || echo 0)" "$out"
check "the violation lists BOTH card ids" \
  "$(contains "$out" 'c1' && contains "$out" 'c2' && echo 1 || echo 0)" "$out"

# SAME violation again -> quiet (alert-only-on-change, agent-skill-drift-sync.sh's own shape)
out="$(bash "$SCRIPT" multi-in-progress --cards-file <(cards_one_violation) --state-file "$STATE1")"
check "unchanged violating set -> ALERT:no on the second run" \
  "$(contains "$out" 'ALERT:no' && echo 1 || echo 0)" "$out"

# SWAP: same COUNT (2), different card ids -- must still alert (card-level, not count-level).
cards_swapped_violation() {
  cat <<'EOF'
[
  {"id":"c1","status":"in_progress","assignee":"backend","parent_id":null,"archived_at":null},
  {"id":"c4","status":"in_progress","assignee":"backend","parent_id":null,"archived_at":null},
  {"id":"c3","status":"in_progress","assignee":"backend2","parent_id":null,"archived_at":null}
]
EOF
}
out="$(bash "$SCRIPT" multi-in-progress --cards-file <(cards_swapped_violation) --state-file "$STATE1")"
check "a same-COUNT card-set SWAP still alerts (a count-only trigger would miss this)" \
  "$(contains "$out" 'ALERT:yes' && echo 1 || echo 0)" "$out"

# RESOLVED: backend drops to 1 card -> reported as resolved, no longer counted as a violation.
cards_resolved() {
  cat <<'EOF'
[
  {"id":"c1","status":"in_progress","assignee":"backend","parent_id":null,"archived_at":null},
  {"id":"c3","status":"in_progress","assignee":"backend2","parent_id":null,"archived_at":null}
]
EOF
}
out="$(bash "$SCRIPT" multi-in-progress --cards-file <(cards_resolved) --state-file "$STATE1")"
check "a resolved violation is reported once, as resolved" \
  "$(contains "$out" 'resolved' && contains "$out" 'backend' && echo 1 || echo 0)" "$out"
out2="$(bash "$SCRIPT" multi-in-progress --cards-file <(cards_resolved) --state-file "$STATE1")"
check "and then stays quiet -- resolution is also reported only once" \
  "$(contains "$out2" 'ALERT:no' && echo 1 || echo 0)" "$out2"

# CONTROL: a PARENT card (referenced by another card's parent_id) is excluded from the count even
# if it is itself in_progress and shares the assignee -- matches the D-section stuck-card query's
# own parent-exclusion convention.
STATE2="$TMPDIR/mip-state2.json"
cards_parent_excluded() {
  cat <<'EOF'
[
  {"id":"parentA","status":"in_progress","assignee":"backend","parent_id":null,"archived_at":null},
  {"id":"leaf1","status":"in_progress","assignee":"backend","parent_id":"parentA","archived_at":null}
]
EOF
}
out="$(bash "$SCRIPT" multi-in-progress --cards-file <(cards_parent_excluded) --state-file "$STATE2")"
check "a parent + its one in_progress leaf is NOT a violation (only 1 real leaf card)" \
  "$(contains "$out" 'ALERT:no' && echo 1 || echo 0)" "$out"

# CONTROL: an archived card must not count toward the total, even if status still reads in_progress.
STATE3="$TMPDIR/mip-state3.json"
cards_archived_excluded() {
  cat <<'EOF'
[
  {"id":"c1","status":"in_progress","assignee":"backend","parent_id":null,"archived_at":null},
  {"id":"c2","status":"in_progress","assignee":"backend","parent_id":null,"archived_at":1700000000}
]
EOF
}
out="$(bash "$SCRIPT" multi-in-progress --cards-file <(cards_archived_excluded) --state-file "$STATE3")"
check "an archived card does not count toward the concurrency total" \
  "$(contains "$out" 'ALERT:no' && echo 1 || echo 0)" "$out"

# CONTROL: a card with no assignee must not crash the check or be silently grouped under a null key.
STATE4="$TMPDIR/mip-state4.json"
cards_no_assignee() {
  cat <<'EOF'
[
  {"id":"c1","status":"in_progress","assignee":null,"parent_id":null,"archived_at":null},
  {"id":"c2","status":"planned","assignee":"backend","parent_id":null,"archived_at":null}
]
EOF
}
out="$(bash "$SCRIPT" multi-in-progress --cards-file <(cards_no_assignee) --state-file "$STATE4")"
check "an unassigned card does not crash the check" "$(contains "$out" 'ALERT:no' && echo 1 || echo 0)" "$out"

# =================================================================================================
# dispatch-lock-age
# =================================================================================================
NOW="$(date +%s)"

priority_empty() { printf '{"priority": [], "updated_at": %d}' "$NOW"; }
priority_fresh() { printf '{"priority": ["MikroB"], "updated_at": %d}' "$NOW"; }
priority_old()   { printf '{"priority": ["MikroB"], "updated_at": %d}' "$((NOW - 50000))"; }  # ~13.9h

P_EMPTY="$TMPDIR/prio-empty.json"; priority_empty > "$P_EMPTY"
P_FRESH="$TMPDIR/prio-fresh.json"; priority_fresh > "$P_FRESH"
P_OLD="$TMPDIR/prio-old.json"; priority_old > "$P_OLD"
LOCK_STATE="$TMPDIR/lock-state.json"

out="$(bash "$SCRIPT" dispatch-lock-age --priority-file "$P_EMPTY" --state-file "$LOCK_STATE")"
check "an empty priority list -> ALERT:no (no lock at all)" "$(contains "$out" 'ALERT:no' && echo 1 || echo 0)" "$out"

out="$(bash "$SCRIPT" dispatch-lock-age --priority-file "$P_FRESH" --state-file "$LOCK_STATE")"
check "a fresh lock (under the threshold) -> ALERT:no" "$(contains "$out" 'ALERT:no' && echo 1 || echo 0)" "$out"

out="$(bash "$SCRIPT" dispatch-lock-age --priority-file "$P_OLD" --state-file "$LOCK_STATE")"
check "a lock past the 12h threshold -> ALERT:yes, names the age and the locked project(s)" \
  "$(contains "$out" 'ALERT:yes' && contains "$out" 'MikroB' && echo 1 || echo 0)" "$out"

out2="$(bash "$SCRIPT" dispatch-lock-age --priority-file "$P_OLD" --state-file "$LOCK_STATE")"
check "the SAME still-standing lock is not re-notified on the next run" \
  "$(contains "$out2" 'ALERT:no' && echo 1 || echo 0)" "$out2"

# A NEW lock (different updated_at) that is ALSO past the threshold gets its own fresh notification
# -- the state is keyed on updated_at, not a bare boolean, so a renewed/reset lock is not silenced
# forever by the first one's notification.
P_OLD2="$TMPDIR/prio-old2.json"
printf '{"priority": ["MikroB"], "updated_at": %d}' "$((NOW - 60000))" > "$P_OLD2"
out3="$(bash "$SCRIPT" dispatch-lock-age --priority-file "$P_OLD2" --state-file "$LOCK_STATE")"
check "a DIFFERENT (renewed) lock past the threshold gets its own notification" \
  "$(contains "$out3" 'ALERT:yes' && echo 1 || echo 0)" "$out3"

# CONTROL: a missing priority file (no exclusive lock ever set) must not crash and must not alert.
out="$(bash "$SCRIPT" dispatch-lock-age --priority-file "$TMPDIR/does-not-exist.json" --state-file "$LOCK_STATE")"
check "a missing priority file -> ALERT:no, not a crash" "$(contains "$out" 'ALERT:no' && echo 1 || echo 0)" "$out"

# Threshold override: a custom, tiny (zero) threshold fires immediately on an otherwise-fresh lock
# -- age is always >=0, so a 0 threshold is the one value with no timing race against wall-clock
# "now" advancing by a second between this test file capturing $NOW and the check running.
out="$(bash "$SCRIPT" dispatch-lock-age 0 --priority-file "$P_FRESH" --state-file "$TMPDIR/lock-state2.json")"
check "a threshold override (0s) fires even on a lock that is fresh by the default 12h bar" \
  "$(contains "$out" 'ALERT:yes' && echo 1 || echo 0)" "$out"

if [ "$FAIL" -eq 0 ]; then
  echo "selftest: $PASS passed, 0 failed"
  exit 0
else
  echo "selftest: $PASS passed, $FAIL failed"
  exit 1
fi
