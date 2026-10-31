#!/usr/bin/env bash
# egress-destination-report.selftest.sh -- does the report count destination+agent+decision
# correctly, and does it fail safely (empty report, not a crash) on a missing log? (card cdcd0f5b)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/egress-destination-report.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
declare -a FAILED=()
check() { if [ "$1" = "$2" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); FAILED+=("$3: expected [$2] got [$1]"); fi; }

# --- case 1: aggregates destination+agent+decision with correct counts -----
cat > "$TMP/sample.log" << 'EOF'
{"ts": "2026-10-31T10:00:00+0100", "agent": "fullstack", "host": "example.com", "port": 443, "decision": "allowed"}
{"ts": "2026-10-31T10:00:01+0100", "agent": "fullstack", "host": "example.com", "port": 443, "decision": "allowed"}
{"ts": "2026-10-31T10:00:02+0100", "agent": "backend", "host": "evil.example.org", "port": 443, "decision": "denied"}
EOF
OUT=$(EGRESS_REPORT_LOG="$TMP/sample.log" EGRESS_REPORT_OUT_DIR="$TMP/reports1" bash "$SCRIPT" --stdout)
ALLOWED_COUNT=$(echo "$OUT" | python3 -c "
import json, sys
r = json.load(sys.stdin)
row = [x for x in r['rows'] if x['destination'] == 'example.com:443' and x['agent'] == 'fullstack' and x['decision'] == 'allowed']
print(row[0]['count'] if row else 'MISSING')
")
check "$ALLOWED_COUNT" "2" "allowed-count aggregation"

DENIED_COUNT=$(echo "$OUT" | python3 -c "
import json, sys
r = json.load(sys.stdin)
row = [x for x in r['rows'] if x['destination'] == 'evil.example.org:443' and x['agent'] == 'backend' and x['decision'] == 'denied']
print(row[0]['count'] if row else 'MISSING')
")
check "$DENIED_COUNT" "1" "denied-count aggregation"

TOTAL=$(echo "$OUT" | python3 -c "import json,sys; print(json.load(sys.stdin)['total_events'])")
check "$TOTAL" "3" "total_events"

OUT_FILE_EXISTS="no"
[ -f "$TMP/reports1/egress-destination-report-$(date -u +%Y%m%d).json" ] && OUT_FILE_EXISTS="yes"
check "$OUT_FILE_EXISTS" "yes" "versioned report file written to disk"

# --- case 2: missing log -> empty report, not a crash -----------------------
OUT2=$(EGRESS_REPORT_LOG="$TMP/does-not-exist.log" EGRESS_REPORT_OUT_DIR="$TMP/reports2" bash "$SCRIPT" --stdout)
TOTAL2=$(echo "$OUT2" | python3 -c "import json,sys; print(json.load(sys.stdin)['total_events'])")
check "$TOTAL2" "0" "missing log yields empty report, not a crash"

# --- case 3: malformed line is skipped, not fatal ---------------------------
cat > "$TMP/malformed.log" << 'EOF'
{"ts": "2026-10-31T10:00:00+0100", "agent": "fullstack", "host": "example.com", "port": 443, "decision": "allowed"}
not-json-at-all
EOF
OUT3=$(EGRESS_REPORT_LOG="$TMP/malformed.log" EGRESS_REPORT_OUT_DIR="$TMP/reports3" bash "$SCRIPT" --stdout)
TOTAL3=$(echo "$OUT3" | python3 -c "import json,sys; print(json.load(sys.stdin)['total_events'])")
check "$TOTAL3" "1" "malformed line skipped, valid line still counted"

# --- case 4: g4 scan picks up a store/*.sh setter and marks it unverified (card cdcd0f5b F2) -
G4=$(EGRESS_REPORT_LOG="$TMP/does-not-exist2.log" EGRESS_REPORT_OUT_DIR="$TMP/reports4" bash "$SCRIPT" --stdout)
PENTEST_RUNNER_SEEN=$(echo "$G4" | python3 -c "
import json, sys
r = json.load(sys.stdin)
g4 = r['g4_node_fetch_proxy_bypass']
print('yes' if 'store/pentest-tool-runner.sh' in g4['proxy_env_setters_in_repo'] else 'no')
")
check "$PENTEST_RUNNER_SEEN" "yes" "g4 scan finds the store/*.sh proxy-env setter"

PENTEST_RUNNER_UNVERIFIED=$(echo "$G4" | python3 -c "
import json, sys
r = json.load(sys.stdin)
g4 = r['g4_node_fetch_proxy_bypass']
print('yes' if 'store/pentest-tool-runner.sh' in g4['unverified_setters'] else 'no')
")
check "$PENTEST_RUNNER_UNVERIFIED" "yes" "g4 marks the arbitrary-downstream setter unverified, not affected=0"

KNOWN_ZERO=$(echo "$G4" | python3 -c "
import json, sys
r = json.load(sys.stdin)
print(r['g4_node_fetch_proxy_bypass']['own_fetch_callers_affected_by_bypass_known_zero'])
")
check "$KNOWN_ZERO" "False" "affected-by-bypass is NOT asserted known-zero while an arbitrary-downstream setter exists"

# --- case 5: per-(destination,agent,decision) rows do NOT merge across agent or decision -----
# (card cdcd0f5b delta, RedHat 27436 M2/M3): M2 was a mutant that grouped only by
# (destination, decision), silently merging distinct agents into one row; M3 grouped only by
# (destination, agent), silently merging allowed/denied into one row. Both mutants left the
# existing cases above green because case 1 never has two agents sharing a destination+decision,
# nor one agent with two decisions on the same destination. This fixture forces both: agent-A and
# agent-B BOTH hit example.com:443 allowed (tests M2), and agent-A ALSO hits example.com:443 denied
# (tests M3) -- the report must keep all three as separate rows, each count=1.
cat > "$TMP/multi-agent.log" << 'EOF'
{"ts": "2026-10-31T11:00:00+0100", "agent": "agent-A", "host": "example.com", "port": 443, "decision": "allowed"}
{"ts": "2026-10-31T11:00:01+0100", "agent": "agent-B", "host": "example.com", "port": 443, "decision": "allowed"}
{"ts": "2026-10-31T11:00:02+0100", "agent": "agent-A", "host": "example.com", "port": 443, "decision": "denied"}
EOF
OUT5=$(EGRESS_REPORT_LOG="$TMP/multi-agent.log" EGRESS_REPORT_OUT_DIR="$TMP/reports5" bash "$SCRIPT" --stdout)
ROW_COUNT5=$(echo "$OUT5" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['rows']))")
check "$ROW_COUNT5" "3" "M2/M3: three distinct rows, not merged by agent or by decision"

AGENT_A_ALLOWED=$(echo "$OUT5" | python3 -c "
import json, sys
r = json.load(sys.stdin)
row = [x for x in r['rows'] if x['destination'] == 'example.com:443' and x['agent'] == 'agent-A' and x['decision'] == 'allowed']
print(row[0]['count'] if row else 'MISSING')
")
check "$AGENT_A_ALLOWED" "1" "M2: agent-A's allowed row stays count=1 (not merged with agent-B)"

AGENT_B_ALLOWED=$(echo "$OUT5" | python3 -c "
import json, sys
r = json.load(sys.stdin)
row = [x for x in r['rows'] if x['destination'] == 'example.com:443' and x['agent'] == 'agent-B' and x['decision'] == 'allowed']
print(row[0]['count'] if row else 'MISSING')
")
check "$AGENT_B_ALLOWED" "1" "M2: agent-B's own allowed row exists separately (not merged into agent-A's)"

AGENT_A_DENIED=$(echo "$OUT5" | python3 -c "
import json, sys
r = json.load(sys.stdin)
row = [x for x in r['rows'] if x['destination'] == 'example.com:443' and x['agent'] == 'agent-A' and x['decision'] == 'denied']
print(row[0]['count'] if row else 'MISSING')
")
check "$AGENT_A_DENIED" "1" "M3: agent-A's denied row stays separate from its own allowed row"

# --- case 6: the headline affected-by-bypass field itself is not asserted 0 (card cdcd0f5b delta,
# RedHat 27436 N3). Case 4 above already pins known_zero=False; this additionally pins the
# HEADLINE field's own value is not the literal integer 0 while known_zero is False -- a mutant
# that resets the headline field to 0 unconditionally (restoring the original false-assurance bug)
# while leaving known_zero correct would otherwise survive.
HEADLINE_NOT_ZERO=$(echo "$G4" | python3 -c "
import json, sys
r = json.load(sys.stdin)
v = r['g4_node_fetch_proxy_bypass']['own_fetch_callers_affected_by_bypass']
print('yes' if v != 0 else 'no')
")
check "$HEADLINE_NOT_ZERO" "yes" "N3: headline affected-by-bypass field is not the literal 0 while known_zero is False"

# --- case 7: the proxy-env scan is genuinely case-INSENSITIVE (card cdcd0f5b delta, RedHat 27436
# N4). Case 4's only fixture (the real store/pentest-tool-runner.sh) sets BOTH upper- and lower-
# case names, so a mutant dropping the `-i` flag (or the lower-case grep alternation) still finds it
# via the upper-case match and survives. This case points the scan at an ISOLATED fixture tree
# (EGRESS_REPORT_ROOT override, never the real repo) containing a *.sh file that sets ONLY the
# lower-case http_proxy/https_proxy names -- case-sensitive matching alone would miss it.
FIXTURE_ROOT="$TMP/ci-fixture-root"
mkdir -p "$FIXTURE_ROOT/store" "$FIXTURE_ROOT/src" "$FIXTURE_ROOT/scripts" "$FIXTURE_ROOT/develop-only/src"
cat > "$FIXTURE_ROOT/store/lowercase-only-setter.sh" << 'EOF'
#!/usr/bin/env bash
export http_proxy="http://127.0.0.1:0"
export https_proxy="http://127.0.0.1:0"
EOF
OUT7=$(EGRESS_REPORT_ROOT="$FIXTURE_ROOT" EGRESS_REPORT_LOG="$TMP/does-not-exist3.log" \
       EGRESS_REPORT_OUT_DIR="$TMP/reports7" bash "$SCRIPT" --stdout)
LOWERCASE_SEEN=$(echo "$OUT7" | python3 -c "
import json, sys
r = json.load(sys.stdin)
g4 = r['g4_node_fetch_proxy_bypass']
print('yes' if 'store/lowercase-only-setter.sh' in g4['proxy_env_setters_in_repo'] else 'no')
")
check "$LOWERCASE_SEEN" "yes" "N4: a lower-case-only proxy-env setter is found (scan is case-insensitive)"

echo
echo "selftest: $((PASS+FAIL)) case(s), PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'FAILED: %s\n' "${FAILED[@]}"
  exit 1
fi
