#!/usr/bin/env bash
# freellm-catalog-sync.sh: Weekly freellmapi catalog sync task.
# Syncs the model catalog via POST /api/premium/sync endpoint.
# Logs version and count of changed models. Telegram alert on error or change.

set -euo pipefail

FREELLM_URL="${FREELLM_URL:-http://127.0.0.1:3001}"
AUTH_TOKEN_FILE="${AUTH_TOKEN_FILE:-/home/neon/.config/freellmapi/auth-token}"
ADMIN_CRED_FILE="${ADMIN_CRED_FILE:-/home/neon/.config/freellmapi/admin}"
MARVEEN_TOKEN_FILE="${MARVEEN_TOKEN_FILE:-/home/neon/marveen/store/.dashboard-token}"
CURL_MAX_TIME="${CURL_MAX_TIME:-30}"
readonly FREELLM_URL AUTH_TOKEN_FILE ADMIN_CRED_FILE MARVEEN_TOKEN_FILE CURL_MAX_TIME

# Non-negative, max 9 digits (405869d9 R1, CYBERED NO-GO 25502 / WhiteHat2
# 25318): the old ^-?[0-9]+$ let "08" through, which then crashed bash
# arithmetic (invalid octal literal) AFTER is_int passed it, dying without
# going through fail() -- no FAILED line, no daily-log row. The first fix
# (^(0|[1-9][0-9]*)$) closed that and the negative-count case, but had no
# length bound: a 20-digit count like 2^64 still passed is_int and wrapped
# bash's signed 64-bit arithmetic to 0 (or a large negative), which then
# silently read as "no change" and skipped notify() -- the exact failure
# mode R1 exists to close, just moved to a bigger number. A 9-digit cap
# (max 999,999,999) is far above any real catalog count and stays inside
# bash's 64-bit range with room to spare, so the sum of three such values
# can never wrap. Leading zeros are allowed again here (the length cap
# alone can't tell "08" from "8"); the arithmetic below reads counts via
# 10#$c to force base-10, so "08" no longer hits bash's octal-literal rule.
is_int() { [[ "$1" =~ ^[0-9]{1,9}$ ]]; }

# Reject anything outside a plain token charset before it reaches a daily-log
# row that lands in an agent's memory/context (405869d9 R3). The catalog is
# Ed25519-signed, but a signature only proves who published it, not that
# version/action are safe to echo verbatim into another agent's context.
sanitize_field() {
  local v="$1"
  [[ "$v" =~ ^[A-Za-z0-9._-]{1,32}$ ]] && { printf '%s' "$v"; return; }
  printf 'invalid'
}

# Build the daily-log body with jq -n --arg (never raw string interpolation): a
# hostile $version/$action from the (signed but not JSON-safe) catalog response
# must not be able to inject/override JSON keys (QA FAIL 25275 / WhiteHat L1).
notify() {
  local status="$1" msg="$2"
  [ -f "$MARVEEN_TOKEN_FILE" ] || return 0
  local dashboard_token notify_msg payload
  dashboard_token=$(cat "$MARVEEN_TOKEN_FILE")
  notify_msg="freellmapi catalog sync $status: $msg"
  payload=$(jq -n --arg agent_id mikrob --arg content "## $notify_msg" '{agent_id:$agent_id,content:$content}')
  printf 'Authorization: Bearer %s\n' "$dashboard_token" | curl -s --max-time "$CURL_MAX_TIME" -H @- -X POST http://localhost:3420/api/daily-log \
    -H "Content-Type: application/json" \
    --data-binary "$payload" >/dev/null 2>&1 || true
}

# Every failure path goes through here: stdout starts with the FAILED marker,
# a daily-log row is still written, and the exit code is non-zero (WhiteHat M1
# -- a silent exit-0 "no changes" on auth/network/shape failure is indistinguishable
# from a real no-op to the scheduler prompt).
fail() {
  echo "freellmapi catalog FAILED: $1"
  notify "FAILED" "$1"
  exit 1
}

# Re-login once on an expired/invalid session, using the admin credential file.
# Email and password flow only via stdin into jq/curl, never as argv or env of a
# child process (same constraint as the Bearer-header piping below). The new
# token lands 0600 via mktemp+mv (see comment at that call below).
reauth() {
  [ -f "$ADMIN_CRED_FILE" ] || { echo "[ERROR] admin credential file not found: $ADMIN_CRED_FILE" >&2; return 1; }
  local admin_perms
  admin_perms=$(stat -c '%a' "$ADMIN_CRED_FILE" 2>/dev/null || echo "000")
  [ "$admin_perms" = "600" ] || echo "[WARNING] admin credential file permissions are $admin_perms, expected 0600" >&2

  local admin_line email password
  admin_line=$(cat "$ADMIN_CRED_FILE")
  email="${admin_line%%:*}"
  password="${admin_line#*:}"
  [ -n "$email" ] && [ -n "$password" ] && [ "$email" != "$admin_line" ] || { echo "[ERROR] admin credential file malformed" >&2; return 1; }

  local login_payload login_response new_token
  login_payload=$(printf '%s\x1e%s' "$email" "$password" | jq -R -s '
    split("\u001e") | {email: .[0], password: .[1]}
  ')
  login_response=$(echo "$login_payload" | curl -s --max-time "$CURL_MAX_TIME" --data-binary @- -X POST "$FREELLM_URL/api/auth/login" \
    -H "Content-Type: application/json") || { echo "[ERROR] re-login request failed" >&2; return 1; }
  new_token=$(echo "$login_response" | jq -r '.token // empty' 2>/dev/null || echo "")
  [ -n "$new_token" ] || { echo "[ERROR] re-login failed: $(echo "$login_response" | jq -r '.error.message // "unparseable response"' 2>/dev/null || echo "unparseable response")" >&2; return 1; }

  # mktemp + mv, not a direct '>' write (405869d9 R2): writing into an
  # EXISTING file with '>' keeps that file's old mode (umask only governs
  # newly-created files), so a token file that pre-existed as 0644 stayed
  # 0644 after a "successful" re-login. mktemp always creates its file 0600
  # (mkstemp, independent of umask), and mv replaces the destination with
  # that new inode, mode and all. A failure at any step is no longer silent.
  local tmp_token_file
  tmp_token_file=$(mktemp "${AUTH_TOKEN_FILE}.XXXXXX") || { echo "[ERROR] could not create temp file for new token" >&2; return 1; }
  if ! printf '%s' "$new_token" > "$tmp_token_file"; then
    echo "[ERROR] failed to write new token to temp file" >&2
    rm -f "$tmp_token_file"
    return 1
  fi
  if ! mv -f "$tmp_token_file" "$AUTH_TOKEN_FILE"; then
    echo "[ERROR] failed to move new token into place" >&2
    rm -f "$tmp_token_file"
    return 1
  fi
  TOKEN="$new_token"
  return 0
}

# Call sync endpoint. The auth header is piped via stdin (-H @-), not passed
# as a -H argv value, so the token never shows up in /proc/<pid>/cmdline. The
# HTTP status is appended after a newline (-w) so a 401 can be told apart from
# a 200 carrying an error body, and --max-time bounds a hung freellmapi
# (WhiteHat L3) so a timeout fails loudly instead of hanging the schedule.
call_sync() {
  printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -s --max-time "$CURL_MAX_TIME" -H @- -X POST "$FREELLM_URL/api/premium/sync" \
    -H "Content-Type: application/json" -w '\n%{http_code}'
}

# Ensure auth token file exists and has proper permissions (0600)
[ -f "$AUTH_TOKEN_FILE" ] || { echo "[ERROR] auth token file not found: $AUTH_TOKEN_FILE" >&2; exit 1; }

perms=$(stat -c '%a' "$AUTH_TOKEN_FILE" 2>/dev/null || echo "000")
[ "$perms" = "600" ] || echo "[WARNING] auth token permissions are $perms, expected 0600" >&2

TOKEN=$(tr -d '\n' < "$AUTH_TOKEN_FILE")
[ -n "$TOKEN" ] || { echo "[ERROR] auth token is empty" >&2; exit 1; }

raw=$(call_sync) || fail "sync request failed (network/timeout)"
http_code="${raw##*$'\n'}"
response="${raw%$'\n'*}"

if [ "$http_code" = "401" ]; then
  if reauth; then
    raw=$(call_sync) || fail "sync request failed after re-login"
    http_code="${raw##*$'\n'}"
    response="${raw%$'\n'*}"
  else
    fail "session expired and re-login failed"
  fi
fi

[ "$http_code" = "200" ] || fail "unexpected HTTP status $http_code: $(echo "$response" | tr -d '\n' | head -c 200)"

ok=$(echo "$response" | jq -r '.sync.ok // "null"' 2>/dev/null || echo "null")
[ "$ok" = "true" ] || fail "sync response not ok: $(echo "$response" | tr -d '\n' | head -c 200)"

version=$(sanitize_field "$(echo "$response" | jq -r '.sync.version // "unknown"' 2>/dev/null || echo "unknown")")
action=$(sanitize_field "$(echo "$response" | jq -r '.sync.action // "unknown"' 2>/dev/null || echo "unknown")")

# A non-numeric or missing count on a reported "applied" sync is a failure, not
# "no changes" (WhiteHat L2) -- only "applied" carries counts at all.
if [ "$action" = "applied" ]; then
  updated=$(echo "$response" | jq -r '.sync.counts.updated // "missing"' 2>/dev/null || echo "missing")
  inserted=$(echo "$response" | jq -r '.sync.counts.inserted // "missing"' 2>/dev/null || echo "missing")
  removed=$(echo "$response" | jq -r '.sync.counts.removed // "missing"' 2>/dev/null || echo "missing")
  for c in "$updated" "$inserted" "$removed"; do
    is_int "$c" || fail "action=applied but counts are non-numeric/missing (updated=$updated, inserted=$inserted, removed=$removed)"
  done
  total_changed=$(( 10#$updated + 10#$inserted + 10#$removed ))
  counts_str="updated=$updated, inserted=$inserted, removed=$removed"
else
  total_changed=0
  counts_str="no changes"
fi

# Log the result (always)
log_msg="freellmapi catalog: version=$version (action=$action), $counts_str"
echo "$log_msg"

# Notify dashboard only when models actually changed.
if [ "$total_changed" -gt 0 ]; then
  notify "OK" "$log_msg"
fi

exit 0
