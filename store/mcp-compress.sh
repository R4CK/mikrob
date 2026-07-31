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
# UPDATE-SAFE: the package lives OUTSIDE the repo (~/.npm-tools, pinned 0.31.7, --ignore-scripts).
# This script is the only tracked artefact, so update.sh's ff-only pull is unaffected. No secrets --
# this path needs none.
#
# USAGE:
#   cat tools.json | store/mcp-compress.sh [--level low|medium|high]   # default: high
#   store/mcp-compress.sh doctor
#
# NOTE on `max`: upstream's `max` level returns an EMPTY listing (it assumes a tool-SEARCH flow where
# the agent asks for schemas on demand). It is refused here: silently handing an agent zero tools
# looks like a 100% saving and is actually a broken tool surface.
set -euo pipefail

PINNED_VERSION="0.31.7"
PKG="${MCP_COMPRESSOR_PKG:-$HOME/.npm-tools/lib/node_modules/@atlassian/mcp-compressor}"
LEVEL="high"

die() { echo "mcp-compress.sh: $2" >&2; exit "$1"; }
[[ -d "$PKG" ]] || die 4 "package not found at $PKG (npm install --prefix ~/.npm-tools --ignore-scripts @atlassian/mcp-compressor@$PINNED_VERSION)"

case "${1:-}" in
  doctor)
    echo "package: $PKG"
    echo "pinned:  $PINNED_VERSION"
    node --input-type=module -e "
      import { VERSION, compressToolListing } from '$PKG/dist/index.js'
      console.log('version:', VERSION)
      console.log('compressToolListing:', typeof compressToolListing)
    " 2>&1 | sed 's/^/  /'
    exit 0 ;;
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
