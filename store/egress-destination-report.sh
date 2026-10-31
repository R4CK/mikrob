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
MARVEEN_ROOT="${EGRESS_REPORT_ROOT:-$(cd "$HERE/.." && pwd)}"
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

# G4 (card cdcd0f5b): Node 22's built-in fetch ignores HTTP(S)_PROXY unless NODE_USE_ENV_PROXY=1
# is set (live-probed once, see DECISIONS.md for the measurement). The only place this repo sets
# HTTP_PROXY/HTTPS_PROXY as an egress-control mechanism is jail_cmd() in scripts/seged-hivo.py, for
# the 'agy'/'codex' jail -- 'agy' is a Go binary (confirmed proxy-honoring, see jail-net-proxy.py's
# own header). Everything else that calls fetch() in this repo runs with NO proxy env configured at
# all, so the bypass axis does not apply to it (there is nothing for it to bypass). This grep is
# re-run on every report so the "callers" list tracks the live tree, not a stale snapshot.
FETCH_CALLERS="$(grep -rl 'fetch(' "$MARVEEN_ROOT/src" "$MARVEEN_ROOT/scripts" "$MARVEEN_ROOT/develop-only/src" 2>/dev/null \
  --include='*.ts' --include='*.mjs' --include='*.js' 2>/dev/null \
  | grep -v node_modules | grep -v '__tests__' | grep -v '\.test\.' \
  | sed "s|^$MARVEEN_ROOT/||" | sort -u || true)"
PROXY_ENV_REFS="$(grep -rl 'HTTP_PROXY\|HTTPS_PROXY' "$MARVEEN_ROOT/src" "$MARVEEN_ROOT/scripts" "$MARVEEN_ROOT/develop-only/src" 2>/dev/null \
  --include='*.ts' --include='*.mjs' --include='*.js' --include='*.py' 2>/dev/null \
  | grep -v node_modules | sed "s|^$MARVEEN_ROOT/||" | sort -u || true)"

REPORT_JSON="$(python3 - "$LOG" "$OUT_FILE" "$DATE" "$FETCH_CALLERS" "$PROXY_ENV_REFS" << 'PYEOF'
import json, sys

log_path, out_path, date = sys.argv[1], sys.argv[2], sys.argv[3]
fetch_callers = [l for l in sys.argv[4].splitlines() if l]
proxy_env_refs = [l for l in sys.argv[5].splitlines() if l]

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
    "g4_node_fetch_proxy_bypass": {
        "finding": "Node 22 built-in fetch ignores HTTP(S)_PROXY unless NODE_USE_ENV_PROXY=1 is "
                    "set -- live-probed once (DECISIONS.md, card cdcd0f5b): without the flag, a "
                    "fetch() call connects DIRECTLY to the target, never touching the configured "
                    "proxy; with the flag, it correctly reaches the proxy first.",
        "only_proxy_env_setters_in_repo": proxy_env_refs,
        "note": "the only HTTP_PROXY/HTTPS_PROXY SETTER in this repo is jail_cmd() in "
                "scripts/seged-hivo.py, for the agy/codex jail. agy is a Go binary, already "
                "confirmed proxy-honoring. codex is Node-based but NOT installed on this host, so "
                "it is unmeasured -- re-run this probe once codex is installed.",
        "own_fetch_callers_with_no_proxy_configured": fetch_callers,
        "own_fetch_callers_affected_by_bypass": 0,
        "why_zero": "none of these callers run under an environment where HTTP_PROXY/HTTPS_PROXY "
                    "is set anywhere in this repo, so there is nothing for them to bypass.",
    },
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
