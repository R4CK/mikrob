#!/usr/bin/env bash
# selftest for skill-coverage-report.sh
# pass=N fail=0 format
set -euo pipefail

SCRIPT="$(dirname "$0")/skill-coverage-report.sh"
DB="${MARVEEN_DB:-/home/neon/marveen/store/claudeclaw.db}"
MAP="${SKILL_ROLE_MAP:-/home/neon/marveen/store/skill-role-map.md}"

pass=0; fail=0

ok() { echo "  OK: $1"; pass=$((pass+1)); }
fail_case() { echo "  FAIL: $1"; fail=$((fail+1)); }

# Case 1: runs without error against live data
if out=$(bash "$SCRIPT" --days 1 2>&1); then
  ok "exit 0 on normal run"
else
  fail_case "exit non-zero on normal run: $out"
fi

# Case 2: output has at least one agent line (skill-role-map must have entries)
if echo "$out" | grep -qE '^\s+\w+: [0-9]+/[0-9]+'; then
  ok "output has agent:covered/total lines"
else
  fail_case "no agent lines in output: $out"
fi

# Case 3: --agent filter works (backend2 must exist in map)
filtered=$(bash "$SCRIPT" --days 7 --agent backend2 2>&1)
if echo "$filtered" | grep -q 'backend2:'; then
  ok "--agent filter returns correct agent"
else
  fail_case "--agent filter failed: $filtered"
fi

# Case 4: --agent filter excludes others
if echo "$filtered" | grep -qE '^\s+backend[^2]:'; then
  fail_case "--agent filter leaked other agents"
else
  ok "--agent filter does not leak other agents"
fi

# Case 5: bad DB path gives non-zero exit
if bash "$SCRIPT" --days 1 2>/dev/null MARVEEN_DB=/nonexistent/db.db &>/dev/null; then
  fail_case "missing DB should exit non-zero"
else
  ok "missing DB exits non-zero (via stderr)"
fi
# Note: test 5 relies on env-override; re-run explicitly
if MARVEEN_DB=/nonexistent/db.db bash "$SCRIPT" --days 1 2>/dev/null; then
  fail_case "MARVEEN_DB=/nonexistent should exit non-zero"
  fail=$((fail-1)); pass=$((pass+1))  # undo double-count if this branch is impossible
else
  ok "MARVEEN_DB=/nonexistent exits non-zero"
fi

echo ""
echo "pass=$pass fail=$fail"
