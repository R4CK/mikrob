#!/usr/bin/env bash
# mcp-compress.sh -- LIBRARY-ONLY adapter for @atlassian/mcp-compressor (card b92c10d4, Peti option C).
#
# WHAT THIS DOES: compresses an MCP tool listing (JSON on stdin) so a tool surface costs far fewer
# tokens. Reads stdin, writes the compressed listing to stdout. Nothing else.
#
# WHY LIBRARY-ONLY, and why this file exists at all:
#   The package's CLI `serve` path needs a standalone Rust binary we do NOT have -- producing it means
#   compiling the 333-crate tree and running build.rs, which would defeat the --ignore-scripts install
#   and pull in the 8 OSV advisories found on that tree (anyhow, pyo3 x4, quinn-proto x2, tar).
#   The LIBRARY path uses the PREBUILT N-API addon instead: no cargo build, no build.rs.
#   So this adapter calls ONLY the compression function and never touches serve/CLI.
#
# CALLED API (the Cybersec reachability input -- exactly one function):
#   compressToolListing(level, tools)   from dist/index.js
# DELIBERATELY NOT CALLED (present in the same module, all flagged by the audit):
#   startCompressedSession* / startLocalToolBridge  -- the local /exec bridge
#   createExecutableToolBridge / generateClientArtifact*  -- writes executable client files (chmod 755)
#   clearOAuthCredentials / listOAuthCredentials / rememberOAuthBackend  -- credential handling
#   installJustBashCommands* / createJustBashCommands  -- the just-bash sandbox surface
#
# UPDATE-SAFE: the package lives OUTSIDE the repo (~/.npm-tools, pinned 0.36.0, --ignore-scripts).
# This script is the only tracked artefact, so update.sh's ff-only pull is unaffected. No secrets --
# this path needs none.
#
# PIN HISTORY: 0.31.7 -> 0.32.0 (card 2f533044, Cybersec GO on f7c87ea4 with 4 conditions). The 8 OSV
# advisories that caused the original HOLD (anyhow/pyo3/quinn-proto/tar) are absent from the shipped
# binary in both versions; the delta across the four intervening releases is one non-called file
# (rust_core.d.ts) with identical reachability (zero Node-level egress/exec/child-process on this
# LIBRARY-ONLY path).
#
# 0.32.0 -> 0.36.0 (card 0f55f01e, WhiteHat GO on bbde2831 with 4 conditions): net security gain --
# rmcp 1.7.0 (4 advisories incl. GHSA-c9xm, an OAuth client following a server-controlled
# resource_metadata URL) moves to rmcp 3.5.1 (all fixed). New risk in the SAME release: an llm_assist
# module downloads llama.cpp + a GGUF model over HTTPS with NO hash/signature check and runs it as a
# child process -- but it is reachable ONLY from the package's CLI (dist/cli.js, `llm pull/status/
# test`), never from dist/index.js's compressToolListing, so this LIBRARY-ONLY adapter never reaches
# it. Conditions enforced here: (1) compressToolListing is the only call (unchanged from 0.32.0,
# still true after the bump -- see CALLED API above); (2) install with --ignore-scripts, integrity
# pinned below; (3) ~/.npm-tools/bin must never be on PATH -- doctor checks this now; (4) re-OSV-scan
# at the next bump (already true of this adapter's own pin history).
#
# USAGE:
#   cat tools.json | store/mcp-compress.sh [--level low|medium|high]   # default: high
#   store/mcp-compress.sh doctor
#
# NOTE on `max`: upstream's `max` level returns an EMPTY listing (it assumes a tool-SEARCH flow where
# the agent asks for schemas on demand). It is refused here: silently handing an agent zero tools
# looks like a 100% saving and is actually a broken tool surface.
set -euo pipefail

PINNED_VERSION="0.36.0"
# npm registry dist.integrity for @atlassian/mcp-compressor@0.36.0, recorded at audit time (WhiteHat,
# card bbde2831) -- a fixed version's published tarball hash never changes on npm, so a doctor-time
# mismatch means the registry served something other than what was audited.
PINNED_INTEGRITY="sha512-ws8ARYFc5UpVGKfn7rHPHzH1sw14NTyKdUhdwHHDuMzE0fL0Ug6JEhlFSoglOL0YMjgjYig8KLsDxItemq4wgA=="
# sha256 over every file under dist/ and native/ in the INSTALLED tree (sorted paths, each file's own
# sha256sum, then sha256sum of that list) -- card 1bb57483 (WhiteHat L3, 0f55f01e): PINNED_INTEGRITY
# above only compares the registry's published tarball hash, which never changes once a version is
# published, so it would still say OK even if the local tree had been modified after install. Recorded
# at the same audit point as PINNED_INTEGRITY (QA2/Cybersec's `diff -rq` against the unpacked tarball
# confirmed this installed tree was byte-identical to the audited 0.36.0 release).
PINNED_TREE_SHA256="e6e89d6addf13c1845047967afc8ec2ce1c03651e34012b68f735e229839bf70"
PKG="${MCP_COMPRESSOR_PKG:-$HOME/.npm-tools/lib/node_modules/@atlassian/mcp-compressor}"
NPM_TOOLS_BIN="${MCP_COMPRESSOR_BIN_DIR:-$HOME/.npm-tools/bin}"
LEVEL="high"

die() { echo "mcp-compress.sh: $2" >&2; exit "$1"; }
[[ -d "$PKG" ]] || die 4 "package not found at $PKG (npm install --prefix ~/.npm-tools --ignore-scripts @atlassian/mcp-compressor@$PINNED_VERSION)"

case "${1:-}" in
  doctor)
    echo "package: $PKG"
    echo "pinned:  $PINNED_VERSION"
    # card 1bb57483 (WhiteHat LOW-ok, 0f55f01e): L1 -- doctor must exit non-zero on any FAIL below,
    # so a caller using this as a gate can actually act on it. Tracked across all three checks.
    doctor_fail=0
    node --input-type=module -e "
      import { VERSION, compressToolListing } from '$PKG/dist/index.js'
      console.log('version:', VERSION)
      console.log('compressToolListing:', typeof compressToolListing)
    " 2>&1 | sed 's/^/  /'
    # Condition 3 (card 0f55f01e): the 0.36.0 bin exposes an unchecked `llm pull` download+exec path
    # (dist/cli.js). This adapter never calls it, but only because nothing ever puts the bin on PATH.
    # L2 (WhiteHat, card 1bb57483): a literal `grep -qx` against raw $PATH entries missed a trailing
    # slash (`$NPM_TOOLS_BIN/`) or a `../bin`-style relative form that resolves to the same directory --
    # both measured to report "OK" while the bin was actually on PATH. Normalize every PATH entry
    # (and the target) with realpath before comparing.
    bin_real="$(realpath -m "$NPM_TOOLS_BIN")"
    path_hit=""
    while IFS= read -r entry; do
      [[ -z "$entry" ]] && continue
      entry_real="$(realpath -m "$entry" 2>/dev/null)" || continue
      if [[ "$entry_real" == "$bin_real" ]]; then
        path_hit="$entry"
        break
      fi
    done < <(printf '%s' "$PATH" | tr ':' '\n')
    if [[ -n "$path_hit" ]]; then
      echo "  PATH:    FAIL -- $NPM_TOOLS_BIN is on PATH (as '$path_hit', resolves to $bin_real; must never be; it exposes 'mcp-compressor llm pull', an unverified download+exec)"
      doctor_fail=1
    else
      echo "  PATH:    OK -- $NPM_TOOLS_BIN is not on PATH"
    fi
    live="$(npm view "@atlassian/mcp-compressor@$PINNED_VERSION" dist.integrity 2>/dev/null || true)"
    if [[ -z "$live" ]]; then
      echo "  integrity: SKIPPED -- npm view failed (offline/network), cannot compare to pinned $PINNED_INTEGRITY"
    elif [[ "$live" == "$PINNED_INTEGRITY" ]]; then
      echo "  integrity: OK -- registry matches pinned $PINNED_INTEGRITY"
    else
      echo "  integrity: FAIL -- registry reports $live, pinned/audited $PINNED_INTEGRITY"
      doctor_fail=1
    fi
    # L3 (WhiteHat, card 1bb57483): the check above only compares the REGISTRY's published tarball
    # hash to the pin -- a published version's hash never changes, so this would still say "OK" even
    # if the locally installed tree had been modified after install. Hash what is ACTUALLY on disk.
    if [[ -d "$PKG/dist" ]]; then
      # Strip the "$PKG/" prefix from each sha256sum line before the final hash: PKG is an
      # absolute path that differs across installs/environments, and sha256sum's output includes
      # the filename -- without stripping it, two byte-identical trees at different paths (or the
      # same tree re-pinned after a reinstall to a different prefix) would hash differently even
      # though no file content changed.
      tree_hash="$(find "$PKG/dist" "$PKG/native" -type f -print0 2>/dev/null | sort -z | xargs -0 sha256sum 2>/dev/null | sed "s#  ${PKG}/#  #" | sha256sum | awk '{print $1}')"
      if [[ -z "$tree_hash" ]]; then
        echo "  tree:    SKIPPED -- could not hash the installed dist/native tree at $PKG"
      elif [[ "$tree_hash" == "$PINNED_TREE_SHA256" ]]; then
        echo "  tree:    OK -- installed dist/native tree matches pinned sha256 $PINNED_TREE_SHA256"
      else
        echo "  tree:    FAIL -- installed dist/native tree hash $tree_hash does not match pinned $PINNED_TREE_SHA256 (tree may have been modified after install)"
        doctor_fail=1
      fi
    else
      echo "  tree:    SKIPPED -- $PKG/dist not found"
    fi
    exit "$doctor_fail" ;;
  --level) LEVEL="${2:-high}"; shift 2 || true ;;
  -h|--help|'') : ;;
esac
[[ "${1:-}" == "--level" ]] && { LEVEL="${2:-high}"; }

case "$LEVEL" in
  low|medium|high) : ;;
  max) die 4 "level 'max' returns an EMPTY tool listing (tool-search flow) -- refused: that is a broken tool surface, not a saving" ;;
  *) die 4 "unknown level '$LEVEL' (low|medium|high)" ;;
esac

[[ -t 0 ]] && die 4 "no input: pipe the tool listing JSON on stdin; see --help"

LEVEL="$LEVEL" PKG="$PKG" PINNED="$PINNED_VERSION" node --input-type=module -e '
const { compressToolListing, VERSION } = await import(process.env.PKG + "/dist/index.js")
// FAIL-CLOSED version pin (Cybersec condition, card b92c10d4). The package is installed globally
// WITHOUT a lockfile, so a later `npm install` can silently move it to a release we never audited --
// and the audit (reachability of the 4 advisory crates, absence of serve/network calls on this path)
// is only valid for the version it was performed against. Assert on the RUN path, not just in
// doctor: a pin that is merely printed in an error message does not pin anything.
if (VERSION !== process.env.PINNED) {
  console.error(`mcp-compress.sh: version drift -- loaded ${VERSION}, audited/pinned ${process.env.PINNED}. Refusing: the Cybersec reachability audit does not cover this build. Reinstall the pinned version or re-audit.`)
  process.exit(5)
}
const chunks = []
for await (const c of process.stdin) chunks.push(c)
const raw = Buffer.concat(chunks).toString("utf8").trim()
if (!raw) { console.error("mcp-compress.sh: empty stdin"); process.exit(4) }
let tools
try { tools = JSON.parse(raw) } catch (e) { console.error("mcp-compress.sh: stdin is not valid JSON:", e.message); process.exit(4) }
if (!Array.isArray(tools)) { console.error("mcp-compress.sh: expected a JSON ARRAY of tools"); process.exit(4) }
const out = compressToolListing(process.env.LEVEL, tools)
process.stdout.write(typeof out === "string" ? out : JSON.stringify(out))
'
