#!/usr/bin/env bash
# mcp-agent-denylist-apply.sh -- per-agent deniedMcpServers retrofit for EXISTING agents (card
# c69a8da2, e25e2bbc measurement: filesystem/Stitch/hostinger/playwright load for every agent via
# the shared ~/.claude.json, regardless of whether that agent ever uses them).
#
# AGENT_INHERITED_MCP_SERVERS (src/web/mcp-inheritance.ts, config-registry.ts) already does this
# for a BRAND NEW agent at provision time, and explicitly states "a meglevo ugynoktol semmit nem
# vesz el" -- it is forward-only, never retroactive. This script is the retroactive counterpart for
# the 17 agents that already exist, using the SAME proven mechanism (`deniedMcpServers` in an
# agent's own settings.json -- a real denylist that blocks a matching server regardless of which
# layer declared it; DECISIONS.md 2026-10-10, kartya 67e73b48/1d31cfcc).
#
# What counts as "the global set": every mcpServers key in the OPERATOR's own ~/.claude.json,
# read live, not hardcoded here -- so a future addition/removal there is picked up automatically
# instead of silently drifting out of date with this script.
#
# What is NEVER denied, for any agent:
#   - code-review-graph, context7 (AGENT_INHERITED_MCP_SERVERS default -- read-only, credential-
#     free, useful to every agent; MikroB decision, card 67e73b48 N2).
#   - any server name the agent's OWN agents/<name>/.mcp.json already declares (denying a name an
#     agent legitimately declares for itself would block its own role-scoped tool, since a denylist
#     match blocks regardless of source).
#
# Per-agent extra keep-list: store/mcp-agent-allowlist.json, {"agent": ["server", ...]} -- the
# measured role need (card's own Kész-ha 1: a per-agent usage table). Data, not code: widening an
# agent's access later is a one-line JSON edit, not a script change.
#
# Usage:
#   mcp-agent-denylist-apply.sh --dry-run          (default) print the computed denylist per agent
#   mcp-agent-denylist-apply.sh --apply --yes       write deniedMcpServers into each agent's own
#                                                    .claude-config/settings.json
#   mcp-agent-denylist-apply.sh --rollback --yes    clear deniedMcpServers back to [] for every
#                                                    agent this script would touch -- "one flag/file
#                                                    restores today's full set" (card requirement 3)
#
# Env overrides (tests only):
#   MARVEEN_MAIN             default /home/neon/marveen
#   MCP_DENYLIST_USER_CONFIG default $HOME/.claude.json
#   MCP_DENYLIST_ALLOWLIST   default $MARVEEN_MAIN/store/mcp-agent-allowlist.json
set -uo pipefail

MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"
USER_CONFIG="${MCP_DENYLIST_USER_CONFIG:-$HOME/.claude.json}"
ALLOWLIST_FILE="${MCP_DENYLIST_ALLOWLIST:-$MAIN/store/mcp-agent-allowlist.json}"
AGENTS_DIR="$MAIN/agents"
NEVER_DENY="code-review-graph,context7"

say() { echo "mcp-agent-denylist-apply: $*"; }

compute_for_agent() {
  # prints the denylist (comma-separated, may be empty) for one agent on stdout
  local agent="$1"
  python3 -I - "$USER_CONFIG" "$ALLOWLIST_FILE" "$AGENTS_DIR/$agent/.mcp.json" "$agent" "$NEVER_DENY" <<'PYEOF'
import json, sys
user_cfg_path, allowlist_path, own_mcp_path, agent, never_deny_csv = sys.argv[1:6]

def load_keys(path):
    try:
        with open(path) as f:
            d = json.load(f)
        return set(d.get("mcpServers", {}).keys())
    except Exception:
        return set()

global_servers = load_keys(user_cfg_path)
own_servers = load_keys(own_mcp_path)
never_deny = {s.strip() for s in never_deny_csv.split(",") if s.strip()}

try:
    with open(allowlist_path) as f:
        allowlist = json.load(f)
except Exception:
    allowlist = {}
extra_keep = set(allowlist.get(agent, []))

deny = global_servers - never_deny - own_servers - extra_keep
print(",".join(sorted(deny)))
PYEOF
}

apply_for_agent() {
  local agent="$1" deny_csv="$2"
  local settings="$AGENTS_DIR/$agent/.claude-config/settings.json"
  [ -f "$settings" ] || { say "SKIP $agent: no settings.json at $settings"; return 1; }
  python3 -I - "$settings" "$deny_csv" <<'PYEOF'
import json, sys
settings_path, deny_csv = sys.argv[1:3]
deny = [s for s in deny_csv.split(",") if s]
with open(settings_path) as f:
    data = json.load(f)
data["deniedMcpServers"] = [{"serverName": s} for s in deny]
with open(settings_path, "w") as f:
    json.dump(data, f, indent=4)
    f.write("\n")
PYEOF
}

rollback_for_agent() {
  local agent="$1"
  local settings="$AGENTS_DIR/$agent/.claude-config/settings.json"
  [ -f "$settings" ] || { say "SKIP $agent: no settings.json at $settings"; return 1; }
  python3 -I - "$settings" <<'PYEOF'
import json, sys
settings_path = sys.argv[1]
with open(settings_path) as f:
    data = json.load(f)
data["deniedMcpServers"] = []
with open(settings_path, "w") as f:
    json.dump(data, f, indent=4)
    f.write("\n")
PYEOF
}

main() {
  local MODE="dry-run" CONFIRMED=0 arg
  for arg in "$@"; do
    case "$arg" in
      --dry-run) MODE="dry-run" ;;
      --apply) MODE="apply" ;;
      --rollback) MODE="rollback" ;;
      --yes) CONFIRMED=1 ;;
      *) echo "mcp-agent-denylist-apply: unknown argument: $arg" >&2; return 2 ;;
    esac
  done

  [ -f "$USER_CONFIG" ] || { echo "mcp-agent-denylist-apply: no user config at $USER_CONFIG" >&2; return 3; }
  [ -d "$AGENTS_DIR" ] || { echo "mcp-agent-denylist-apply: no agents dir at $AGENTS_DIR" >&2; return 3; }

  if [ "$MODE" != "dry-run" ] && [ "$CONFIRMED" != 1 ]; then
    echo "mcp-agent-denylist-apply: --apply/--rollback requires --yes (read the --dry-run report first). Refusing." >&2
    return 2
  fi

  local agent total=0 touched=0
  for agent_dir in "$AGENTS_DIR"/*/; do
    [ -d "$agent_dir" ] || continue
    agent="$(basename "$agent_dir")"
    [ -f "$agent_dir/.claude-config/settings.json" ] || continue
    total=$((total + 1))
    case "$MODE" in
      dry-run)
        local deny_csv
        deny_csv="$(compute_for_agent "$agent")"
        printf '%-14s deny: %s\n' "$agent" "${deny_csv:-(none)}"
        ;;
      apply)
        local deny_csv
        deny_csv="$(compute_for_agent "$agent")"
        if apply_for_agent "$agent" "$deny_csv"; then
          touched=$((touched + 1))
          say "applied $agent: deny=${deny_csv:-(none)}"
        fi
        ;;
      rollback)
        if rollback_for_agent "$agent"; then
          touched=$((touched + 1))
          say "rolled back $agent: deniedMcpServers=[]"
        fi
        ;;
    esac
  done

  say "summary: $MODE on $total agent(s)$( [ "$MODE" != "dry-run" ] && echo ", $touched touched" )"
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
  exit $?
fi
