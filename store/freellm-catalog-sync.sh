#!/usr/bin/env bash
# freellm-catalog-sync.sh: Weekly freellmapi catalog sync task.
# Syncs the model catalog via POST /api/premium/sync endpoint.
# Logs version and count of changed models. Telegram alert on error or change.

set -euo pipefail

readonly FREELLM_URL="http://127.0.0.1:3001"
readonly AUTH_TOKEN_FILE="/home/neon/.config/freellmapi/auth-token"
readonly MARVEEN_TOKEN_FILE="/home/neon/marveen/store/.dashboard-token"

# Ensure auth token file exists and has proper permissions (0600)
[ -f "$AUTH_TOKEN_FILE" ] || { echo "[ERROR] auth token file not found: $AUTH_TOKEN_FILE" >&2; exit 1; }

perms=$(stat -c '%a' "$AUTH_TOKEN_FILE" 2>/dev/null || echo "000")
[ "$perms" = "600" ] || echo "[WARNING] auth token permissions are $perms, expected 0600" >&2

TOKEN=$(tr -d '\n' < "$AUTH_TOKEN_FILE")
[ -n "$TOKEN" ] || { echo "[ERROR] auth token is empty" >&2; exit 1; }

# Call sync endpoint. The auth header is piped via stdin (-H @-), not passed
# as a -H argv value, so the token never shows up in /proc/<pid>/cmdline.
response=$(printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -s -H @- -X POST "$FREELLM_URL/api/premium/sync" \
  -H "Content-Type: application/json") || { echo "[ERROR] sync request failed" >&2; exit 1; }

# Parse JSON fields using jq
ok=$(echo "$response" | jq -r '.sync.ok' 2>/dev/null || echo "error")
version=$(echo "$response" | jq -r '.sync.version // "unknown"' 2>/dev/null || echo "unknown")
action=$(echo "$response" | jq -r '.sync.action // "unknown"' 2>/dev/null || echo "unknown")

# Calculate total changes (counts may not exist if up_to_date)
total_changed=$(echo "$response" | jq '[.sync.counts.updated, .sync.counts.inserted, .sync.counts.removed] | map(select(. != null)) | add // 0' 2>/dev/null || echo "0")

# Format counts summary
if [ "$total_changed" -gt 0 ]; then
  updated=$(echo "$response" | jq -r '.sync.counts.updated // 0' 2>/dev/null || echo "0")
  inserted=$(echo "$response" | jq -r '.sync.counts.inserted // 0' 2>/dev/null || echo "0")
  removed=$(echo "$response" | jq -r '.sync.counts.removed // 0' 2>/dev/null || echo "0")
  counts_str="updated=$updated, inserted=$inserted, removed=$removed"
else
  counts_str="no changes"
fi

# Log the result (always)
log_msg="freellmapi catalog: version=$version (action=$action), $counts_str"
echo "$log_msg"

# Notify dashboard if error or changes detected
if [ "$ok" != "true" ] || [ "$total_changed" -gt 0 ]; then
  if [ -f "$MARVEEN_TOKEN_FILE" ]; then
    dashboard_token=$(cat "$MARVEEN_TOKEN_FILE")
    status="OK"
    [ "$ok" = "true" ] || status="FAILED"

    notify_msg="freellmapi catalog sync $status: $log_msg"

    printf 'Authorization: Bearer %s\n' "$dashboard_token" | curl -s -H @- -X POST http://localhost:3420/api/daily-log \
      -H "Content-Type: application/json" \
      --data-binary "{\"agent_id\":\"mikrob\",\"content\":\"## $notify_msg\"}" >/dev/null 2>&1 || true
  fi
fi

exit 0
