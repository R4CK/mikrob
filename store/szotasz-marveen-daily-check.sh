#!/usr/bin/env bash
# szotasz-marveen-daily-check.sh -- daily upstream-drift digest for Peti (Peti 2026-08-02:
# "minden nap ellenorzod a frissiteseket... Szotasz/Marveen").
#
# Rule 10 (GitHub-first, no duplication): does NOT re-detect drift -- reads the existing
# getUpdateStatus() cache (update-checker.ts, refreshed every 15 min) via the already-shipped
# /api/overview endpoint (card 3c09ba6b), which today only surfaces as a dashboard banner.
# This script is the missing DAILY TELEGRAM notification on top of that same data.
#
# OUTPUT (stdout, machine-readable first line):
#   ERROR:<reason>        -- could not read the overview API
#   CLEAN                 -- behind == 0 (fork up to date with Szotasz/marveen)
#   SAME:<behind>         -- still behind by the SAME count already flagged yesterday (dedupe)
#   NEW:<behind>          -- behind count changed since the last flagged value -- notify
set -uo pipefail

DASH="${MARVEEN_DASHBOARD_URL:-http://localhost:3420}"
TOKEN_FILE="${MARVEEN_TOKEN_FILE:-/home/neon/marveen/store/.dashboard-token}"
STATE_FILE="${MARVEEN_STATE_FILE:-/home/neon/marveen/store/szotasz-marveen-daily-state.json}"

[[ -r "$TOKEN_FILE" ]] || { echo "ERROR:no-token-file"; exit 2; }
TOKEN="$(cat "$TOKEN_FILE")"

RESP="$(curl -s -H "Authorization: Bearer $TOKEN" "$DASH/api/overview" 2>/dev/null)"
[[ -n "$RESP" ]] || { echo "ERROR:empty-response"; exit 2; }

BEHIND="$(echo "$RESP" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    u = d.get('upstreamUpdate')
    if not u or not u.get('ok'):
        print('null')
    else:
        print(int(u.get('behind', 0)))
except Exception:
    print('null')
" 2>/dev/null)"

[[ "$BEHIND" != "null" && -n "$BEHIND" ]] || { echo "ERROR:no-upstream-data"; exit 2; }

if [[ "$BEHIND" -eq 0 ]]; then
  echo '{"lastBehind":0}' > "$STATE_FILE" 2>/dev/null || true
  echo "CLEAN"
  exit 0
fi

LAST=$(python3 -c "
import json
try:
    print(json.load(open('$STATE_FILE')).get('lastBehind', -1))
except Exception:
    print(-1)
" 2>/dev/null)

echo "{\"lastBehind\":$BEHIND}" > "$STATE_FILE" 2>/dev/null || true

if [[ "$LAST" == "$BEHIND" ]]; then
  echo "SAME:$BEHIND"
else
  echo "NEW:$BEHIND"
fi
exit 0
