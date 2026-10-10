// A scaffolded agent must actually RECEIVE the shared MCP config it is entitled to (card e6fc74e0),
// and must NOT receive servers that are not on the inheritable allowlist (MCPOROKLES923, card
// 0c3c3796, upstream 39a7e2ab).
//
// THE e6fc74e0 DEFECT THIS STILL PINS. The seeding guard used to be `if (!existsSync(mcpJson))`, and
// an EMPTY `.mcp.json` satisfies it. That is not a hypothetical file: `.mcp.json` is gitignored
// (.gitignore:98), untracked copies accumulate under `seed-fleet-agents/<agent>/`, and
// `install-linux.sh:1531` copies those directories into `agents/` with `cp -r` -- into exactly the
// path the guard inspects. Measured on this checkout: 14 such files, 13 an empty `{"mcpServers":{}}`.
// For every agent seeded that way the copy never ran, and nothing repairs it afterwards:
// connectors.ts writes PROJECT_ROOT/.mcp.json or ~/.claude.json, never an agent's own file. The
// agent silently loses every PROJECT-scope server, permanently.
//
// The general shape, worth more than this instance: an empty file that satisfies an `if (!exists)`
// sentinel is not neutral -- it switches a branch OFF, with no trace in any log or guard.
//
// THE MCPOROKLES923 CHANGE. Before, the seeding step was a plain copy: every new agent got the
// WHOLE shared PROJECT_ROOT/.mcp.json, including any mail/bank/credentialed connector an operator
// might park there. Now a new agent inherits ONLY the servers named in AGENT_INHERITED_MCP_SERVERS
// (comma-separated setting). Default (card 67e73b48 N2, MikroB decision): 'code-review-graph,context7'
// -- NOT empty; those two are read-only/credential-free and useful fleet-wide, an empty default
// would silently drop both on the next restart. Anything else still stays out until named.
//
// These tests drive the real `scaffoldAgentDir` against a temporary PROJECT_ROOT rather than asserting
// on the source text, so the guard's SHAPE is free to change as long as the outcome holds.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHARED = { mcpServers: { 'code-review-graph': { type: 'stdio', command: 'x', args: [] } } }

let root: string

function setInheritedSetting(value: string): void {
  writeFileSync(join(root, 'store', 'config-overrides.json'), JSON.stringify({ AGENT_INHERITED_MCP_SERVERS: value }))
}

/** Load agent-scaffold with PROJECT_ROOT pointed at a throwaway tree. */
async function loadScaffold(): Promise<typeof import('../web/agent-scaffold.js')> {
  vi.resetModules()
  vi.doMock('../config.js', async () => {
    const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
    return { ...actual, PROJECT_ROOT: root, STORE_DIR: join(root, 'store') }
  })
  return import('../web/agent-scaffold.js')
}

const agentMcp = (name: string): string => join(root, 'agents', name, '.mcp.json')
const servers = (p: string): string[] =>
  Object.keys((JSON.parse(readFileSync(p, 'utf-8')) as { mcpServers?: object }).mcpServers ?? {})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scaffold-mcp-'))
  mkdirSync(join(root, 'agents'), { recursive: true })
  mkdirSync(join(root, 'store'), { recursive: true })
})

afterEach(() => {
  vi.doUnmock('../config.js')
  vi.resetModules()
  rmSync(root, { recursive: true, force: true })
})

describe('scaffolded agents receive ONLY the inheritable-listed MCP servers', () => {
  it('with NO AGENT_INHERITED_MCP_SERVERS override, a new agent inherits the real default (code-review-graph, context7) -- card 67e73b48 N2', async () => {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify(SHARED))
    const { scaffoldAgentDir } = await loadScaffold()
    scaffoldAgentDir('fresh')
    expect(servers(agentMcp('fresh'))).toEqual(['code-review-graph'])
  })

  it('an EXPLICITLY empty AGENT_INHERITED_MCP_SERVERS override still inherits nothing (narrow allowlist, not a hardcoded floor)', async () => {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify(SHARED))
    setInheritedSetting('')
    const { scaffoldAgentDir } = await loadScaffold()
    scaffoldAgentDir('fresh')
    expect(servers(agentMcp('fresh'))).toEqual([])
  })

  it('a server named on AGENT_INHERITED_MCP_SERVERS IS inherited', async () => {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify(SHARED))
    setInheritedSetting('code-review-graph')
    const { scaffoldAgentDir } = await loadScaffold()
    scaffoldAgentDir('fresh')
    expect(servers(agentMcp('fresh'))).toEqual(['code-review-graph'])
  })

  it('REPLACES a pre-placed EMPTY .mcp.json -- the case the old `!existsSync` guard let through', async () => {
    // This is the e6fc74e0 regression. The file below is byte-for-byte what the seed directories
    // carry and what `cp -r` delivers into agents/ on an install from a polluted checkout.
    writeFileSync(join(root, '.mcp.json'), JSON.stringify(SHARED))
    setInheritedSetting('code-review-graph')
    mkdirSync(join(root, 'agents', 'seeded'), { recursive: true })
    writeFileSync(agentMcp('seeded'), JSON.stringify({ mcpServers: {} }, null, 2))
    const { scaffoldAgentDir } = await loadScaffold()
    scaffoldAgentDir('seeded')
    expect(
      servers(agentMcp('seeded')),
      'an empty pre-placed .mcp.json still suppressed the copy -- the agent gets no inheritable servers',
    ).toEqual(['code-review-graph'])
  })

  it('LEAVES a real configuration alone -- one declared server is enough to be real', async () => {
    // The narrow half of the fix. Widening "empty" to "anything I would rather overwrite" would turn
    // a seeding step into a destructive one.
    writeFileSync(join(root, '.mcp.json'), JSON.stringify(SHARED))
    mkdirSync(join(root, 'agents', 'configured'), { recursive: true })
    writeFileSync(agentMcp('configured'), JSON.stringify({ mcpServers: { mine: { command: 'q' } } }))
    const { scaffoldAgentDir } = await loadScaffold()
    scaffoldAgentDir('configured')
    expect(servers(agentMcp('configured'))).toEqual(['mine'])
  })

  it('leaves UNPARSEABLE content alone rather than overwriting what it cannot read', async () => {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify(SHARED))
    mkdirSync(join(root, 'agents', 'broken'), { recursive: true })
    writeFileSync(agentMcp('broken'), '{ not json')
    const { scaffoldAgentDir } = await loadScaffold()
    scaffoldAgentDir('broken')
    expect(readFileSync(agentMcp('broken'), 'utf-8')).toBe('{ not json')
  })

  it('with NO shared config, still writes the valid empty shape (not "{}", which /doctor rejects)', async () => {
    const { scaffoldAgentDir } = await loadScaffold()
    scaffoldAgentDir('lonely')
    expect(existsSync(agentMcp('lonely'))).toBe(true)
    expect(JSON.parse(readFileSync(agentMcp('lonely'), 'utf-8'))).toEqual({ mcpServers: {} })
  })
})
