#!/usr/bin/env bash
# Mint/rotate/revoke a per-agent agent:<id> dashboard device key (card 9655494c, F1).
#
# Deliberately a MANUAL, interactive, owner-run script, never called with the shared
# store/.dashboard-token: POST and DELETE /api/auth/agent-keys are session-only on the server
# (CREDENTIAL_MINT_KINDS) specifically so the one token every fleet script already holds cannot
# mint or retire an agent's own identity credential. This script logs in as a real dashboard user
# (prompted interactively, never read from an env var or argv -- see note below) to get that
# session, then writes the raw key ONLY to the target agent's own config directory at 0600, and
# never to stdout, a log file, a commit, or an inter-agent message.
#
#   store/agent-key-provision.sh <agent>              # mint a new key (fails if one already exists)
#   store/agent-key-provision.sh <agent> --rotate     # revoke the existing key, mint a fresh one
#   store/agent-key-provision.sh <agent> --revoke     # revoke only, no new key
#
# Exit: 0 ok | 2 bad usage | 3 login failed | 4 mint/revoke call failed
set -euo pipefail

DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:3420}"
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

# Login is interactive -- never pass credentials as argv (visible in /proc/<pid>/cmdline to any
# local process, and in shell history) or an env var (visible in the environment of every child
# process and in a crash dump). read -s keeps the password off the terminal and off history.
read -r -p "Dashboard username (owner session): " DASH_USER
read -r -s -p "Dashboard password: " DASH_PASS
echo

# F1-B2 (RedHat NO-GO 16825): every file that can ever hold a credential (cookie, login payload,
# mint payload, mint response) lives in ONE 0700 scratch dir, removed by a SINGLE EXIT trap --
# not a per-file `rm -f` after each step, which a `set -e` die on an earlier line (e.g. curl
# failing because the dashboard is unreachable) skips entirely, leaving that one file's plaintext
# secret behind in $TMPDIR.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
COOKIE_JAR="$WORK/cookies"
LOGIN_PAYLOAD="$WORK/login.json"
MINT_PAYLOAD="$WORK/mint.json"
RESPONSE="$WORK/response.json"

# Neither credential goes into argv (visible to any local process via /proc/<pid>/cmdline, the
# QA FAIL this fixes, comment 16667/16670): both go over this process's own stdin instead, which
# only the parent shell holding the pipe can see.
printf '%s\n%s\n' "$DASH_USER" "$DASH_PASS" | python3 -c "
import json, sys
user = sys.stdin.readline().rstrip('\n')
password = sys.stdin.readline().rstrip('\n')
json.dump({'username': user, 'password': password}, open(sys.argv[1], 'w'))
" "$LOGIN_PAYLOAD"
unset DASH_PASS

LOGIN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_JAR" -X POST "$DASHBOARD_URL/api/auth/login" -H 'Content-Type: application/json' --data-binary "@$LOGIN_PAYLOAD")"
[ "$LOGIN_STATUS" = "200" ] || die 3 "login failed (http $LOGIN_STATUS) -- wrong credentials, or no dashboard_users row exists yet (create one first)"

if [ "$ACTION" = "revoke" ]; then
  STATUS="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" -X DELETE "$DASHBOARD_URL/api/auth/agent-keys/$AGENT")"
  [ "$STATUS" = "200" ] || die 4 "revoke failed (http $STATUS)"
  rm -f "$AGENT_DIR/.dashboard-agent-key"
  echo "agent-key-provision.sh: revoked the agent:$AGENT key."
  exit 0
fi

ROTATE_FLAG="false"
[ "$ACTION" = "rotate" ] && ROTATE_FLAG="true"
python3 -c "import json,sys; json.dump({'agent_id': sys.argv[1], 'rotate': sys.argv[2] == 'true'}, open(sys.argv[3], 'w'))" "$AGENT" "$ROTATE_FLAG" "$MINT_PAYLOAD"

STATUS="$(curl -s -o "$RESPONSE" -w '%{http_code}' -b "$COOKIE_JAR" -X POST "$DASHBOARD_URL/api/auth/agent-keys" -H 'Content-Type: application/json' --data-binary "@$MINT_PAYLOAD")"
if [ "$STATUS" != "201" ]; then
  ERR="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('error','?'))" "$RESPONSE" 2>/dev/null || echo "?")"
  die 4 "mint failed (http $STATUS): $ERR"
fi

# The raw key exists ONLY in this response, once. Write it straight to the agent's own config
# directory at 0600 -- never echo it, never let it land in this script's own stdout/stderr log.
KEY_FILE="$AGENT_DIR/.dashboard-agent-key"
python3 -c "
import json, sys, os
resp = json.load(open(sys.argv[1]))
out = sys.argv[2]
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write(resp['key'])
" "$RESPONSE" "$KEY_FILE"
chmod 600 "$KEY_FILE"

echo "agent-key-provision.sh: minted agent:$AGENT -> $KEY_FILE (0600, not printed)."
