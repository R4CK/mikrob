#!/usr/bin/env bash
# Wrapper for GET /api/memories with the mandatory X-Memory-Search header check baked in
# (card 01eb0d0c). Replaces the hand-rolled "-D tempfile + grep" recipe every agent prompt used
# to carry inline: this script DOES the grep itself and refuses to let a relaxed/absent result
# look like a real hit.
#
#   store/agent-memory-search.sh <agent> <query> [--category hot|warm|cold|shared] \
#       [--date <expr>] [--since <YYYY-MM-DD>] [--until <YYYY-MM-DD>] [--strict]
#
# The query is percent-encoded here (curl -G --data-urlencode) so a raw accented character never
# produces the documented silent 400 (empty body, no X-Memory-Search header, grep finds nothing
# and looks exactly like a zero-hit search).
#
# Exit: 0 ok | 2 bad usage | 4 no token available | 5 request failed | 6 request succeeded but
# relaxed=true (approximate match, not what was asked -- treat the body as a hint, not evidence)
set -euo pipefail

SELF_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD_ORIGIN="${MARVEEN_DASHBOARD_ORIGIN:-http://localhost:3420}"
# CYBERSEC NO-GO 38468, LOW2 (both wrappers): an env override with no loopback check sends the
# bearer token to any host it names. CYBERSEC GO 3a38fe2cc, LOW-3: the first fix was a glob
# (http://localhost:*), which matches past the port into a userinfo
# ("http://localhost:1@127.0.0.2:PORT", host actually 127.0.0.2) or a suffix
# ("http://localhost:80.attacker.invalid", port actually non-numeric garbage) -- both sent the
# token off-loopback in a live probe. This anchors the WHOLE string: scheme, exactly
# localhost/127.0.0.1/[::1], then nothing or a numeric port, end of string.
# MARVEEN_SELFTEST_ALLOW_REMOTE=1 is for this script's own selftest only.
if [ "${MARVEEN_SELFTEST_ALLOW_REMOTE:-0}" != "1" ]; then
  if ! [[ "$DASHBOARD_ORIGIN" =~ ^https?://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?$ ]]; then
    echo "agent-memory-search.sh: MARVEEN_DASHBOARD_ORIGIN must be localhost/127.0.0.1, got: $DASHBOARD_ORIGIN" >&2
    exit 2
  fi
fi

die() { echo "agent-memory-search.sh: $2" >&2; exit "$1"; }

AGENT="${1:-}"
QUERY="${2:-}"
[ -n "$AGENT" ] && [ -n "$QUERY" ] || die 2 "usage: agent-memory-search.sh <agent> <query> [--category C] [--date D] [--since S] [--until U] [--strict]"
shift 2

CATEGORY=""
DATE_EXPR=""
SINCE=""
UNTIL=""
STRICT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --category) CATEGORY="${2:-}"; shift 2 || die 2 "--category needs a value" ;;
    --date) DATE_EXPR="${2:-}"; shift 2 || die 2 "--date needs a value" ;;
    --since) SINCE="${2:-}"; shift 2 || die 2 "--since needs a value" ;;
    --until) UNTIL="${2:-}"; shift 2 || die 2 "--until needs a value" ;;
    --strict) STRICT=1; shift ;;
    *) die 2 "unknown argument: $1" ;;
  esac
done

AUTH_HEADER="$("$SELF_DIR/agent-auth-header.sh" "$AGENT")" || die 4 "could not obtain auth header"

HEADER_FILE="$(mktemp)"
BODY_FILE="$(mktemp)"
trap 'rm -f "$HEADER_FILE" "$BODY_FILE"' EXIT

ARGS=(-s -G -o "$BODY_FILE" -D "$HEADER_FILE" --data-urlencode "agent=$AGENT" --data-urlencode "q=$QUERY")
[ -n "$CATEGORY" ] && ARGS+=(--data-urlencode "category=$CATEGORY")
[ -n "$DATE_EXPR" ] && ARGS+=(--data-urlencode "date=$DATE_EXPR")
[ -n "$SINCE" ] && ARGS+=(--data-urlencode "since=$SINCE")
[ -n "$UNTIL" ] && ARGS+=(--data-urlencode "until=$UNTIL")
[ "$STRICT" = "1" ] && ARGS+=(--data-urlencode "strict=1")

# CYBERSEC NO-GO 38468, LOW3 (both wrappers): -sS plus an explicit fallback so a connection
# failure maps to the documented "exit 5 means the request did not run", not a silent/raw abort.
HTTP_CODE="$(printf '%s\n' "$AUTH_HEADER" | curl -sS -H @- -w '%{http_code}' "${ARGS[@]}" "$DASHBOARD_ORIGIN/api/memories" || echo "000")"

if [ "$HTTP_CODE" != "200" ]; then
  echo "agent-memory-search.sh: request failed (http $HTTP_CODE): $(cat "$BODY_FILE")" >&2
  exit 5
fi

SEARCH_HEADER="$(grep -i '^x-memory-search:' "$HEADER_FILE" | tr -d '\r' || true)"
if [ -z "$SEARCH_HEADER" ]; then
  echo "agent-memory-search.sh: no X-Memory-Search header on a 200 response -- treat as a failed/unverifiable search, not a zero-hit one" >&2
  cat "$BODY_FILE"
  exit 5
fi

echo "$SEARCH_HEADER" >&2
cat "$BODY_FILE"

if echo "$SEARCH_HEADER" | grep -qi 'relaxed=true'; then
  echo "agent-memory-search.sh: relaxed=true -- this is a SAVED APPROXIMATION, not evidence of a real match" >&2
  exit 6
fi

exit 0
