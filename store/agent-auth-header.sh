#!/usr/bin/env bash
# Print "Authorization: Bearer <value>" for `curl -H @-`, using the calling agent's own
# agent:<id> device key (card 9655494c) when it has one, falling back to the fleet's shared
# store/.dashboard-token otherwise (card 52114c2f, 2520b85a slice 2.5).
#
# The server accepts either value in the SAME Bearer slot (src/web/auth-gate.ts resolves the
# kind by matching the value, not by a different header) -- so this script only has to pick
# WHICH token value goes out, never a different header shape.
#
#   store/agent-auth-header.sh <agent>
#
# Exit: 0 ok | 2 bad usage | 4 no token available (neither an agent key nor the shared token)
set -euo pipefail

MARVEEN_MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"
AGENTS_ROOT="${MARVEEN_AGENTS_ROOT:-/home/neon/marveen/agents}"

die() { echo "agent-auth-header.sh: $2" >&2; exit "$1"; }

AGENT="${1:-}"
[ -n "$AGENT" ] || die 2 "usage: agent-auth-header.sh <agent>"

# Card 52114c2f (CYBERED NO-GO 34673, F2+L1): this script used to print ANY agent's key for ANY
# name with no binding to the caller -- the only control was agent-key-secret-guard.py's
# early-exit on command TEXT containing "agent-key"/"dashboard-agent-key", which this script's
# own filename never matched (closed separately, in that file). Validate the name (same
# convention as agent-key-provision.sh), then require it to match the CALLER's own identity:
# MARVEEN_AGENT_ID or CLAUDE_AGENT_ID (same precedence as that guard's _self_agent), falling back
# to a .../agents/<name>(/|$) match in $PWD. If self cannot be determined at all, refuse rather
# than dispense a key to an unverified caller -- unlike the lint-guard's documented fail-open
# posture ("a speed bump, not a kernel-enforced control"), THIS script is the actual credential
# boundary the guard sits in front of, so it fails closed instead.
[[ "$AGENT" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || die 2 "invalid agent name"

SELF="${MARVEEN_AGENT_ID:-${CLAUDE_AGENT_ID:-}}"
if [ -z "$SELF" ]; then
  case "$PWD" in
    */agents/*)
      SELF="${PWD#*/agents/}"
      SELF="${SELF%%/*}"
      ;;
  esac
fi
[ -n "$SELF" ] || die 2 "cannot determine caller identity (MARVEEN_AGENT_ID/CLAUDE_AGENT_ID unset, cwd not under agents/<name>)"
[ "$SELF" = "$AGENT" ] || die 2 "refusing: caller identity does not match the requested agent"

KEY_FILE="$AGENTS_ROOT/$AGENT/.dashboard-agent-key"
SHARED_TOKEN_FILE="$MARVEEN_MAIN/store/.dashboard-token"

# Card 52114c2f (CYBERED NO-GO 34673, F3): the card's own acceptance criterion is "a MISSING OR
# EXPIRED agent key falls back ... never a silent failure" -- a present-but-DEAD key (revoked,
# rotated elsewhere, or overwritten with junk by any same-UID process) used to be printed as-is,
# with no fallback, so the server's own 401 was the first anyone would see. Probe the OWN key
# against a cheap authenticated endpoint before trusting it; only a 401 triggers the fallback
# (a probe that cannot complete at all -- dashboard unreachable -- proves nothing about the key,
# so it is used as given, same as before this fix).
PROBE_URL="${AGENT_AUTH_HEADER_PROBE_URL:-http://localhost:3420/api/agents}"
PROBE_TIMEOUT="${AGENT_AUTH_HEADER_PROBE_TIMEOUT:-3}"

probe_rejected() {
  local code
  code="$(printf 'Authorization: Bearer %s\n' "$1" \
    | curl -sS --max-time "$PROBE_TIMEOUT" -H @- -o /dev/null -w '%{http_code}' "$PROBE_URL" 2>/dev/null || echo 000)"
  [ "$code" = "401" ]
}

# Card 52114c2f (CYBERSEC NO-GO 34686, F3): a key file with a second line was emitted verbatim,
# which `curl -H @-` turns into a SECOND header line -- a same-UID writer of the file could inject
# e.g. a forged X-Agent-Id next to the real key. Use only the first line, and treat any embedded
# control character (a lone CR, or anything else non-printable) the same way as a dead/junk key.
if [ -s "$KEY_FILE" ]; then
  VALUE="$(head -n1 -- "$KEY_FILE")"
  VALUE="${VALUE%$'\r'}"
  LINE_COUNT="$(grep -c '' "$KEY_FILE" 2>/dev/null || echo 0)"
  if [[ "$VALUE" =~ [[:cntrl:]] ]] || [ "$LINE_COUNT" -gt 1 ]; then
    echo "agent-auth-header.sh: malformed agent key file for '$AGENT' ($KEY_FILE has a control character or more than one line, possible header injection), falling back to the shared token" >&2
    [ -s "$SHARED_TOKEN_FILE" ] || die 4 "malformed agent key and no shared token at $SHARED_TOKEN_FILE"
    VALUE="$(cat "$SHARED_TOKEN_FILE")"
  elif probe_rejected "$VALUE"; then
    echo "agent-auth-header.sh: agent key for '$AGENT' was rejected by the server (401, revoked/expired/junk), falling back to the shared token" >&2
    [ -s "$SHARED_TOKEN_FILE" ] || die 4 "agent key rejected and no shared token at $SHARED_TOKEN_FILE"
    VALUE="$(cat "$SHARED_TOKEN_FILE")"
  fi
else
  echo "agent-auth-header.sh: no agent key for '$AGENT' ($KEY_FILE missing or empty), falling back to the shared token" >&2
  [ -s "$SHARED_TOKEN_FILE" ] || die 4 "no agent key and no shared token at $SHARED_TOKEN_FILE"
  VALUE="$(cat "$SHARED_TOKEN_FILE")"
fi

printf 'Authorization: Bearer %s\n' "$VALUE"
