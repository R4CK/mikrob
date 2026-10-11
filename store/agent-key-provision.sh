#!/usr/bin/env bash
# Mint/rotate/revoke a per-agent agent:<id> dashboard device key (card 9655494c, F1).
#
# F1-B1 (RedHat NO-GO 17005, MikroB decision 17006): this used to go over HTTP, session-only. That
# gate never separated "the owner" from "anyone holding the one shared store/.dashboard-token":
# the token can itself create the first dashboard user (bootstrap) or break-glass-reset an
# existing owner's password, then log in as that user and present the resulting session. The fix
# is structural, not a stronger HTTP check -- POST/DELETE /api/auth/agent-keys now always refuse
# (403), and this script calls the LOCAL `dashboard-user` CLI directly instead: same trust root as
# every other break-glass command in that tool ("you can run this on the machine" IS the
# credential), straight to the database, no HTTP round-trip and therefore no session to forge.
#
#   store/agent-key-provision.sh <agent>              # mint a new key (fails if one already exists)
#   store/agent-key-provision.sh <agent> --rotate     # revoke the existing key, mint a fresh one
#   store/agent-key-provision.sh <agent> --revoke     # revoke only, no new key
#
# Exit: 0 ok | 2 bad usage | 4 mint/revoke call failed
set -euo pipefail

MARVEEN_MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"
AGENTS_ROOT="${MARVEEN_AGENTS_ROOT:-/home/neon/marveen/agents}"

die() { echo "agent-key-provision.sh: $2" >&2; exit "$1"; }

AGENT="${1:-}"
ACTION="mint"
case "${2:-}" in
  --rotate) ACTION="rotate" ;;
  --revoke) ACTION="revoke" ;;
  "") ;;
  *) die 2 "unknown flag: ${2}" ;;
esac

[ -n "$AGENT" ] || die 2 "usage: agent-key-provision.sh <agent> [--rotate|--revoke]"
[[ "$AGENT" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || die 2 "invalid agent id (lowercase letters/digits/-, 1-32 chars): $AGENT"

AGENT_DIR="$AGENTS_ROOT/$AGENT"
[ -d "$AGENT_DIR" ] || die 2 "no such agent directory: $AGENT_DIR"
[ -d "$MARVEEN_MAIN/.git" ] || die 2 "no marveen clone at $MARVEEN_MAIN (set MARVEEN_MAIN)"

if [ "$ACTION" = "revoke" ]; then
  npm run --prefix "$MARVEEN_MAIN" --silent dashboard-user -- agent-key:revoke "$AGENT" \
    || die 4 "revoke failed"
  rm -f "$AGENT_DIR/.dashboard-agent-key"
  echo "agent-key-provision.sh: revoked the agent:$AGENT key."
  exit 0
fi

MINT_ARGS=("$AGENT")
[ "$ACTION" = "rotate" ] && MINT_ARGS+=("--rotate")

# The raw key exists ONLY in this command's stdout, once. Write it straight to the agent's own
# config directory at 0600 -- never echo it, never let it land in this script's own stderr/log.
KEY_FILE="$AGENT_DIR/.dashboard-agent-key"
RAW_KEY="$(npm run --prefix "$MARVEEN_MAIN" --silent dashboard-user -- agent-key:mint "${MINT_ARGS[@]}")" \
  || die 4 "mint failed"
install -m 600 /dev/null "$KEY_FILE"
printf '%s' "$RAW_KEY" > "$KEY_FILE"
unset RAW_KEY

echo "agent-key-provision.sh: minted agent:$AGENT -> $KEY_FILE (0600, not printed)."
