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
#     to a dedicated allowlisted directory (elemzo/samples) -- card 9518b377,
#     hardened to an ALLOWLIST after WhiteHat F3 (komment 23921): the original
#     denylist (deny .claude-config*/store/*, allow anything else under
#     elemzo/) would also have bound elemzo's readable .claude/ (channels,
#     hooks), and the store/ pattern without a trailing separator did not even
#     catch a directory literally named "store". Without this knob, the
#     sandbox cannot see any file elemzo wants analyzed at all.
#   - this script's OWN PATH is pinned to /usr/bin:/bin at the top (WhiteHat
#     NO-GO F1, komment 23921): the registered PATH (needed by the sandboxed
#     REA process itself, saved below as REG_PATH) has $JAVA_HOME/bin first, a
#     directory writable by the same user running this script and every
#     engine. Before this fix, every bare-name external command the script
#     calls (readlink, sha256sum, sed, sort, cut, dirname, mkdir, find, grep)
#     resolved against that registered PATH -- the exact hijack class
#     resolve_trusted_bin() below already closed for bwrap/env/node (RedHat
#     NO-GO, ca1b763c komment 23049) but left open everywhere else. Measured:
#     a planted fake `readlink`/`sha256sum` first in PATH let WhiteHat's PoC
#     defeat both the REA_SAMPLE_DIR validation and the integrity pin.
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

# Pin our OWN PATH to trusted directories only (WhiteHat NO-GO F1, komment 23921, see header
# comment). Save the registered PATH first -- the sandboxed REA process still needs it (it
# resolves its own child tools via it) -- then lock down the PATH this script itself uses for
# every bare-name command below (readlink, sha256sum, sed, sort, cut, dirname, mkdir, find, grep).
REG_PATH="$PATH"
export PATH=/usr/bin:/bin

# Resolve EVERY external command this script uses at FIXED, trusted absolute paths, never via
# a bare name (RedHat NO-GO, card 9518b377 komment 24382 KC1, extending the ca1b763c komment
# 23049 bwrap/env/node fix to the rest): a bare command name is looked up against bash's own
# FUNCTION table before PATH is ever consulted, so the PATH pin above did not stop a single
# exported bash function (BASH_FUNC_<name>%%=() {...} in the launching environment) from
# shadowing readlink/sha256sum/sort/cut/dirname/mkdir/find/grep/sed -- no PATH write access
# needed. Measured PoC: an exported BASH_FUNC_readlink%% made the REA_SAMPLE_DIR allowlist
# check resolve to an attacker-chosen path (store/.dashboard-token became visible inside the
# sandbox) even with the PATH pin in place; an absolute-path invocation (/usr/bin/x) bypasses
# bash's function lookup entirely (verified: with BASH_FUNC_readlink%% exported, bare
# `readlink` runs the hijacked function, `/usr/bin/readlink` still runs the real binary).
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
READLINK_BIN="$(resolve_trusted_bin readlink)"
SHA256SUM_BIN="$(resolve_trusted_bin sha256sum)"
SORT_BIN="$(resolve_trusted_bin sort)"
CUT_BIN="$(resolve_trusted_bin cut)"
DIRNAME_BIN="$(resolve_trusted_bin dirname)"
MKDIR_BIN="$(resolve_trusted_bin mkdir)"
FIND_BIN="$(resolve_trusted_bin find)"
GREP_BIN="$(resolve_trusted_bin grep)"
SED_BIN="$(resolve_trusted_bin sed)"

# HOPPER_LAUNCHER_PATH is optional (Hopper may not be installed/registered yet).
HOPPER_LAUNCHER_PATH="${HOPPER_LAUNCHER_PATH:-}"

# Configurable network egress (card 9518b377): default-closed, same as before this card.
REA_NET_ALLOW="${REA_NET_ALLOW:-0}"

# Configurable sample-submission bind (card 9518b377): default-closed (unset = no bind).
# ALLOWLIST (WhiteHat F3, komment 23921; replaces the original denylist, which also exposed
# elemzo's readable .claude/ and missed a directory literally named "store"): only a path
# under a DEDICATED sample directory is accepted, nothing else under elemzo or anywhere else.
ELEMZO_SAMPLES_DIR=/home/neon/marveen/agents/elemzo/samples
# KC3 (RedHat NO-GO, komment 24382): refuse if the samples directory itself has been replaced
# with a symlink -- "readlink -f" below would otherwise silently follow it, moving the
# allowlist root to whatever the symlink points at (measured on a scratch copy: a samples ->
# arbitrary-dir symlink moved the allowlist root there; same-uid write only, but still a new,
# unintended boundary).
if [ -L "$ELEMZO_SAMPLES_DIR" ]; then
  echo "rea-bwrap-sandbox: $ELEMZO_SAMPLES_DIR is a symlink -- refusing (fail-closed, the allowlist root must be a real directory)" >&2
  exit 1
fi
SAMPLES_ROOT="$("$READLINK_BIN" -f "$ELEMZO_SAMPLES_DIR")"
REA_SAMPLE_DIR="${REA_SAMPLE_DIR:-}"
RESOLVED_SAMPLE_DIR=""
if [ -n "$REA_SAMPLE_DIR" ]; then
  RESOLVED_SAMPLE_DIR="$("$READLINK_BIN" -f "$REA_SAMPLE_DIR" 2>/dev/null || true)"
  case "$RESOLVED_SAMPLE_DIR" in
    "$SAMPLES_ROOT"|"$SAMPLES_ROOT"/*) ;;
    *)
      echo "rea-bwrap-sandbox: REA_SAMPLE_DIR ($REA_SAMPLE_DIR) is not under the dedicated sample directory $SAMPLES_ROOT -- refusing (fail-closed)" >&2
      exit 1
      ;;
  esac
  if [ ! -d "$RESOLVED_SAMPLE_DIR" ]; then
    echo "rea-bwrap-sandbox: REA_SAMPLE_DIR ($REA_SAMPLE_DIR) does not exist or is not a directory -- refusing (fail-closed)" >&2
    exit 1
  fi
fi

REA_VERSION="6.7.0"
REA_SCRIPT=""
PKG_DIR=""
for pkg_json in "$HOME"/.npm/_npx/*/node_modules/rea-agents/package.json; do
  [ -f "$pkg_json" ] || continue
  if "$GREP_BIN" -q "\"version\": \"$REA_VERSION\"" "$pkg_json" 2>/dev/null; then
    PKG_DIR="$("$DIRNAME_BIN" "$pkg_json")"
    REA_SCRIPT="$PKG_DIR/scripts/rea.mjs"
    break
  fi
done
if [ -z "$REA_SCRIPT" ] || [ ! -f "$REA_SCRIPT" ]; then
  echo "rea-bwrap-sandbox: could not locate a cached rea-agents@$REA_VERSION install under $HOME/.npm/_npx -- run 'npx -y rea-agents@$REA_VERSION --version' once outside the sandbox first" >&2
  exit 1
fi

# npx-cache integrity pin (card 9518b377, hardened after WhiteHat F2, komment 23921, then
# 24375): the version-string match above only checks package.json's self-reported version,
# and the FIRST version of this check hashed only scripts/rea.mjs (a ~100-line entrypoint) --
# the actual engine logic lives in dist/** (dynamically imported), so a tampered dist file
# passed untouched. The SECOND version hashed the whole rea-agents package tree ($PKG_DIR),
# but rea-agents ships with no vendored node_modules -- its 158 dependencies live as SIBLINGS
# under $PKG_DIR's own npx-hash directory (~/.npm/_npx/<hash>/node_modules/), outside the
# hashed tree, so tampering a dependency's dist file (WhiteHat PoC: appended line to the
# `incur` dependency's dist/index.js) ran inside the sandbox untouched. Hash the WHOLE
# npx-hash directory instead ($PKG_DIR's node_modules's parent -- i.e. two levels up from
# $PKG_DIR): sorted relative-path+content hash of every file, folded into one sha256.
# Measured ~0.77-0.84s for the real 7887-file tree (vs. 1775 files/0.17s for rea-agents
# alone) -- still negligible against MCP startup, and confirmed to change on a tampered
# sibling-dependency file. THIRD hardening (RedHat NO-GO, card 9518b377 komment 24382 KC2):
# "-type f" alone skips symlinks -- the tree has 19 (mostly node_modules/.bin/* shims), and
# retargeting one does not change the file-content hash at all. Fold symlink name+target pairs
# into the same hashed stream. Measured with symlinks included: 1.157s, new pin below.
NPX_HASH_DIR="$("$DIRNAME_BIN" "$("$DIRNAME_BIN" "$PKG_DIR")")"
REA_PKG_MANIFEST_SHA256_PIN="323ab07bf0fb92fed208bbc5e2fd41a213eaa53f95c7a3456e235e9843d0985e"
REA_PKG_MANIFEST_SHA256_ACTUAL="$(
  {
    "$FIND_BIN" "$NPX_HASH_DIR" -type f -exec "$SHA256SUM_BIN" {} + | "$SED_BIN" "s#$NPX_HASH_DIR/##"
    "$FIND_BIN" "$NPX_HASH_DIR" -type l -printf '%p -> %l\n' | "$SED_BIN" "s#$NPX_HASH_DIR/##"
  } | "$SORT_BIN" | "$SHA256SUM_BIN" | "$CUT_BIN" -d' ' -f1
)"
if [ "$REA_PKG_MANIFEST_SHA256_ACTUAL" != "$REA_PKG_MANIFEST_SHA256_PIN" ]; then
  echo "rea-bwrap-sandbox: $NPX_HASH_DIR package-tree hash mismatch (expected $REA_PKG_MANIFEST_SHA256_PIN, got $REA_PKG_MANIFEST_SHA256_ACTUAL) -- refusing to start (fail-closed)" >&2
  exit 1
fi

BIND_ARGS=(
  --unshare-pid --unshare-ipc --unshare-uts
  # --unshare-user + --disable-userns (RedHat KC5, komment 23925): without this, a compromised
  # engine inside the sandbox can `unshare -U -r` to get uid 0 in a NESTED user namespace
  # (measured: CapEff=0 at the sandbox's own top level, but the nested namespace still grants
  # CAP_SYS_ADMIN there), widening the kernel attack surface available for an escape attempt.
  # --disable-userns requires --unshare-user (bwrap's own error if it's missing -- measured).
  # Closes that path without needing the still-deferred seccomp BPF profile (separate card, per
  # RedHat's own recommendation).
  --unshare-user --disable-userns
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /etc /etc
  --dir "$HOME"
  --ro-bind "$HOME/.npm" "$HOME/.npm"
  --ro-bind "$GHIDRA_INSTALL_DIR" "$GHIDRA_INSTALL_DIR"
  --ro-bind "$JAVA_HOME" "$JAVA_HOME"
  --ro-bind "$("$DIRNAME_BIN" "$REA_JADX_MCP_JAR")" "$("$DIRNAME_BIN" "$REA_JADX_MCP_JAR")"
  --ro-bind "$("$DIRNAME_BIN" "$REA_KUNA_COMMAND")" "$("$DIRNAME_BIN" "$REA_KUNA_COMMAND")"
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
  "$MKDIR_BIN" -p "$HOME/.cache/rea/$sub"
done
BIND_ARGS+=(--ro-bind "$HOME/.cache/rea" "$HOME/.cache/rea")
for sub in "${RW_CACHE_SUBDIRS[@]}"; do
  BIND_ARGS+=(--bind "$HOME/.cache/rea/$sub" "$HOME/.cache/rea/$sub")
done
if [ -n "$HOPPER_LAUNCHER_PATH" ] && [ -e "$HOPPER_LAUNCHER_PATH" ]; then
  HOPPER_BIN_DIR="$("$DIRNAME_BIN" "$HOPPER_LAUNCHER_PATH")"
  BIND_ARGS+=(--ro-bind "$HOPPER_BIN_DIR" "$HOPPER_BIN_DIR")
  # Hopper's launcher dynamically links libHopperCore.so and five sibling libs out of a `lib/`
  # directory next to `bin/` (ldd: libHopperCore.so, libdispatch.so, libpthread_workqueue.so,
  # libkqueue.so, libgnustep-base.so, libobjc.so, libxml2.so, libffi.so, libBlocksRuntime.so, via
  # an rpath of ../lib) -- QA F1 BLOCKER (card ca1b763c, komment 23032): binding only bin/ left
  # these unresolved inside the sandbox, breaking Hopper there specifically (every other
  # dependency resolves from /usr, already ro-bound). Bind that sibling lib/ dir too, read-only.
  HOPPER_LIB_DIR="$("$DIRNAME_BIN" "$HOPPER_BIN_DIR")/lib"
  if [ -d "$HOPPER_LIB_DIR" ]; then
    BIND_ARGS+=(--ro-bind "$HOPPER_LIB_DIR" "$HOPPER_LIB_DIR")
  fi
fi

"$MKDIR_BIN" -p "$HOME/.cache/rea"

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
# the sandboxed REA process gets REG_PATH (the ORIGINAL registered PATH, saved before this
# script pinned its own $PATH to /usr/bin:/bin for F1 above), since rea-agents resolves its
# own child tools via it; it must never be used to look up bwrap/env/node themselves (RedHat
# NO-GO, komment 23049), which is why resolve_trusted_bin() never consults $PATH either.
exec "$ENV_BIN" -i \
  HOME="$HOME" \
  PATH="$REG_PATH" \
  JAVA_HOME="$JAVA_HOME" \
  GHIDRA_INSTALL_DIR="$GHIDRA_INSTALL_DIR" \
  REA_JADX_MCP_JAR="$REA_JADX_MCP_JAR" \
  REA_KUNA_COMMAND="$REA_KUNA_COMMAND" \
  ${HOPPER_LAUNCHER_PATH:+HOPPER_LAUNCHER_PATH="$HOPPER_LAUNCHER_PATH"} \
"$BWRAP_BIN" "${BIND_ARGS[@]}" --new-session --die-with-parent \
  "$NODE_BIN" "$REA_SCRIPT" "${REA_ARGS[@]}"
