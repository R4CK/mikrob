#!/usr/bin/env bash
# local-llm-poll.sh -- poll one row queued via local-llm-submit.sh (card 28c92213).
#
# USAGE: local-llm-poll.sh <id> [--wait <seconds>]
#   --wait polls every 2s until the row leaves pending/running or the budget runs out (default:
#   no wait, one shot). This is a convenience CLI, not the worker -- it never claims/runs work
#   itself, only reads.
#
# OUTPUT: the row as JSON on stdout. `status` is one of pending|running|done|failed.
# Exit codes: 0 ok (row read, regardless of its status) | 4 bad usage | 6 dashboard unreachable/
# token missing | 8 timed out waiting (row still pending/running when the --wait budget ran out)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH_API="http://127.0.0.1:${WEB_PORT:-3420}/api/local-llm/queue"
TOKEN_FILE="${LOCAL_LLM_DASH_TOKEN_FILE:-$HERE/.dashboard-token}"

ID="${1:-}"
WAIT_BUDGET=0
if [[ "${2:-}" == "--wait" ]]; then WAIT_BUDGET="${3:-0}"; fi

if [[ -z "$ID" || ! "$ID" =~ ^[0-9]+$ ]]; then
  echo "usage: local-llm-poll.sh <id> [--wait <seconds>]" >&2
  exit 4
fi

if [[ ! -r "$TOKEN_FILE" ]]; then
  echo "local-llm-poll: dashboard token not readable ($TOKEN_FILE)" >&2
  exit 6
fi

hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
trap 'rm -f "$hdr_file"' EXIT
printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE" 2>/dev/null)" > "$hdr_file"

deadline=$(( $(date +%s) + WAIT_BUDGET ))
while :; do
  RESP="$(curl -fsS -m 10 -H "@$hdr_file" "$DASH_API/$ID" 2>/dev/null || true)"
  if [[ -z "$RESP" ]]; then
    echo "local-llm-poll: dashboard unreachable or request failed" >&2
    exit 6
  fi
  STATUS="$(printf '%s' "$RESP" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("status") or "")
except Exception: pass' 2>/dev/null || true)"
  if [[ "$STATUS" != "pending" && "$STATUS" != "running" ]]; then
    printf '%s\n' "$RESP"
    exit 0
  fi
  if [[ "$WAIT_BUDGET" -eq 0 || $(date +%s) -ge $deadline ]]; then
    printf '%s\n' "$RESP"
    [[ "$WAIT_BUDGET" -eq 0 ]] && exit 0
    exit 8
  fi
  sleep 2
done
