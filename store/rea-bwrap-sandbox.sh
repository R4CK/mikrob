#!/usr/bin/env bash
# bwrap sandbox wrapper for the REA MCP server (card ca1b763c, c7e0d83f R1+R2).
#
# Isolates the rea-agents MCP server process (Ghidra/JADX/Kuna/Hopper engines)
# from the flotta's shared environment and filesystem:
#   - env -i with ONLY the 6 engine env vars rea needs, dropping everything else
#     the host process would otherwise inherit (SSH_AUTH_SOCK, GPG_AGENT_INFO,
#     CLAUDE_CODE_MESSAGING_TOKEN/SOCKET, CLAUDE_CONFIG_DIR, *_STATE_DIR, ...).
#   - a minimal filesystem view: only the engine install dirs, the npm package
#     cache (read-only) and rea's own cache dir are visible. No flotta secret
#     (store/.dashboard-token), no other agent's files, no unrelated /home/neon
#     content.
#   - --unshare-net: no network namespace. The 4 installed engines (Ghidra,
#     JADX, Kuna, Hopper) are local-binary analysis tools and do not need
#     network at analysis time; the one-time Hopper download/activation
#     already happened outside this wrapper, via `rea setup`.
#   - --unshare-pid: own PID namespace. Measured necessary, not just defensive:
#     without it, rea's own ghidra-java health probe intermittently fails
#     with EACCES reading /proc/<pid>/environ of its own short-lived child
#     (the exited probe's PID can be reused by an unrelated host process by
#     the time rea's cleanup check reads it back).
#
# This wrapper is invoked AS the `command` in the MCP client registration
# (elemzo's .claude.json `mcpServers.rea`), in place of calling `npx` directly.
# It expects the SAME env block the registration already carries (6 vars);
# everything else from the caller's environment is dropped.
set -euo pipefail

REQUIRED_VARS=(PATH HOME JAVA_HOME GHIDRA_INSTALL_DIR REA_JADX_MCP_JAR REA_KUNA_COMMAND)
for v in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!v:-}" ]; then
    echo "rea-bwrap-sandbox: missing required env var $v -- refusing to start (fail-closed)" >&2
    exit 1
  fi
done

# HOPPER_LAUNCHER_PATH is optional (Hopper may not be installed/registered yet).
HOPPER_LAUNCHER_PATH="${HOPPER_LAUNCHER_PATH:-}"

REA_VERSION="6.7.0"
REA_SCRIPT=""
for pkg_json in "$HOME"/.npm/_npx/*/node_modules/rea-agents/package.json; do
  [ -f "$pkg_json" ] || continue
  if grep -q "\"version\": \"$REA_VERSION\"" "$pkg_json" 2>/dev/null; then
    REA_SCRIPT="$(dirname "$pkg_json")/scripts/rea.mjs"
    break
  fi
done
if [ -z "$REA_SCRIPT" ] || [ ! -f "$REA_SCRIPT" ]; then
  echo "rea-bwrap-sandbox: could not locate a cached rea-agents@$REA_VERSION install under $HOME/.npm/_npx -- run 'npx -y rea-agents@$REA_VERSION --version' once outside the sandbox first" >&2
  exit 1
fi

BIND_ARGS=(
  --unshare-pid --unshare-net --unshare-ipc --unshare-uts
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /etc /etc
  --dir "$HOME"
  --ro-bind "$HOME/.npm" "$HOME/.npm"
  --ro-bind "$GHIDRA_INSTALL_DIR" "$GHIDRA_INSTALL_DIR"
  --ro-bind "$JAVA_HOME" "$JAVA_HOME"
  --ro-bind "$(dirname "$REA_JADX_MCP_JAR")" "$(dirname "$REA_JADX_MCP_JAR")"
  --ro-bind "$(dirname "$REA_KUNA_COMMAND")" "$(dirname "$REA_KUNA_COMMAND")"
  --bind "$HOME/.cache/rea" "$HOME/.cache/rea"
  --proc /proc --dev /dev --tmpfs /tmp
)
if [ -n "$HOPPER_LAUNCHER_PATH" ] && [ -e "$HOPPER_LAUNCHER_PATH" ]; then
  BIND_ARGS+=(--ro-bind "$(dirname "$HOPPER_LAUNCHER_PATH")" "$(dirname "$HOPPER_LAUNCHER_PATH")")
fi

mkdir -p "$HOME/.cache/rea"

exec bwrap "${BIND_ARGS[@]}" \
  env -i \
    HOME="$HOME" \
    PATH="$PATH" \
    JAVA_HOME="$JAVA_HOME" \
    GHIDRA_INSTALL_DIR="$GHIDRA_INSTALL_DIR" \
    REA_JADX_MCP_JAR="$REA_JADX_MCP_JAR" \
    REA_KUNA_COMMAND="$REA_KUNA_COMMAND" \
    ${HOPPER_LAUNCHER_PATH:+HOPPER_LAUNCHER_PATH="$HOPPER_LAUNCHER_PATH"} \
  node "$REA_SCRIPT" mcp "$@"
