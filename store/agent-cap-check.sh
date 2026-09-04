#!/usr/bin/env bash
# ADMIT/HOLD gate on the NUMBER of concurrently running fleet agent panels, independent of
# measured system load. Peti request 2026-09-04, after the 2026-09-03 WSL-overload incident
# (load-guard.log: 51x critical/sigstop_freeze across ~11h, 10:39-21:49): load-guard-eval.sh only
# reacts AFTER load already spiked, because it reads loadavg/PSI. Each running agent panel is its
# own Claude process plus its own MCP-server subprocess tree (playwright headless browser,
# filesystem-mcp, code-review-graph) -- that subprocess mass is the actual load source, not any
# single card's work. A proactive cap on panel COUNT stops the pileup before it starts, instead of
# throttling/freezing after the fact.
#
# Reads max_concurrent_agents from load-guard-config.json (0/absent = disabled), counts
# running:true entries from GET /api/agents. Fail-open on any error (missing token, dashboard
# down, bad JSON) -- a cap check that can itself wedge dispatch is worse than the overload it
# guards against, so any failure degrades to ADMIT (same philosophy as load-guard-daemon.sh's own
# eval-failure fallback to log_only).
#
# Only gates STARTING new work (POST /api/agents/<x>/start + dispatch) -- it says nothing about
# already-running panels, in-flight card completion, or gate dispatch; callers that need that
# distinction call this only where load-guard-check.sh itself is already the choke point.
#
# Usage: agent-cap-check.sh [--config <path>]
# Exit 0 = ADMIT (under cap, cap disabled, or check failed open). Exit 1 = HOLD (at/over cap).
# Prints one line: "ADMIT <n>/<max>" or "HOLD agent-cap (<n>/<max>)".
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/load-guard-config.json"
TOKEN_FILE="$SCRIPT_DIR/.dashboard-token"

while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    *) echo "agent-cap-check.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

MAX=$(python3 -c "import json; print(int(json.load(open('$CONFIG')).get('max_concurrent_agents', 0) or 0))" 2>/dev/null)
if [ -z "$MAX" ] || [ "$MAX" -le 0 ]; then
  echo "ADMIT (agent-cap disabled)"
  exit 0
fi

if [ ! -r "$TOKEN_FILE" ]; then
  echo "ADMIT (agent-cap: no token, fail-open)"
  exit 0
fi

hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
trap 'rm -f "$hdr_file"' EXIT
printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" > "$hdr_file"

RUNNING=$(curl -s --max-time 5 -H @"$hdr_file" \
  http://localhost:3420/api/agents 2>/dev/null \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(sum(1 for a in d if a.get('running')))" 2>/dev/null)

if [ -z "$RUNNING" ]; then
  echo "ADMIT (agent-cap: check failed, fail-open)"
  exit 0
fi

if [ "$RUNNING" -ge "$MAX" ]; then
  echo "HOLD agent-cap ($RUNNING/$MAX)"
  exit 1
else
  echo "ADMIT $RUNNING/$MAX"
  exit 0
fi
