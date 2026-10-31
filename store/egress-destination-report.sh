#!/usr/bin/env bash
# egress-destination-report.sh -- card cdcd0f5b (8ffa0c8a plan, step 1-2).
#
# Reads store/jail-net-proxy.log (JSON lines: ts/agent/host/port/decision, written by
# scripts/jail-net-proxy.py since this card's fix -- that proxy previously logged ALLOWED/DENIED
# to stderr only, which seged-hivo.py spawns with stderr=DEVNULL, so NOTHING reached a file
# before this change) and writes a named, versioned report file: destination, agent, count --
# not just a duration, per the card's done-state.
#
# Read-only, never blocks, never mutates the log it reads.
#
#   egress-destination-report.sh              # writes store/reports/egress-destination-report-<date>.json, prints path
#   egress-destination-report.sh --stdout      # also print the report to stdout
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${EGRESS_REPORT_LOG:-$HERE/jail-net-proxy.log}"
OUT_DIR="${EGRESS_REPORT_OUT_DIR:-$HERE/reports}"
STDOUT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --stdout) STDOUT=1 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

mkdir -p "$OUT_DIR"
DATE="$(date -u +%Y%m%d)"
OUT_FILE="$OUT_DIR/egress-destination-report-$DATE.json"

REPORT_JSON="$(python3 - "$LOG" "$OUT_FILE" "$DATE" << 'PYEOF'
import json, sys

log_path, out_path, date = sys.argv[1], sys.argv[2], sys.argv[3]

counts = {}  # (destination, agent, decision) -> count
try:
    with open(log_path, encoding="utf-8") as fh:
        lines = fh.readlines()
except FileNotFoundError:
    lines = []

for line in lines:
    line = line.strip()
    if not line:
        continue
    try:
        row = json.loads(line)
    except json.JSONDecodeError:
        continue
    dest = f'{row.get("host", "")}:{row.get("port", "")}'
    agent = row.get("agent") or "(unresolved)"
    decision = row.get("decision", "unknown")
    key = (dest, agent, decision)
    counts[key] = counts.get(key, 0) + 1

rows = [
    {"destination": dest, "agent": agent, "decision": decision, "count": count}
    for (dest, agent, decision), count in sorted(counts.items())
]

report = {
    "report": "egress-destination-report",
    "version": 1,
    "generated_at_utc_date": date,
    "source_log": log_path,
    "rows": rows,
    "total_events": sum(r["count"] for r in rows),
}

with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(report, fh, ensure_ascii=False, indent=2)
    fh.write("\n")

print(json.dumps(report, ensure_ascii=False, indent=2))
PYEOF
)"

if [ "$STDOUT" = "1" ] && [ -n "$REPORT_JSON" ]; then
  echo "$REPORT_JSON"
fi

# Status line goes to stderr so --stdout's output stays pure, parseable JSON.
echo "report: $OUT_FILE" >&2
