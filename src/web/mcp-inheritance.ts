// MCPOROKLES923: which MCP servers may a NEW agent inherit? An explicit list.
//
// Owner decision (upstream 39a7e2ab/#1513, adopted on card 0c3c3796): an agent
// inherits connectors only from a named list; everything else stays out until
// someone grants it by name. Before this, two paths handed a new agent the
// operator's connectors wholesale:
//   1. agent-scaffold.ts copied the project-root .mcp.json wholesale;
//   2. agent-process.ts seeded the isolated .claude.json from a FULL copy of
//      the shared ~/.claude.json and gap-filled it on every spawn (issue #834).
// On this install ~/.claude.json and the project-root .mcp.json carry
// firecrawl, hostinger, playwright and the filesystem server -- broader
// capability/attack surface than a brand-new sub-agent needs by default.
//
// The default is the NARROW reading: an empty list inherits nothing. The list
// is configuration (AGENT_INHERITED_MCP_SERVERS), not code, because each
// install's connectors are its own.
//
// Scope, stated: this filters what is INHERITED. It never removes a server an
// agent already has (the gap-fill is additive), and it does not apply to the
// main agent, whose isolated config is by design a mirror of the operator's own
// ~/.claude.json. The scope-collision rule (agent-process.ts, 2026-09-05) runs
// in addition, never instead.
//
// What this does NOT and CANNOT cover (card 1d31cfcc F1, WhiteHat GO 0c3c3796):
// Claude Code itself, at session start, resolves project-scope MCP servers by
// discovering .mcp.json in the working directory's ANCESTOR tree -- not only
// the agent's own directory. Measured live: an agent whose own <agentDir>/.mcp.json
// declares nothing still ends up with the servers declared in the fleet's
// PROJECT_ROOT/.mcp.json (an ancestor of every agentDir), because that discovery
// happens inside the Claude Code CLI at runtime, entirely outside the files this
// module writes. There is no documented Claude Code setting (checked against the
// official docs, 2026-10-10) that disables ancestor-directory .mcp.json discovery
// for a given project path -- enabledMcpjsonServers/disabledMcpjsonServers/
// enableAllProjectMcpServers govern per-project APPROVAL of servers already
// discovered, not WHERE discovery looks. This filter therefore narrows what a
// fresh agent's OWN config files inherit; it is not, and cannot be, a boundary
// against the operator's own PROJECT_ROOT/.mcp.json reaching every agent that
// runs underneath it. Today that root file declares only two read-only,
// credential-free servers (code-review-graph, context7), so the gap has no live
// exposure -- but anything added to PROJECT_ROOT/.mcp.json in the future reaches
// every agent regardless of this list, and that must stay a conscious choice
// about what lives in the root file, not an assumption that this filter covers it.

import { getEffectiveSettingValue } from '../settings-store.js'
import { logger } from '../logger.js'

export const INHERITED_MCP_SETTING = 'AGENT_INHERITED_MCP_SERVERS'

/** The inheritable server names. Unreadable or empty setting -> empty set (narrow). */
export function readInheritableMcpServerNames(): Set<string> {
  let raw = ''
  try {
    raw = String(getEffectiveSettingValue(INHERITED_MCP_SETTING) ?? '')
  } catch {
    return new Set()
  }
  return new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))
}

/**
 * Split an mcpServers map into what may be inherited and the names that may not.
 * Pure: never mutates `servers`.
 */
export function filterInheritableMcpServers(
  servers: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): { kept: Record<string, unknown>; dropped: string[] } {
  const kept: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [key, def] of Object.entries(servers)) {
    if (allowed.has(key)) kept[key] = def
    else dropped.push(key)
  }
  return { kept, dropped }
}

/**
 * The trace every refusal leaves: which servers were NOT inherited, by name only
 * (never the definition -- it can carry credentials), and on which path.
 */
export function logNotInherited(name: string, path: 'scaffold' | 'seed' | 'seed-projects' | 'gap-fill', dropped: string[]): void {
  if (dropped.length === 0) return
  logger.info(
    { event: 'mcp-not-inherited', name, path, notInherited: dropped, setting: INHERITED_MCP_SETTING },
    'MCP inheritance: servers not on the inheritable list were not given to the agent',
  )
}

/**
 * Card 67e73b48 (RedHat R1 follow-up, 1d31cfcc): the inheritance filter above only governs what
 * a fresh agent's OWN config files receive -- it cannot stop the Claude Code CLI's own
 * ancestor-directory .mcp.json discovery, which hands every agent PROJECT_ROOT/.mcp.json's
 * servers regardless of this list (see the module header). `deniedMcpServers` in settings.json
 * is a genuine denylist that merges from every settings scope and blocks a matching server
 * regardless of where it was declared (code.claude.com/docs/en/managed-mcp, verified live
 * 2026-10-10) -- unlike enabledMcpjsonServers/disabledMcpjsonServers, it is not an approval gate.
 * This turns the "dropped" names from filterInheritableMcpServers into the settings.json shape
 * that actually closes the ancestor-discovery gap per agent. Pure: never mutates `dropped`.
 */
export function toDeniedMcpServerEntries(dropped: string[]): Array<{ serverName: string }> {
  return dropped.map((serverName) => ({ serverName }))
}
