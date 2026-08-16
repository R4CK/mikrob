#!/bin/bash
# Resolve vault: references in env vars, then exec the real command.
# Claude Code launches this as the MCP server "command". The actual
# server command + args are passed as arguments to this script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Find node binary
NODE=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
if [ -z "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE" ]; then
  echo "vault-env-wrapper: node not found" >&2
  exit 1
fi

# Collect vault: references from env
REFS=""
for var in $(env | grep '=vault:' | cut -d= -f1); do
  val="${!var}"
  secret_id="${val#vault:}"
  REFS="${REFS}${var}=${secret_id}"$'\n'
done

if [ -n "$REFS" ]; then
  RESOLVED=$(printf '%s' "$REFS" | "$NODE" "$PROJECT_ROOT/scripts/vault-resolve.mjs")
  while IFS='=' read -r key value; do
    [ -n "$key" ] && export "$key"="$value"
  done <<< "$RESOLVED"

  # Fail-closed check (card 42fadae5): vault-resolve.mjs silently drops any secret_id it
  # can't find, so RESOLVED can come back with fewer names than REFS asked for. Exec-ing
  # anyway leaves the literal "vault:<id>" string sitting in that env var, and it goes out
  # over the network as a credential. Compare NAME sets only -- never values -- so the
  # error path can name the variable + secret id without ever touching a resolved secret.
  RESOLVED_NAMES=$(printf '%s' "$RESOLVED" | cut -d= -f1)
  MISSING=""
  while IFS='=' read -r req_var req_secret_id; do
    [ -z "$req_var" ] && continue
    if ! grep -qx "$req_var" <<< "$RESOLVED_NAMES"; then
      MISSING="${MISSING}  ${req_var} (vault:${req_secret_id})"$'\n'
    fi
  done <<< "$REFS"

  if [ -n "$MISSING" ]; then
    echo "vault-env-wrapper: unresolved vault: reference(s), refusing to start:" >&2
    printf '%s' "$MISSING" >&2
    exit 1
  fi
fi

exec "$@"
