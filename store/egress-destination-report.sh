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

# G4 (card cdcd0f5b, Cybered NO-GO comment 27277 F2): the scan used to only look under
# src/scripts/develop-only/src for .ts/.mjs/.js/.py, which missed store/pentest-tool-runner.sh (a
# *.sh file under store/) -- a REAL second HTTP_PROXY/HTTPS_PROXY setter (lowercase http_proxy/
# https_proxy too), found only once Cybered pointed at it. Scan now covers store/ and *.sh, and
# matches lower-case setter names, so a future setter in a shell script is not silently invisible.
# This grep is re-run on every report so the "callers"/"setters" lists track the live tree, not a
# stale snapshot.
FETCH_CALLERS="$(grep -rl 'fetch(' "$MARVEEN_ROOT/src" "$MARVEEN_ROOT/scripts" "$MARVEEN_ROOT/develop-only/src" 2>/dev/null \
  --include='*.ts' --include='*.mjs' --include='*.js' 2>/dev/null \
  | grep -v node_modules | grep -v '__tests__' | grep -v '\.test\.' \
  | sed "s|^$MARVEEN_ROOT/||" | sort -u || true)"
PROXY_ENV_REFS="$(grep -rli 'http_proxy\|https_proxy' "$MARVEEN_ROOT/src" "$MARVEEN_ROOT/scripts" "$MARVEEN_ROOT/develop-only/src" "$MARVEEN_ROOT/store" 2>/dev/null \
  --include='*.ts' --include='*.mjs' --include='*.js' --include='*.py' --include='*.sh' 2>/dev/null \
  | grep -v node_modules | grep -v '/reports/' | grep -v "$(basename "$0")" \
  | sed "s|^$MARVEEN_ROOT/||" | sort -u || true)"

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

# Card cdcd0f5b (Cybered NO-GO comment 27277 F2): "own_fetch_callers_affected_by_bypass" used to
# be a hardcoded 0, computing nothing. A setter is only safely zero-rated if its downstream
# command is FIXED in the repo (never one of our own fetch() callers) -- jail_cmd() in
# scripts/seged-hivo.py always spawns the agy/codex binary, never a repo script. A setter whose
# downstream command is ARBITRARY (passed in at invocation time, e.g. store/pentest-tool-runner.sh
# "-- <command...>") could wrap one of our own fetch() callers and nothing here can prove
# otherwise by static scan -- it is reported as unverified, not silently assumed safe.
FIXED_DOWNSTREAM_SETTERS = {"scripts/seged-hivo.py"}
unverified_setters = [s for s in proxy_env_refs if s not in FIXED_DOWNSTREAM_SETTERS]
affected_known_zero = len(unverified_setters) == 0

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
        "proxy_env_setters_in_repo": proxy_env_refs,
        "fixed_downstream_setters": sorted(FIXED_DOWNSTREAM_SETTERS & set(proxy_env_refs)),
        "note": "fixed_downstream_setters always spawn a known, non-fetch()-calling target "
                "(jail_cmd() in scripts/seged-hivo.py only ever spawns the agy/codex binary -- agy "
                "is Go, already confirmed proxy-honoring; codex is Node-based but NOT installed on "
                "this host, unmeasured, re-run once installed). Any OTHER setter listed above takes "
                "an arbitrary downstream command at invocation time (e.g. "
                "store/pentest-tool-runner.sh's '-- <command...>') and is listed in "
                "unverified_setters below, not assumed safe.",
        "own_fetch_callers_with_no_proxy_configured": fetch_callers,
        "unverified_setters": unverified_setters,
        "own_fetch_callers_affected_by_bypass_known_zero": affected_known_zero,
        "own_fetch_callers_affected_by_bypass": 0 if affected_known_zero else "unverified -- see unverified_setters",
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
