#!/usr/bin/env bash
# Self-test for mcp-agent-denylist-apply.sh (card c69a8da2). Fixture-only: builds a throwaway
# fake ~/.claude.json, a fake agents/ tree and a fake allowlist, and points the script at them via
# its env overrides -- never touches the real install.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/mcp-agent-denylist-apply.sh"
fail=0
n=0

check() {
  n=$((n + 1))
  local desc="$1"; shift
  if "$@"; then
    echo "  ok   $desc"
  else
    echo "  FAIL $desc"
    fail=$((fail + 1))
  fi
}

WORK="$(mktemp -d)"
MAIN="$WORK/main"
mkdir -p "$MAIN/agents"

# Fake global ~/.claude.json: filesystem, Stitch, hostinger, playwright (mirrors the real finding).
cat > "$WORK/fake-claude.json" <<'JSON'
{"mcpServers": {"filesystem": {}, "Stitch": {}, "hostinger": {}, "playwright": {}, "code-review-graph": {}}}
JSON

# Fake allowlist: agentB keeps playwright as an extra.
cat > "$WORK/fake-allowlist.json" <<'JSON'
{"agentB": ["playwright"]}
JSON

mk_agent() {
  local name="$1" own_mcp_json="$2"
  mkdir -p "$MAIN/agents/$name/.claude-config"
  printf '%s' "$own_mcp_json" > "$MAIN/agents/$name/.mcp.json"
  printf '{"deniedMcpServers": []}' > "$MAIN/agents/$name/.claude-config/settings.json"
}

# agentA: no own .mcp.json servers, not on the allowlist -> everything but code-review-graph/context7 denied.
mk_agent agentA '{"mcpServers": {}}'
# agentB: no own .mcp.json servers, IS on the allowlist for playwright -> playwright kept.
mk_agent agentB '{"mcpServers": {}}'
# agentC: OWN .mcp.json already declares hostinger directly -> hostinger must never be denied for it.
mk_agent agentC '{"mcpServers": {"hostinger": {}}}'

export MARVEEN_MAIN="$MAIN"
export MCP_DENYLIST_USER_CONFIG="$WORK/fake-claude.json"
export MCP_DENYLIST_ALLOWLIST="$WORK/fake-allowlist.json"

# --- dry-run: correct per-agent denylist, nothing written ------------------------------------------
out_dry="$(bash "$SCRIPT" --dry-run 2>&1)"
check "agentA dry-run denies filesystem,Stitch,hostinger,playwright (not code-review-graph)" \
  bash -c "echo \"\$1\" | grep -q 'agentA.*deny: Stitch,filesystem,hostinger,playwright'" _ "$out_dry"
check "agentB dry-run keeps playwright (allowlisted)" \
  bash -c "echo \"\$1\" | grep -q 'agentB.*deny: Stitch,filesystem,hostinger\$'" _ "$out_dry"
check "agentC dry-run never denies hostinger (own .mcp.json declares it)" \
  bash -c "echo \"\$1\" | grep -q 'agentC.*deny: Stitch,filesystem,playwright\$'" _ "$out_dry"
check "dry-run writes nothing to agentA's settings.json" \
  bash -c "python3 -c \"import json; assert json.load(open('\$1')).get('deniedMcpServers') == []\"" _ "$MAIN/agents/agentA/.claude-config/settings.json"

# --- --apply without --yes refuses, nothing written ------------------------------------------------
out_noyes="$(bash "$SCRIPT" --apply 2>&1)"; rc_noyes=$?
check "--apply without --yes refuses (exit 2)" test "$rc_noyes" = 2
check "--apply without --yes wrote nothing" \
  bash -c "python3 -c \"import json; assert json.load(open('\$1')).get('deniedMcpServers') == []\"" _ "$MAIN/agents/agentA/.claude-config/settings.json"

# --- --apply --yes writes the expected deniedMcpServers shape ---------------------------------------
bash "$SCRIPT" --apply --yes >/dev/null 2>&1
check "agentA settings.json now denies filesystem" \
  bash -c "python3 -c \"import json; d=json.load(open('\$1')); names={e['serverName'] for e in d['deniedMcpServers']}; assert 'filesystem' in names\"" _ "$MAIN/agents/agentA/.claude-config/settings.json"
check "agentA settings.json never denies code-review-graph" \
  bash -c "python3 -c \"import json; d=json.load(open('\$1')); names={e['serverName'] for e in d['deniedMcpServers']}; assert 'code-review-graph' not in names\"" _ "$MAIN/agents/agentA/.claude-config/settings.json"
check "agentB settings.json does NOT deny playwright (allowlisted)" \
  bash -c "python3 -c \"import json; d=json.load(open('\$1')); names={e['serverName'] for e in d['deniedMcpServers']}; assert 'playwright' not in names\"" _ "$MAIN/agents/agentB/.claude-config/settings.json"
check "agentC settings.json does NOT deny hostinger (own .mcp.json)" \
  bash -c "python3 -c \"import json; d=json.load(open('\$1')); names={e['serverName'] for e in d['deniedMcpServers']}; assert 'hostinger' not in names\"" _ "$MAIN/agents/agentC/.claude-config/settings.json"

# --- --rollback --yes restores [] for everyone ------------------------------------------------------
bash "$SCRIPT" --rollback --yes >/dev/null 2>&1
check "rollback clears agentA's deniedMcpServers" \
  bash -c "python3 -c \"import json; assert json.load(open('\$1')).get('deniedMcpServers') == []\"" _ "$MAIN/agents/agentA/.claude-config/settings.json"
check "rollback clears agentB's deniedMcpServers" \
  bash -c "python3 -c \"import json; assert json.load(open('\$1')).get('deniedMcpServers') == []\"" _ "$MAIN/agents/agentB/.claude-config/settings.json"
check "rollback clears agentC's deniedMcpServers" \
  bash -c "python3 -c \"import json; assert json.load(open('\$1')).get('deniedMcpServers') == []\"" _ "$MAIN/agents/agentC/.claude-config/settings.json"

# --- cybersec LOW-1: a PRESENT but unparseable user config aborts the whole run, not "deny nothing" -
cp "$WORK/fake-claude.json" "$WORK/fake-claude.json.bak"
printf 'not json' > "$WORK/fake-claude.json"
out_low1="$(bash "$SCRIPT" --dry-run 2>&1)"; rc_low1=$?
check "LOW-1: unparseable user config refuses (nonzero exit), not a silent empty report" test "$rc_low1" != 0
check "LOW-1: no per-agent deny line is printed at all" \
  bash -c "! echo \"\$1\" | grep -q 'deny:'" _ "$out_low1"
mv "$WORK/fake-claude.json.bak" "$WORK/fake-claude.json"

cp "$WORK/fake-allowlist.json" "$WORK/fake-allowlist.json.bak"
printf 'not json' > "$WORK/fake-allowlist.json"
out_low1b="$(bash "$SCRIPT" --dry-run 2>&1)"; rc_low1b=$?
check "LOW-1: unparseable allowlist file also refuses, not a silent fallback to {}" test "$rc_low1b" != 0
mv "$WORK/fake-allowlist.json.bak" "$WORK/fake-allowlist.json"

# --- cybersec LOW-2: apply MERGES with a pre-existing denial, never drops it -----------------------
mk_agent agentE '{"mcpServers": {}}'
printf '{"deniedMcpServers": [{"serverName": "evil-pre"}]}' > "$MAIN/agents/agentE/.claude-config/settings.json"
bash "$SCRIPT" --apply --yes >/dev/null 2>&1
check "LOW-2: apply keeps a pre-existing unrelated denial (evil-pre) after merging" \
  bash -c "python3 -c \"import json; d=json.load(open('\$1')); names={e['serverName'] for e in d['deniedMcpServers']}; assert 'evil-pre' in names\"" _ "$MAIN/agents/agentE/.claude-config/settings.json"
check "LOW-2: apply ALSO added the computed denylist alongside it" \
  bash -c "python3 -c \"import json; d=json.load(open('\$1')); names={e['serverName'] for e in d['deniedMcpServers']}; assert 'filesystem' in names\"" _ "$MAIN/agents/agentE/.claude-config/settings.json"

# --- cybersec LOW-2: rollback removes only what THIS mechanism computed, not the unrelated entry ---
bash "$SCRIPT" --rollback --yes >/dev/null 2>&1
check "LOW-2: rollback removed the computed names (filesystem) for agentE" \
  bash -c "python3 -c \"import json; d=json.load(open('\$1')); names={e['serverName'] for e in d['deniedMcpServers']}; assert 'filesystem' not in names\"" _ "$MAIN/agents/agentE/.claude-config/settings.json"
check "LOW-2: rollback left the pre-existing unrelated denial (evil-pre) untouched" \
  bash -c "python3 -c \"import json; d=json.load(open('\$1')); names={e['serverName'] for e in d['deniedMcpServers']}; assert 'evil-pre' in names\"" _ "$MAIN/agents/agentE/.claude-config/settings.json"

# --- mutant-adjacent control: an agent missing settings.json entirely is skipped, not crashed -------
mkdir -p "$MAIN/agents/agentD"
printf '%s' '{"mcpServers": {}}' > "$MAIN/agents/agentD/.mcp.json"
out_skip="$(bash "$SCRIPT" --dry-run 2>&1)"
check "an agent with no settings.json is silently excluded from the dry-run report" \
  bash -c "! echo \"\$1\" | grep -q '^agentD '" _ "$out_skip"

echo
echo "selftest: $n case(s), $([ "$fail" = 0 ] && echo PASS || echo "FAIL ($fail failed)")"
exit "$([ "$fail" = 0 ] && echo 0 || echo 1)"
