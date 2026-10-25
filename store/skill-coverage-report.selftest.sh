#!/usr/bin/env bash
# selftest for skill-coverage-report.sh
# pass=N fail=0 format
#
# HARDENED (card ed7d7948, WhiteHat F1/F2/F3, komment 23714 on 8a4a8b09): the previous version
# checked only output SHAPE against the live DB/map (any number would have passed) and always
# exited 0 regardless of fail count. This version uses a FIXTURE DB + fixture map with known exact
# numbers, so a wrong number is a real, pinned failure, and exits non-zero on any failure.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/skill-coverage-report.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0

ok() { echo "  OK: $1"; pass=$((pass+1)); }
fail_case() { echo "  FAIL: $1"; fail=$((fail+1)); }

# --- Fixture map: 2 agents, known required sets ---
# fixtureagent: required = {skill-a, skill-b} (skill-c is AJANLOTT, not counted)
# otheragent:   required = {skill-x}
FIXTURE_MAP="$TMP/skill-role-map.md"
cat > "$FIXTURE_MAP" <<'EOF'
### fixtureagent

| Skill | Allapot |
|---|---|
| `skill-a` | mar bekotve |
| `skill-b` | KOTELEZO-GAP |
| `skill-c` | AJANLOTT |

### otheragent

| Skill | Allapot |
|---|---|
| `skill-x` | mar bekotve |
EOF

# --- Fixture DB: fixtureagent saw skill-a (within window) and skill-c (irrelevant, not required);
# otheragent saw nothing within the window, but DID see skill-x 30 days ago (card 43dad36d, RedHat
# N1): that row must be excluded at --days 7, pinning the time-window filter itself, not just the
# shape of the query. So fixtureagent: covered=1, total=2, pct=50; otheragent: covered=0, total=1, pct=0.
FIXTURE_DB="$TMP/claudeclaw.db"
NOW=$(date +%s)
STALE=$((NOW - 30*86400))
sqlite3 "$FIXTURE_DB" <<SQL
CREATE TABLE skill_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('tool_call', 'skill_read')),
  session_id TEXT,
  created_at INTEGER NOT NULL
);
INSERT INTO skill_usage (agent_id, skill_name, trigger_type, created_at)
  VALUES ('fixtureagent', 'skill-a', 'tool_call', $NOW),
         ('fixtureagent', 'skill-c', 'tool_call', $NOW),
         ('otheragent', 'skill-x', 'tool_call', $STALE);
SQL

run() { MARVEEN_DB="$FIXTURE_DB" SKILL_ROLE_MAP="$FIXTURE_MAP" bash "$SCRIPT" "$@"; }

echo "=== 1. exact numbers against the fixture (pins the real counts, not just the shape) ==="
out="$(run --days 7 2>&1)"; rc=$?
if [[ $rc -eq 0 && "$out" == *"fixtureagent: 1/2 (50%)"* && "$out" == *"otheragent: 0/1 (0%)"* ]]; then
  ok "exact covered/total/pct for both fixture agents"
else
  fail_case "expected fixtureagent 1/2 (50%) + otheragent 0/1 (0%), got: $out"
fi

echo "=== 2. missing-skill list names skill-b (the KOTELEZO-GAP not seen), not skill-c (seen but not required) ==="
if [[ "$out" == *"nincs: skill-b"* && "$out" != *"skill-c"* ]]; then
  ok "missing list is skill-b only"
else
  fail_case "expected 'nincs: skill-b' and no mention of skill-c, got: $out"
fi

echo "=== 3. header line present: not-seen != not-used (WhiteHat F2) ==="
if [[ "$out" == *"nem látott != nem használt"* ]]; then
  ok "header states not-seen != not-used"
else
  fail_case "missing not-seen != not-used header: $out"
fi

echo "=== 4. --agent filter returns only the requested agent, with the exact number ==="
filtered="$(run --days 7 --agent fixtureagent 2>&1)"
if [[ "$filtered" == *"fixtureagent: 1/2 (50%)"* && "$filtered" != *"otheragent"* ]]; then
  ok "--agent filter returns exact number, no leak"
else
  fail_case "--agent filter failed: $filtered"
fi

echo "=== 5. MUTATION: swap covered<->required (len(required)/len(required) style bug) must turn case 1 red ==="
MUTANT="$TMP/skill-coverage-report.mutant.sh"
sed 's/pct = round(len(covered) \/ len(required) \* 100)/pct = 100/' "$SCRIPT" > "$MUTANT"
chmod +x "$MUTANT"
mutant_out="$(MARVEEN_DB="$FIXTURE_DB" SKILL_ROLE_MAP="$FIXTURE_MAP" bash "$MUTANT" --days 7 2>&1)"
if [[ "$mutant_out" == *"fixtureagent: 1/2 (50%)"* ]]; then
  fail_case "mutant (pct always 100) was NOT caught -- the fixture does not pin pct"
else
  ok "mutant (pct always 100) is caught by the exact-number assertion above"
fi

echo "=== 6. invalid --days (negative) -> non-zero exit + error message, not a silent 0% (WhiteHat F3) ==="
if out_bad="$(run --days -1 2>&1)"; then
  fail_case "--days -1 should exit non-zero: $out_bad"
else
  if [[ "$out_bad" == *"HIBA"* ]]; then
    ok "--days -1 exits non-zero with an error message"
  else
    fail_case "--days -1 exited non-zero but no error message: $out_bad"
  fi
fi

echo "=== 7. invalid --days (non-numeric) -> non-zero exit + error message ==="
if out_bad="$(run --days abc 2>&1)"; then
  fail_case "--days abc should exit non-zero: $out_bad"
else
  ok "--days abc exits non-zero"
fi

echo "=== 8. unknown --agent -> non-zero exit + error message, not the generic no-data line (WhiteHat F3) ==="
if out_bad="$(run --days 7 --agent no-such-agent 2>&1)"; then
  fail_case "unknown --agent should exit non-zero: $out_bad"
else
  if [[ "$out_bad" == *"HIBA"* && "$out_bad" != *"Nincs skill_usage adat"* ]]; then
    ok "unknown --agent exits non-zero with a real error, not the generic no-data message"
  else
    fail_case "unknown --agent gave the wrong message: $out_bad"
  fi
fi

echo "=== 9. missing DB -> non-zero exit ==="
if MARVEEN_DB=/nonexistent/db.db SKILL_ROLE_MAP="$FIXTURE_MAP" bash "$SCRIPT" --days 7 2>/dev/null; then
  fail_case "MARVEEN_DB=/nonexistent should exit non-zero"
else
  ok "MARVEEN_DB=/nonexistent exits non-zero"
fi

echo "=== 10. --days above the upper bound -> non-zero exit + error, not a silent 0%/rc 0 (RedHat N2) ==="
if out_bad="$(run --days 99999999999999999999 2>&1)"; then
  fail_case "--days 99999999999999999999 should exit non-zero: $out_bad"
else
  if [[ "$out_bad" == *"HIBA"* ]]; then
    ok "--days 99999999999999999999 exits non-zero with an error message"
  else
    fail_case "--days 99999999999999999999 exited non-zero but no error message: $out_bad"
  fi
fi

echo "=== 11. MUTATION: dropping the time-window filter must turn case 1's otheragent count red (RedHat N1) ==="
# otheragent's only skill_usage row (skill-x) is 30 days old (STALE above) and must be excluded at
# --days 7, so otheragent stays 0/1 (0%). A mutant that drops the WHERE clause picks that row up
# regardless of age, flipping otheragent to 1/1 (100%) -- this pins the window filter itself, not
# just the query shape.
WINDOW_MUTANT="$TMP/skill-coverage-report.window-mutant.sh"
sed "/WHERE created_at > CAST(strftime/d" "$SCRIPT" > "$WINDOW_MUTANT"
chmod +x "$WINDOW_MUTANT"
window_mutant_out="$(MARVEEN_DB="$FIXTURE_DB" SKILL_ROLE_MAP="$FIXTURE_MAP" bash "$WINDOW_MUTANT" --days 7 2>&1)"
if [[ "$window_mutant_out" == *"otheragent: 0/1 (0%)"* ]]; then
  fail_case "mutant (no time-window filter) was NOT caught -- the stale row does not pin the window: $window_mutant_out"
else
  ok "mutant (no time-window filter) is caught: stale row leaks in once the filter is dropped"
fi

echo ""
echo "pass=$pass fail=$fail"
exit $((fail > 0))
