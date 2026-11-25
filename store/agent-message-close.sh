#!/usr/bin/env bash
# Wrapper for closing an inter-agent message (PUT /api/messages/<id>), so a generated agent
# prompt can name ONE command instead of teaching the curl recipe inline (card 01eb0d0c).
#
# Covers the two documented failure modes of the hand-rolled recipe:
#   - "notify" must be a real JSON boolean, not the string "false" (400 + no close happens).
#   - a free-text --result containing a quote or backtick must never be shell-interpolated into
#     a double-quoted -d payload (root CLAUDE.md's level-1-approval note: that form lets the
#     shell execute `` `...` `` / `$(...)` inside the payload before curl ever sees it).
# Both are closed here by building the JSON body with python3's json.dumps and sending it via
# `curl --data-binary @file`, never by string-interpolating into a shell-quoted -d argument.
#
#   store/agent-message-close.sh <agent> <message-id> [--status done|failed] [--result <text>] [--notify true|false]
#
# Defaults: --status done, --notify false (the common case per the CLAUDE.md rule this replaces
# is closing an INCOMING report/notification, where the ack-of-the-ack would otherwise cost the
# sender an extra agent turn). Pass --notify true for a DELEGATED task whose sender is waiting on
# the --result as the actual answer.
#
# Exit: 0 ok | 2 bad usage | 4 no token available | 5 request failed (prints server body)
set -euo pipefail

SELF_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD_ORIGIN="${MARVEEN_DASHBOARD_ORIGIN:-http://localhost:3420}"

die() { echo "agent-message-close.sh: $2" >&2; exit "$1"; }

AGENT="${1:-}"
MSG_ID="${2:-}"
[ -n "$AGENT" ] && [ -n "$MSG_ID" ] || die 2 "usage: agent-message-close.sh <agent> <message-id> [--status done|failed] [--result <text>] [--notify true|false]"
shift 2

STATUS="done"
RESULT=""
HAVE_RESULT=0
NOTIFY="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --status)
      STATUS="${2:-}"; shift 2 || die 2 "--status needs a value"
      [ "$STATUS" = "done" ] || [ "$STATUS" = "failed" ] || die 2 "--status must be done or failed"
      ;;
    --result)
      RESULT="${2:-}"; HAVE_RESULT=1; shift 2 || die 2 "--result needs a value"
      ;;
    --notify)
      NOTIFY="${2:-}"; shift 2 || die 2 "--notify needs a value"
      [ "$NOTIFY" = "true" ] || [ "$NOTIFY" = "false" ] || die 2 "--notify must be true or false"
      ;;
    *)
      die 2 "unknown argument: $1"
      ;;
  esac
done

AUTH_HEADER="$("$SELF_DIR/agent-auth-header.sh" "$AGENT")" || die 4 "could not obtain auth header"

PAYLOAD_FILE="$(mktemp)"
trap 'rm -f "$PAYLOAD_FILE"' EXIT

STATUS="$STATUS" RESULT="$RESULT" HAVE_RESULT="$HAVE_RESULT" NOTIFY="$NOTIFY" python3 -I -c '
import json, os
body = {"status": os.environ["STATUS"], "notify": os.environ["NOTIFY"] == "true"}
if os.environ["HAVE_RESULT"] == "1":
    body["result"] = os.environ["RESULT"]
print(json.dumps(body))
' > "$PAYLOAD_FILE"

HTTP_CODE="$(printf '%s\n' "$AUTH_HEADER" \
  | curl -s -H @- -X PUT "$DASHBOARD_ORIGIN/api/messages/$MSG_ID" \
    -H "Content-Type: application/json" \
    --data-binary "@$PAYLOAD_FILE" \
    -o "$PAYLOAD_FILE.resp" -w '%{http_code}')"

BODY="$(cat "$PAYLOAD_FILE.resp")"
rm -f "$PAYLOAD_FILE.resp"

if [ "$HTTP_CODE" = "200" ]; then
  echo "$BODY"
  exit 0
fi

# 409 on an already-closed message is documented as a no-op, not a failure worth retrying.
if [ "$HTTP_CODE" = "409" ]; then
  echo "$BODY" >&2
  echo "agent-message-close.sh: message $MSG_ID already closed (409) -- not an error, do not retry" >&2
  exit 0
fi

echo "agent-message-close.sh: PUT failed (http $HTTP_CODE): $BODY" >&2
exit 5
