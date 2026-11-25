#!/usr/bin/env bash
# Wrapper for closing an inter-agent message (PUT /api/messages/<id>), so a generated agent
# prompt can name ONE command instead of teaching the curl recipe inline (card 01eb0d0c).
#
# Covers the documented failure modes of the hand-rolled recipe:
#   - "notify" must be a real JSON boolean, not the string "false" (400 + no close happens).
#   - a free-text result must never be shell-interpolated into a double-quoted -d payload
#     (root CLAUDE.md's level-1-approval note: that form lets the shell execute `` `...` ``/
#     `$(...)` inside the payload BEFORE curl, or even this script, ever sees it -- CYBERSEC
#     NO-GO 38468, F1: the FIRST version of this wrapper's own generated docs taught exactly
#     that dangerous `--result "..."` shape). --result-file / --result-stdin read the text as
#     raw bytes from a file descriptor, never through shell word-splitting/expansion, so this
#     is not just "the wrapper is safe if called right" -- the UNSAFE call shape is gone from
#     what is taught at all. A literal `--result <text>` argument still works for a caller that
#     already has the text in a variable via a SINGLE-quoted/here-doc-safe path, but is not the
#     form the generated prompt shows, and the usage text here warns about it directly.
# Both are closed by building the JSON body with python3's json.dumps and sending it via
# `curl --data-binary @file`, never by string-interpolating into a shell-quoted -d argument.
#
#   store/agent-message-close.sh <agent> <message-id> [--status done|failed] [--notify true|false] \
#     [--result-file <path> | --result-stdin | --result <text>]
#
# --result-file/--result-stdin are the TAUGHT forms (no shell quoting risk at all -- write the
# text with the Write tool, then pass its path, or pipe it in). --result <text> is accepted for
# scripts that already hold the value safely, but NEVER put it in double quotes on a command
# line: a backtick or $(...) inside it executes in YOUR shell before this script runs.
#
# Defaults: --status done, --notify false (the common case per the CLAUDE.md rule this replaces
# is closing an INCOMING report/notification, where the ack-of-the-ack would otherwise cost the
# sender an extra agent turn). Pass --notify true for a DELEGATED task whose sender is waiting on
# the result as the actual answer.
#
# Exit: 0 ok | 2 bad usage | 4 no token available | 5 request failed (prints server body)
set -euo pipefail

SELF_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD_ORIGIN="${MARVEEN_DASHBOARD_ORIGIN:-http://localhost:3420}"
# CYBERSEC NO-GO 38468, LOW2: an env override with no loopback check sends the bearer token to
# any host it names. CYBERSEC GO 3a38fe2cc, LOW-3: the first fix was a glob (http://localhost:*),
# which matches past the port into a userinfo ("http://localhost:1@127.0.0.2:PORT", host actually
# 127.0.0.2) or a suffix ("http://localhost:80.attacker.invalid", port actually non-numeric
# garbage) -- both sent the token off-loopback in a live probe. This anchors the WHOLE string:
# scheme, exactly localhost/127.0.0.1/[::1], then nothing or a numeric port, end of string.
# MARVEEN_SELFTEST_ALLOW_REMOTE=1 is for this script's own selftest only.
if [ "${MARVEEN_SELFTEST_ALLOW_REMOTE:-0}" != "1" ]; then
  if ! [[ "$DASHBOARD_ORIGIN" =~ ^https?://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?$ ]]; then
    echo "agent-message-close.sh: MARVEEN_DASHBOARD_ORIGIN must be localhost/127.0.0.1, got: $DASHBOARD_ORIGIN" >&2
    exit 2
  fi
fi

die() { echo "agent-message-close.sh: $2" >&2; exit "$1"; }

AGENT="${1:-}"
MSG_ID="${2:-}"
[ -n "$AGENT" ] && [ -n "$MSG_ID" ] || die 2 "usage: agent-message-close.sh <agent> <message-id> [--status done|failed] [--notify true|false] [--result-file <path> | --result-stdin | --result <text>]"
# CYBERSEC NO-GO 38468, LOW1: an unvalidated id let path segments (../../kanban/zzz) through to
# the URL, curl normalising the dots -- the token-bearing PUT then targets an arbitrary path.
[[ "$MSG_ID" =~ ^[0-9]+$ ]] || die 2 "message-id must be a plain positive integer, got: $MSG_ID"
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
    --result-file)
      RESULT="$(cat -- "${2:?--result-file needs a path}")"; HAVE_RESULT=1; shift 2
      ;;
    --result-stdin)
      RESULT="$(cat)"; HAVE_RESULT=1; shift
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
trap 'rm -f "$PAYLOAD_FILE" "$PAYLOAD_FILE.resp"' EXIT

STATUS="$STATUS" RESULT="$RESULT" HAVE_RESULT="$HAVE_RESULT" NOTIFY="$NOTIFY" python3 -I -c '
import json, os
body = {"status": os.environ["STATUS"], "notify": os.environ["NOTIFY"] == "true"}
if os.environ["HAVE_RESULT"] == "1":
    body["result"] = os.environ["RESULT"]
print(json.dumps(body))
' > "$PAYLOAD_FILE"

# CYBERSEC NO-GO 38468, LOW3: -s alone silences curl's own connection-failure message, and a
# dead dashboard then reports as http_code "000" with no explanation, mapped below to the same
# exit 5 as a real HTTP failure so "exit 5 means the request did not run" stays true either way.
HTTP_CODE="$(printf '%s\n' "$AUTH_HEADER" \
  | curl -sS -H @- -X PUT "$DASHBOARD_ORIGIN/api/messages/$MSG_ID" \
    -H "Content-Type: application/json" \
    --data-binary "@$PAYLOAD_FILE" \
    -o "$PAYLOAD_FILE.resp" -w '%{http_code}' || echo "000")"

BODY="$(cat "$PAYLOAD_FILE.resp" 2>/dev/null || true)"

if [ "$HTTP_CODE" = "200" ]; then
  echo "$BODY"
  exit 0
fi

# 409 on an already-closed message is documented as a no-op, not a failure worth retrying.
# CYBERSEC NO-GO 38468, LOW4: the server's own current status (already in $BODY) is now
# surfaced explicitly, not just implied, so a caller that only reads this line still learns the
# result it passed was NOT delivered.
if [ "$HTTP_CODE" = "409" ]; then
  echo "$BODY" >&2
  echo "agent-message-close.sh: message $MSG_ID already closed (409) -- current server state above, your result/notify were NOT applied; not an error, do not retry" >&2
  exit 0
fi

echo "agent-message-close.sh: PUT failed (http $HTTP_CODE): $BODY" >&2
exit 5
