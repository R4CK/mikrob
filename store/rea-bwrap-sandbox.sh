#!/usr/bin/env bash
# bwrap sandbox wrapper for the REA MCP server (card ca1b763c, c7e0d83f R1+R2).
#
# Isolates the rea-agents MCP server process (Ghidra/JADX/Kuna/Hopper engines)
# from the flotta's shared environment and filesystem:
#   - env -i with ONLY the 7 engine env vars rea needs (6 required +
#     HOPPER_LAUNCHER_PATH optional), dropping everything else the host
#     process would otherwise inherit (SSH_AUTH_SOCK, GPG_AGENT_INFO,
#     CLAUDE_CODE_MESSAGING_TOKEN/SOCKET, CLAUDE_CONFIG_DIR, *_STATE_DIR, ...).
#     This env -i wraps bwrap ITSELF, not just the process bwrap execs inside
#     the sandbox (WhiteHat N1 HIGH, card ca1b763c, komment 23023): with
#     --unshare-pid, the bwrap process becomes pid 1 of the new pid
#     namespace, and /proc/1/environ is readable from inside the sandbox. An
#     `env -i ... bwrap ... env -i ... node` shape (env -i only around the
#     exec'd node) leaves bwrap's OWN process -- pid 1 -- running with the
#     wrapper's full, unstripped caller environment, so a sandboxed engine
#     reading /proc/1/environ sees everything the inner env -i was supposed
#     to hide. --clearenv does not fix this either (bwrap's own already-
#     inherited environment is unaffected by a flag describing the sandboxed
#     child's). The fix is structural: strip the environment ONCE, before
#     bwrap itself starts, so every process in the pid namespace (bwrap as
#     pid 1, node as pid 2) inherits the same already-minimal 7 names.
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
#   - --new-session, --die-with-parent: cheap additional hardening (WhiteHat
#     N5 LOW) -- drops the sandboxed process out of the caller's terminal
#     session, and guarantees it cannot outlive the wrapper if the wrapper is
#     killed.
#
# This wrapper is invoked AS the `command` in the MCP client registration
# (elemzo's .claude.json `mcpServers.rea`), in place of calling `npx` directly.
# It expects the SAME env block the registration already carries (6 required
# vars + optional HOPPER_LAUNCHER_PATH); everything else from the caller's
# environment is dropped.
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

# Resolve bwrap/env/node at FIXED, trusted absolute paths, never via a bare-name PATH search
# (RedHat NO-GO, card ca1b763c, komment 23049): the registered PATH's first element is
# $JAVA_HOME/bin, a directory owned and writable by the same user (neon) the wrapper and every
# engine run as. A bare `bwrap`/`env`/`node` call resolves against THAT PATH -- a binary planted
# there under one of these three names would run instead of the real one, before any isolation
# takes effect. None of these candidate directories are user-writable.
resolve_trusted_bin() {
  local name="$1" cand
  for cand in /usr/bin/"$name" /bin/"$name" /usr/local/bin/"$name"; do
    if [ -x "$cand" ]; then
      echo "$cand"
      return 0
    fi
  done
  echo "rea-bwrap-sandbox: $name not found at a trusted absolute path (/usr/bin, /bin, /usr/local/bin) -- refusing to start (fail-closed)" >&2
  exit 1
}
ENV_BIN="$(resolve_trusted_bin env)"
BWRAP_BIN="$(resolve_trusted_bin bwrap)"
NODE_BIN="$(resolve_trusted_bin node)"

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
  HOPPER_BIN_DIR="$(dirname "$HOPPER_LAUNCHER_PATH")"
  BIND_ARGS+=(--ro-bind "$HOPPER_BIN_DIR" "$HOPPER_BIN_DIR")
  # Hopper's launcher dynamically links libHopperCore.so and five sibling libs out of a `lib/`
  # directory next to `bin/` (ldd: libHopperCore.so, libdispatch.so, libpthread_workqueue.so,
  # libkqueue.so, libgnustep-base.so, libobjc.so, libxml2.so, libffi.so, libBlocksRuntime.so, via
  # an rpath of ../lib) -- QA F1 BLOCKER (card ca1b763c, komment 23032): binding only bin/ left
  # these unresolved inside the sandbox, breaking Hopper there specifically (every other
  # dependency resolves from /usr, already ro-bound). Bind that sibling lib/ dir too, read-only.
  HOPPER_LIB_DIR="$(dirname "$HOPPER_BIN_DIR")/lib"
  if [ -d "$HOPPER_LIB_DIR" ]; then
    BIND_ARGS+=(--ro-bind "$HOPPER_LIB_DIR" "$HOPPER_LIB_DIR")
  fi
fi

mkdir -p "$HOME/.cache/rea"

# The MCP client registration (elemzo's .claude.json) calls this wrapper with NO arguments, and
# that case must always start the `mcp` server -- so "mcp" cannot simply be dropped. But a
# fixed, unconditional "mcp" prefix made the wrapper unable to ever reach rea's top-level
# `doctor` (per-engine health: ghidra/jadx/kuna/hopper), only `mcp doctor` (the MCP protocol
# self-check, a different command) -- QA F2 (card ca1b763c, komment 23032): a REVIEW claim about
# per-engine doctor output measured "through the wrapper" was not actually reproducible through
# the wrapper as shipped. `doctor` as the first argument now runs rea's top-level command
# directly (still through the same sandbox/env); anything else still gets the `mcp` prefix.
if [ "${1:-}" = "doctor" ]; then
  REA_ARGS=("$@")
else
  REA_ARGS=(mcp "$@")
fi

# env -i wraps bwrap ITSELF (see the N1 fix note in the header comment): bwrap's own process
# becomes pid 1 of the new pid namespace, so its environment must already be the minimal 7 names
# before it starts, not stripped only for the node process it execs afterward.
# $ENV_BIN/$BWRAP_BIN/$NODE_BIN are trusted absolute paths resolved above, not bare names --
# the registered PATH itself still needs to be a minimal, allowed value for the sandboxed REA
# process to use (rea-agents resolves its own child tools via it), it just must never be used to
# look up bwrap/env/node themselves (RedHat NO-GO, komment 23049).
exec "$ENV_BIN" -i \
  HOME="$HOME" \
  PATH="$PATH" \
  JAVA_HOME="$JAVA_HOME" \
  GHIDRA_INSTALL_DIR="$GHIDRA_INSTALL_DIR" \
  REA_JADX_MCP_JAR="$REA_JADX_MCP_JAR" \
  REA_KUNA_COMMAND="$REA_KUNA_COMMAND" \
  ${HOPPER_LAUNCHER_PATH:+HOPPER_LAUNCHER_PATH="$HOPPER_LAUNCHER_PATH"} \
"$BWRAP_BIN" "${BIND_ARGS[@]}" --new-session --die-with-parent \
  "$NODE_BIN" "$REA_SCRIPT" "${REA_ARGS[@]}"
