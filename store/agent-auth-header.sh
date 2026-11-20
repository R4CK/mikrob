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

KEY_FILE="$AGENTS_ROOT/$AGENT/.dashboard-agent-key"
SHARED_TOKEN_FILE="$MARVEEN_MAIN/store/.dashboard-token"

if [ -s "$KEY_FILE" ]; then
  VALUE="$(cat "$KEY_FILE")"
else
  echo "agent-auth-header.sh: no agent key for '$AGENT' ($KEY_FILE missing or empty), falling back to the shared token" >&2
  [ -s "$SHARED_TOKEN_FILE" ] || die 4 "no agent key and no shared token at $SHARED_TOKEN_FILE"
  VALUE="$(cat "$SHARED_TOKEN_FILE")"
fi

printf 'Authorization: Bearer %s\n' "$VALUE"
