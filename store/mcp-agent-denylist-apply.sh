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

# cybersec LOW-1: a PRESENT but unparseable user config or allowlist file used to silently
# become an empty set (load_keys()'s own try/except), so --apply would then over-deny (every
# global server denied for every agent) or under-deny (every agent's extra-keep lost) without any
# sign anything was wrong. A torn read is not hypothetical here -- the claude CLI itself rewrites
# ~/.claude.json often. Fail CLOSED the other way: a file that EXISTS but does not parse aborts
# the whole run instead of silently feeding a wrong set into every agent's computation.
validate_json_file() {
  local path="$1" label="$2"
  [ -f "$path" ] || return 0
  python3 -I -c "import json,sys; json.load(open(sys.argv[1]))" "$path" 2>/dev/null \
    || { echo "mcp-agent-denylist-apply: $label at $path exists but is not valid JSON -- refusing to compute anything from it." >&2; return 1; }
}

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

# cybersec LOW-2: apply used to REPLACE deniedMcpServers wholesale, so a denial someone else put
# there (an unrelated security decision) was silently wiped on the first apply. Now MERGES: the
# computed names are UNION-ed with whatever the file already carries, never dropped.
apply_for_agent() {
  local agent="$1" deny_csv="$2"
  local settings="$AGENTS_DIR/$agent/.claude-config/settings.json"
  [ -f "$settings" ] || { say "SKIP $agent: no settings.json at $settings"; return 1; }
  python3 -I - "$settings" "$deny_csv" <<'PYEOF'
import json, sys
settings_path, deny_csv = sys.argv[1:3]
computed = {s for s in deny_csv.split(",") if s}
with open(settings_path) as f:
    data = json.load(f)
existing = data.get("deniedMcpServers") or []
existing_names = {e.get("serverName") for e in existing if isinstance(e, dict) and e.get("serverName")}
merged = sorted(existing_names | computed)
data["deniedMcpServers"] = [{"serverName": s} for s in merged]
with open(settings_path, "w") as f:
    json.dump(data, f, indent=4)
    f.write("\n")
PYEOF
}

# cybersec LOW-2 (rollback side): used to set deniedMcpServers=[] unconditionally, which would
# also wipe an unrelated denial someone else added. Rollback now removes ONLY the names THIS
# mechanism would currently compute for that agent, leaving anything else in the file untouched.
rollback_for_agent() {
  local agent="$1" deny_csv="$2"
  local settings="$AGENTS_DIR/$agent/.claude-config/settings.json"
  [ -f "$settings" ] || { say "SKIP $agent: no settings.json at $settings"; return 1; }
  python3 -I - "$settings" "$deny_csv" <<'PYEOF'
import json, sys
settings_path, deny_csv = sys.argv[1:3]
computed = {s for s in deny_csv.split(",") if s}
with open(settings_path) as f:
    data = json.load(f)
existing = data.get("deniedMcpServers") or []
existing_names = {e.get("serverName") for e in existing if isinstance(e, dict) and e.get("serverName")}
remaining = sorted(existing_names - computed)
data["deniedMcpServers"] = [{"serverName": s} for s in remaining]
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
  validate_json_file "$USER_CONFIG" "user config" || return 3
  validate_json_file "$ALLOWLIST_FILE" "per-agent allowlist" || return 3

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
        local deny_csv
        deny_csv="$(compute_for_agent "$agent")"
        if rollback_for_agent "$agent" "$deny_csv"; then
          touched=$((touched + 1))
          say "rolled back $agent: removed ${deny_csv:-(none)}"
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
