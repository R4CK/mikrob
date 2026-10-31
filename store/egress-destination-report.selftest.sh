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

echo
echo "selftest: $((PASS+FAIL)) case(s), PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'FAILED: %s\n' "${FAILED[@]}"
  exit 1
fi
