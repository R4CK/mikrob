#!/usr/bin/env bash
# local-llm-queue-result.sh -- collect the result of a queued local-LLM sub-task (card defcc189).
#
# Pairs with local-llm-enqueue.sh: you got an id back, you kept working, now you want the draft.
#
# Usage:
#   local-llm-queue-result.sh <id>              # print result if done; exit 4 if still pending
#   local-llm-queue-result.sh <id> --wait 120   # poll up to N seconds, then give up
#   local-llm-queue-result.sh --stats           # queue depth + latency + per-agent breakdown
#
# Exit: 0 done (result on stdout) | 2 bad usage | 3 API unreachable | 4 not ready yet | 5 failed
#
# Exit codes are the point: a caller can branch on "not ready" vs "the model gave up" without
# parsing prose. A `failed` row means the 3-attempt cap was hit -- that task is the wrong shape for
# the 7B, so escalate it to an online agent rather than re-queueing it a fourth time.
set -uo pipefail

ROOT="/home/neon/marveen"
API="http://127.0.0.1:${WEB_PORT:-3420}/api"
TOKEN_FILE="$ROOT/store/.dashboard-token"

die() { echo "local-llm-queue-result.sh: $2" >&2; exit "$1"; }
[ -r "$TOKEN_FILE" ] || die 3 "dashboard token unreadable"

get() { curl -fsS "$API$1" -H "Authorization: Bearer $(cat "$TOKEN_FILE")" 2>/dev/null; }

if [ "${1:-}" = "--stats" ]; then
  # No f-strings with quoted subscripts here: this python is embedded in a single-quoted shell
  # string, and escaping quotes inside an f-string expression is a syntax error on this runtime.
  get "/local-llm/queue" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("pending=%s running=%s done=%s failed=%s avg_latency_ms=%s" % (
    d.get("pending", 0), d.get("running", 0), d.get("done", 0), d.get("failed", 0), d.get("avgLatencyMs")))
for r in d.get("by_agent", []):
    print("  %-12s pending=%-4s done=%-4s failed=%s" % (r["agent"], r["pending"], r["done"], r["failed"]))
' || die 3 "stats unavailable"
  exit 0
fi

ID="${1:-}"
[ -n "$ID" ] || die 2 "usage: local-llm-queue-result.sh <id> [--wait SECONDS] | --stats"
case "$ID" in (*[!0-9]*) die 2 "id must be a positive integer" ;; esac

WAIT=0
[ "${2:-}" = "--wait" ] && WAIT="${3:-60}"

DEADLINE=$(( $(date +%s) + WAIT ))
while true; do
  ROW=$(get "/local-llm/queue/$ID") || die 3 "API unreachable"
  STATUS=$(printf '%s' "$ROW" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null)
  case "$STATUS" in
    done)
      printf '%s' "$ROW" | python3 -c 'import json,sys; sys.stdout.write(json.load(sys.stdin).get("result") or "")'
      exit 0 ;;
    failed)
      printf '%s' "$ROW" | python3 -c 'import json,sys; sys.stderr.write((json.load(sys.stdin).get("error") or "failed")+"\n")'
      exit 5 ;;
    pending|running)
      [ "$(date +%s)" -ge "$DEADLINE" ] && exit 4
      sleep 3 ;;
    *)
      die 2 "unknown id $ID" ;;
  esac
done
