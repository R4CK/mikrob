#!/usr/bin/env bash
# Silent daily token-usage summary (card 39812fa4, split off 2169a59c -- the
# per-agent/per-card token API already exists and is live, card 0f21864e/#568;
# this is just the missing daily-log row).
#
# Script-first, not an LLM heartbeat (phase 7f35d1b9 part 1): a daily rollup is
# a single read + one POST, nothing an agent needs to reason about, so it costs
# zero Claude tokens. Reads yesterday's (Europe/Budapest) per-agent totals from
# the already-live GET /api/token-usage/summary and appends one line to
# /api/daily-log. No Telegram output on a normal run -- failures go to stderr
# only, same convention as db-backup.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API="${TOKEN_USAGE_DAILY_SUMMARY_API:-http://localhost:3420}"
TOKEN_FILE="${TOKEN_USAGE_DAILY_SUMMARY_TOKEN_FILE:-$HERE/.dashboard-token}"

TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null || true)"
# card 2d4c7943 class: drop any inherited export attribute before the python3/curl
# children below are spawned, so the real token cannot leak into their environment.
declare +x TOKEN
if [ -z "$TOKEN" ]; then
  echo "token-usage-daily-summary: dashboard token unreadable at $TOKEN_FILE" >&2
  exit 1
fi

# Yesterday's [00:00, 24:00) window, Europe/Budapest wall clock -> epoch seconds.
FROM="$(TZ=Europe/Budapest date -d 'yesterday 00:00' +%s)"
TO="$(TZ=Europe/Budapest date -d 'today 00:00' +%s)"
DAY="$(TZ=Europe/Budapest date -d 'yesterday' +%F)"

summary="$(printf 'Authorization: Bearer %s\n' "$TOKEN" \
  | timeout 10 curl -H @- -s "$API/api/token-usage/summary?from=$FROM&to=$TO" 2>/dev/null || true)"

if [ -z "$summary" ] || [ "$summary" = "[]" ]; then
  echo "token-usage-daily-summary: no usage rows for $DAY (from=$FROM to=$TO), nothing to log" >&2
  exit 0
fi

content="$(SUMMARY_JSON="$summary" DAY="$DAY" python3 -c '
import json, os
rows = json.loads(os.environ["SUMMARY_JSON"])
day = os.environ["DAY"]
rows.sort(key=lambda r: r.get("totalInput", 0) + r.get("totalOutput", 0), reverse=True)
lines = [f"## {day} -- Napi token-összesítő (automatikus, card 39812fa4)"]
for r in rows:
    agent = r.get("agent")
    inp = r.get("totalInput", 0)
    out = r.get("totalOutput", 0)
    cr = r.get("totalCacheRead", 0)
    cc = r.get("totalCacheCreation", 0)
    calls = r.get("totalCalls", 0)
    lines.append(f"- {agent}: in={inp:,} out={out:,} cache_read={cr:,} cache_creation={cc:,} calls={calls:,}")
print("\n".join(lines))
')"

payload="$(CONTENT="$content" python3 -c '
import json, os
print(json.dumps({"agent_id": "mikrob", "content": os.environ["CONTENT"]}))
')"

resp="$(printf 'Authorization: Bearer %s\n' "$TOKEN" \
  | timeout 10 curl -H @- -s -X POST "$API/api/daily-log" -H "Content-Type: application/json" \
    --data-binary "$payload" 2>/dev/null || true)"

if ! printf '%s' "$resp" | grep -q '"ok":true'; then
  echo "token-usage-daily-summary: daily-log POST did not confirm ok for $DAY: $resp" >&2
  exit 1
fi

echo "token-usage-daily-summary: logged $DAY ($(printf '%s' "$summary" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))') agents)"
