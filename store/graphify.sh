#!/usr/bin/env bash
# graphify.sh -- the fleet's shared, GATED entry point to the graphify code knowledge-graph
# (card 3646bde7). Every agent AND the local LLM reach the graph through this wrapper, never the
# raw CLI, so the deterministic/no-egress guarantees hold in one place.
#
# WHY A WRAPPER (Peti's constraints):
#   * DETERMINISTIC CODE-ONLY. graphify can also run semantic/LLM passes (label, cluster-only,
#     extract --backend, community naming) and can FETCH URLS (`add <url>`). None of that may run
#     from the fleet: only on-device tree-sitter AST extraction and read-only graph queries. This
#     script ALLOWLISTS the deterministic subcommands and refuses everything else -- an allowlist,
#     not a denylist, so a NEW upstream subcommand is refused by default rather than silently
#     allowed on the next version bump.
#   * EGRESS GATE. Any LLM backend key in the environment is UNSET for the child process, so even a
#     code path that tries to auto-detect a backend finds none and cannot call out.
#   * INSTALLED OUTSIDE THE REPO. graphify lives in pipx (~/.local), pinned; nothing lands in
#     /home/neon/marveen, so `update.sh`'s ff-only pull is never blocked by tool files.
#   * NO SECRETS IN ARGV. This tool needs none; nothing here reads a token, and no value is passed
#     on a command line where /proc/<pid>/cmdline would expose it.
#
# USAGE:
#   store/graphify.sh build <repo-path>          # deterministic AST extraction -> graphify-out/
#   store/graphify.sh explain <repo-path> "X"    # plain-language node + neighbours
#   store/graphify.sh query   <repo-path> "Q"    # BFS traversal answer (token-budgeted)
#   store/graphify.sh path    <repo-path> "A" "B"
#   store/graphify.sh affected <repo-path> "X"
#   store/graphify.sh god-nodes <repo-path>
#   store/graphify.sh graph-path <repo-path>     # print graph.json path (for RAG context)
#   store/graphify.sh doctor                     # version + pin check
#
# Output lands in <repo-path>/graphify-out/ (graphify's own default), which each repo gitignores.
set -euo pipefail

PINNED_VERSION="0.9.31"
# The pipx VENV binary, addressed directly. The ~/.local/bin/graphify shim is deliberately REMOVED
# (Cybersec NO-GO @7fdb09b): while it was on PATH, any agent could call the raw CLI and skip this
# wrapper's allowlist + egress gate, so the card's central claim ("all access is gated") was false.
# Off PATH, this wrapper is the discoverable/default way in. HONEST LIMIT: this is not an OS-level
# boundary -- a caller running as the same user can still execute the venv path directly. Making it
# unbypassable would need a separate uid or a container; what this closes is every DEFAULT and
# DOCUMENTED path, plus the skill that used to instruct raw `graphify add` (a URL fetch = egress).
GRAPHIFY_BIN="${GRAPHIFY_BIN:-$HOME/.local/share/pipx/venvs/graphifyy/bin/graphify}"

die() { echo "graphify.sh: $2" >&2; exit "$1"; }

[[ -x "$GRAPHIFY_BIN" ]] || die 4 "graphify not found at $GRAPHIFY_BIN (pipx install 'graphifyy==$PINNED_VERSION')"

# Refuse to run if a raw CLI shim is back on PATH: that would mean the bypass reopened (e.g. a pipx
# reinstall recreated ~/.local/bin/graphify), and the gate's guarantee would silently be void again.
if command -v graphify >/dev/null 2>&1; then
  die 6 "raw 'graphify' is on PATH again ($(command -v graphify)) -- the wrapper gate is bypassable. Remove the shim (rm ~/.local/bin/graphify ~/.local/bin/graphify-mcp) and re-run."
fi

# --- egress gate: no LLM backend may be auto-detected from the environment ---------------------
# graphify picks a backend from whichever API key is set. Unset them all for the child so the
# semantic paths are not merely unused but UNREACHABLE.
unset ANTHROPIC_API_KEY OPENAI_API_KEY OPENAI_BASE_URL GEMINI_API_KEY GOOGLE_API_KEY \
      DEEPSEEK_API_KEY KIMI_API_KEY MOONSHOT_API_KEY OLLAMA_HOST GRAPHIFY_BACKEND 2>/dev/null || true

run_graphify() { "$GRAPHIFY_BIN" "$@"; }

need_repo() {
  [[ -n "${1:-}" ]] || die 4 "missing <repo-path>; see --help"
  [[ -d "$1" ]] || die 4 "not a directory: $1"
}
graph_json() { echo "$1/graphify-out/graph.json"; }
need_graph() {
  local g; g="$(graph_json "$1")"
  [[ -f "$g" ]] || die 5 "no graph yet at $g -- run: store/graphify.sh build $1"
  echo "$g"
}

CMD="${1:-}"; shift || true
case "$CMD" in
  build)
    need_repo "${1:-}"
    # --no-cluster = raw AST extraction only. Clustering is deterministic but its labeling step is
    # the LLM path; skipping it keeps this call provably code-only.
    run_graphify update "$1" --no-cluster
    ;;
  explain)
    need_repo "${1:-}"; G="$(need_graph "$1")"
    [[ -n "${2:-}" ]] || die 4 'missing "<node>"'
    run_graphify explain "$2" --graph "$G"
    ;;
  query)
    need_repo "${1:-}"; G="$(need_graph "$1")"
    [[ -n "${2:-}" ]] || die 4 'missing "<question>"'
    shift 2
    run_graphify query "$1" --graph "$G" "$@" 2>/dev/null || run_graphify query "$G" --graph "$G"
    ;;
  path)
    need_repo "${1:-}"; G="$(need_graph "$1")"
    [[ -n "${2:-}" && -n "${3:-}" ]] || die 4 'missing "<A>" "<B>"'
    run_graphify path "$2" "$3" --graph "$G"
    ;;
  affected)
    need_repo "${1:-}"; G="$(need_graph "$1")"
    [[ -n "${2:-}" ]] || die 4 'missing "<node>"'
    run_graphify affected "$2" --graph "$G"
    ;;
  god-nodes)
    need_repo "${1:-}"; G="$(need_graph "$1")"
    run_graphify god-nodes --graph "$G"
    ;;
  graph-path)
    need_repo "${1:-}"; need_graph "$1"
    ;;
  doctor)
    echo "binary:  $GRAPHIFY_BIN"
    echo "version: $(run_graphify --version 2>&1 | head -1)"
    echo "pinned:  $PINNED_VERSION"
    run_graphify --version 2>&1 | grep -q "$PINNED_VERSION" \
      && echo "pin:     OK" || echo "pin:     MISMATCH -- reinstall 'graphifyy==$PINNED_VERSION'"
    ;;
  -h|--help|'')
    awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "${BASH_SOURCE[0]}"
    ;;
  *)
    # ALLOWLIST: anything not handled above -- including the LLM passes (label, cluster-only,
    # extract), the URL fetcher (add), the platform installers (install/uninstall) and clone -- is
    # refused here rather than forwarded.
    die 4 "subcommand '$CMD' is not allowed by the fleet wrapper (deterministic code-only). Allowed: build explain query path affected god-nodes graph-path doctor"
    ;;
esac
