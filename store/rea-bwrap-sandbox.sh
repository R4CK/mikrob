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
#   - network: default-closed (--unshare-net), configurable per card 9518b377
#     (ca1b763c N2 follow-up) via REA_NET_ALLOW=1 for a session that genuinely
#     needs it (e.g. a signature/update lookup); fail-closed if unset.
#   - sample submission: read-only bind of REA_SAMPLE_DIR (if set), restricted
#     to a path under elemzo's own agent directory, excluding its own
#     .claude-config and any store/ path -- card 9518b377. Without this, the
#     sandbox cannot see any file elemzo wants analyzed at all.
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

# Configurable network egress (card 9518b377): default-closed, same as before this card.
REA_NET_ALLOW="${REA_NET_ALLOW:-0}"

# Configurable sample-submission bind (card 9518b377): default-closed (unset = no bind).
# Restricted to elemzo's own agent directory so this knob cannot be used to expose an
# unrelated agent's files or flotta secrets (store/.dashboard-token, .claude-config).
REA_SAMPLE_DIR="${REA_SAMPLE_DIR:-}"
RESOLVED_SAMPLE_DIR=""
if [ -n "$REA_SAMPLE_DIR" ]; then
  ELEMZO_ROOT="$(readlink -f /home/neon/marveen/agents/elemzo)"
  RESOLVED_SAMPLE_DIR="$(readlink -f "$REA_SAMPLE_DIR" 2>/dev/null || true)"
  case "$RESOLVED_SAMPLE_DIR" in
    "$ELEMZO_ROOT"/.claude-config*|*/store/*|"")
      echo "rea-bwrap-sandbox: REA_SAMPLE_DIR ($REA_SAMPLE_DIR) resolves to a config/secret path or could not be resolved -- refusing (fail-closed)" >&2
      exit 1
      ;;
    "$ELEMZO_ROOT"/*) ;;
    *)
      echo "rea-bwrap-sandbox: REA_SAMPLE_DIR ($REA_SAMPLE_DIR) is not under $ELEMZO_ROOT -- refusing (fail-closed)" >&2
      exit 1
      ;;
  esac
  if [ ! -d "$RESOLVED_SAMPLE_DIR" ]; then
    echo "rea-bwrap-sandbox: REA_SAMPLE_DIR ($REA_SAMPLE_DIR) does not exist or is not a directory -- refusing (fail-closed)" >&2
    exit 1
  fi
fi

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

# npx-cache integrity pin (card 9518b377, LOW): the version-string match above only checks
# package.json's self-reported version, not the actual script content -- a tampered or
# corrupted cache entry claiming the same version would pass silently. Pin the known-good
# hash of the vetted 6.7.0 script; refuse to start on any mismatch (fail-closed), rather than
# running unverified code against real samples. Update this constant (and re-verify the new
# hash through normal due diligence) only on a deliberate, reviewed version bump.
REA_SCRIPT_SHA256_PIN="ed06cee49505b95a3cc5fceb1b4b279167e26df86227c644bb366ffffdbaf738"
REA_SCRIPT_SHA256_ACTUAL="$(sha256sum "$REA_SCRIPT" | cut -d' ' -f1)"
if [ "$REA_SCRIPT_SHA256_ACTUAL" != "$REA_SCRIPT_SHA256_PIN" ]; then
  echo "rea-bwrap-sandbox: $REA_SCRIPT hash mismatch (expected $REA_SCRIPT_SHA256_PIN, got $REA_SCRIPT_SHA256_ACTUAL) -- refusing to start (fail-closed)" >&2
  exit 1
fi

BIND_ARGS=(
  --unshare-pid --unshare-ipc --unshare-uts
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /etc /etc
  --dir "$HOME"
  --ro-bind "$HOME/.npm" "$HOME/.npm"
  --ro-bind "$GHIDRA_INSTALL_DIR" "$GHIDRA_INSTALL_DIR"
  --ro-bind "$JAVA_HOME" "$JAVA_HOME"
  --ro-bind "$(dirname "$REA_JADX_MCP_JAR")" "$(dirname "$REA_JADX_MCP_JAR")"
  --ro-bind "$(dirname "$REA_KUNA_COMMAND")" "$(dirname "$REA_KUNA_COMMAND")"
  --proc /proc --dev /dev --tmpfs /tmp
)
if [ "$REA_NET_ALLOW" != "1" ]; then
  BIND_ARGS+=(--unshare-net)
fi
if [ -n "$RESOLVED_SAMPLE_DIR" ]; then
  BIND_ARGS+=(--ro-bind "$RESOLVED_SAMPLE_DIR" "$RESOLVED_SAMPLE_DIR")
fi

# RW cache scope (card 9518b377, LOW): ca1b763c bound the WHOLE ~/.cache/rea tree read-write,
# wider than measured necessary. Bind it read-only, then re-bind read-write ONLY the specific
# per-engine subdirs `rea doctor --json` actually measured writing to (hopper-releases: Hopper
# activation download cache; kuna: `kuna-cache` check creates/writes $HOME/.cache/rea/kuna).
# Pre-create each on the host so the bind target exists even on a fresh machine. An engine
# writing anywhere else in the tree now fails visibly (fail-closed) instead of silently
# succeeding in an unreviewed location; extend this list if a real analysis run surfaces a
# legitimate EROFS/EACCES for a new subdir (re-run `rea doctor --json` through this wrapper to
# confirm before adding one).
RW_CACHE_SUBDIRS=(hopper-releases kuna)
for sub in "${RW_CACHE_SUBDIRS[@]}"; do
  mkdir -p "$HOME/.cache/rea/$sub"
done
BIND_ARGS+=(--ro-bind "$HOME/.cache/rea" "$HOME/.cache/rea")
for sub in "${RW_CACHE_SUBDIRS[@]}"; do
  BIND_ARGS+=(--bind "$HOME/.cache/rea/$sub" "$HOME/.cache/rea/$sub")
done
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
