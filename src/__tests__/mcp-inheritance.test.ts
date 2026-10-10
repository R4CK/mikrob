import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// MCPOROKLES923 (card 0c3c3796, upstream 39a7e2ab) -- a NEW agent inherits MCP
// servers only from an explicit list (AGENT_INHERITED_MCP_SERVERS), on BOTH
// inheritance paths:
//   1. agent-scaffold.ts: the project-root .mcp.json copy;
//   2. agent-process.ts: the isolated .claude.json first-seed + gap-fill from the
//      shared ~/.claude.json.
// Two controls: (i) an UNLISTED server does not arrive; (ii) a LISTED one does --
// without (ii) a green run could just mean "we copy nothing any more". And the
// 2026-09-05 scope-collision rule must survive the filter.

const SANDBOX = mkdtempSync(join(tmpdir(), 'mcpinherit-'))
let LIST = ''
// F4 (card 1d31cfcc): drives the "unreadable setting" branch of
// readInheritableMcpServerNames without a separate mock module -- flipped per-test.
let THROW_SETTING = false

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => join(SANDBOX, 'home') }
})
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: join(SANDBOX, 'project'), STORE_DIR: join(SANDBOX, 'project', 'store') }
})
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return { ...actual, agentDir: (name: string) => join(SANDBOX, 'agents', name) }
})
vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return {
    ...actual,
    getEffectiveSettingValue: (key: string) => {
      if (key !== 'AGENT_INHERITED_MCP_SERVERS') return actual.getEffectiveSettingValue(key)
      if (THROW_SETTING) throw new Error('settings-store unreachable (simulated)')
      return LIST
    },
  }
})

const { scaffoldAgentDir } = await import('../web/agent-scaffold.js')
const { ensureIsolatedChannelConfigDir } = await import('../web/agent-process.js')
const { MAIN_AGENT_ID } = await import('../config.js')
const { filterInheritableMcpServers, readInheritableMcpServerNames, toDeniedMcpServerEntries } = await import('../web/mcp-inheritance.js')
const { logger } = await import('../logger.js')

const def = (cmd: string) => ({ command: 'npx', args: [cmd] })

function resetSandbox(): void {
  rmSync(join(SANDBOX, 'home'), { recursive: true, force: true })
  rmSync(join(SANDBOX, 'agents'), { recursive: true, force: true })
  rmSync(join(SANDBOX, 'project'), { recursive: true, force: true })
  mkdirSync(join(SANDBOX, 'home', '.claude'), { recursive: true })
  writeFileSync(join(SANDBOX, 'home', '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: {} }))
  mkdirSync(join(SANDBOX, 'project', 'store'), { recursive: true })
}
function writeProjectMcp(servers: Record<string, unknown>): void {
  writeFileSync(join(SANDBOX, 'project', '.mcp.json'), JSON.stringify({ mcpServers: servers }))
}
function writeSharedDotClaude(servers: Record<string, unknown>): void {
  writeFileSync(join(SANDBOX, 'home', '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: servers }))
}
function agentMcpServers(name: string): string[] {
  const j = JSON.parse(readFileSync(join(SANDBOX, 'agents', name, '.mcp.json'), 'utf-8')) as { mcpServers: Record<string, unknown> }
  return Object.keys(j.mcpServers).sort()
}
function isolatedServers(name: string): string[] {
  const p = join(SANDBOX, 'agents', name, '.claude-config', '.claude.json')
  const j = JSON.parse(readFileSync(p, 'utf-8')) as { mcpServers?: Record<string, unknown> }
  return Object.keys(j.mcpServers ?? {}).sort()
}
function isolatedDenied(name: string): string[] | undefined {
  const p = join(SANDBOX, 'agents', name, '.claude-config', 'settings.json')
  const j = JSON.parse(readFileSync(p, 'utf-8')) as { deniedMcpServers?: Array<{ serverName: string }> }
  return j.deniedMcpServers?.map((e) => e.serverName).sort()
}

beforeEach(() => { resetSandbox(); LIST = ''; THROW_SETTING = false })
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('the list itself', () => {
  it('parses a comma list, trims, ignores blanks; an empty setting is the narrow default', () => {
    LIST = ' aiam-blog , ,google-drive '
    expect([...readInheritableMcpServerNames()].sort()).toEqual(['aiam-blog', 'google-drive'])
    LIST = ''
    expect(readInheritableMcpServerNames().size).toBe(0)
  })

  it('filter keeps listed, names the rest, never mutates its input', () => {
    const servers = { a: def('a'), b: def('b') }
    const { kept, dropped } = filterInheritableMcpServers(servers, new Set(['a']))
    expect(Object.keys(kept)).toEqual(['a'])
    expect(dropped).toEqual(['b'])
    expect(Object.keys(servers)).toEqual(['a', 'b'])
  })

  it('toDeniedMcpServerEntries maps names to the settings.json denylist shape, pure', () => {
    const dropped = ['code-review-graph', 'context7']
    expect(toDeniedMcpServerEntries(dropped)).toEqual([
      { serverName: 'code-review-graph' },
      { serverName: 'context7' },
    ])
    expect(dropped).toEqual(['code-review-graph', 'context7'])
    expect(toDeniedMcpServerEntries([])).toEqual([])
  })
})

// Card 67e73b48 (RedHat R1 follow-up, 1d31cfcc): the filter above only governs what a fresh
// agent's OWN config files inherit -- it cannot stop the Claude Code CLI's ancestor-directory
// .mcp.json discovery, which hands every agent PROJECT_ROOT/.mcp.json's servers regardless of
// this filter. `deniedMcpServers` in the agent's own settings.json is a genuine, cross-scope
// denylist (verified against the live docs) that closes that gap structurally. These tests
// exercise the wiring in provisionIsolatedConfigDir (agent-process.ts), reached here through
// ensureIsolatedChannelConfigDir exactly like the .mcp.json-seed tests above.
describe('R1 structural fix: deniedMcpServers deny-lists what this agent did not inherit', () => {
  it('a root server NOT on the allowlist is deny-listed; a listed one is not', () => {
    writeProjectMcp({ 'code-review-graph': def('crg'), context7: def('c7') })
    LIST = 'code-review-graph'
    ensureIsolatedChannelConfigDir('deny1', 'telegram')
    expect(isolatedDenied('deny1')).toEqual(['context7'])
  })

  it('empty allowlist (the default): every root server is deny-listed', () => {
    writeProjectMcp({ 'code-review-graph': def('crg'), context7: def('c7') })
    LIST = ''
    ensureIsolatedChannelConfigDir('deny2', 'telegram')
    expect(isolatedDenied('deny2')).toEqual(['code-review-graph', 'context7'])
  })

  it('no root .mcp.json: the denylist is the valid empty shape, not missing/crashed', () => {
    ensureIsolatedChannelConfigDir('deny3', 'telegram')
    expect(isolatedDenied('deny3')).toEqual([])
  })

  it('the main agent is exempt: no deniedMcpServers key at all', () => {
    writeProjectMcp({ 'code-review-graph': def('crg'), context7: def('c7') })
    LIST = ''
    ensureIsolatedChannelConfigDir(MAIN_AGENT_ID, 'telegram')
    const p = join(SANDBOX, 'agents', MAIN_AGENT_ID, '.claude-config', 'settings.json')
    const j = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
    expect('deniedMcpServers' in j).toBe(false)
  })

  it('recomputed on every provision, not stuck on an older root/allowlist snapshot', () => {
    writeProjectMcp({ 'code-review-graph': def('crg') })
    LIST = 'code-review-graph'
    ensureIsolatedChannelConfigDir('deny4', 'telegram')
    expect(isolatedDenied('deny4')).toEqual([])
    writeProjectMcp({ 'code-review-graph': def('crg'), context7: def('c7') })
    LIST = ''
    ensureIsolatedChannelConfigDir('deny4', 'telegram')
    expect(isolatedDenied('deny4')).toEqual(['code-review-graph', 'context7'])
  })
})

describe('path 1: scaffold copies the project .mcp.json THROUGH the list', () => {
  it('(i) an unlisted server does NOT arrive; (ii) a listed one DOES', () => {
    writeProjectMcp({ 'aiam-blog': def('blog'), gmail: def('gmail') })
    LIST = 'aiam-blog'
    scaffoldAgentDir('uj1')
    expect(agentMcpServers('uj1')).toEqual(['aiam-blog'])
  })

  it('empty list (the default): the new agent gets the valid empty shape, nothing else', () => {
    writeProjectMcp({ 'aiam-blog': def('blog'), gmail: def('gmail') })
    scaffoldAgentDir('uj2')
    expect(agentMcpServers('uj2')).toEqual([])
  })

  it('an existing agent .mcp.json is never rewritten by the scaffold', () => {
    writeProjectMcp({ gmail: def('gmail') })
    mkdirSync(join(SANDBOX, 'agents', 'regi'), { recursive: true })
    writeFileSync(join(SANDBOX, 'agents', 'regi', '.mcp.json'), JSON.stringify({ mcpServers: { sajat: def('own') } }))
    scaffoldAgentDir('regi')
    expect(agentMcpServers('regi')).toEqual(['sajat'])
  })
})

describe('path 2: the isolated .claude.json seed and gap-fill go THROUGH the list', () => {
  it('(i)+(ii) on the FIRST SEED: an unlisted server is stopped, a listed server arrives', () => {
    writeSharedDotClaude({ 'google-drive': def('gdrive'), Filesystem: def('fs'), 'aiam-blog': def('blog') })
    LIST = 'aiam-blog'
    ensureIsolatedChannelConfigDir('uj3', 'telegram')
    expect(isolatedServers('uj3')).toEqual(['aiam-blog'])
  })

  it('(i)+(ii) on the GAP-FILL: a server added later reaches the agent only if listed', () => {
    writeSharedDotClaude({ 'aiam-blog': def('blog') })
    LIST = 'aiam-blog,cortex'
    ensureIsolatedChannelConfigDir('uj4', 'telegram')
    writeSharedDotClaude({ 'aiam-blog': def('blog'), cortex: def('cortex'), gmail: def('gmail') })
    ensureIsolatedChannelConfigDir('uj4', 'telegram')
    expect(isolatedServers('uj4')).toEqual(['aiam-blog', 'cortex'])
  })

  it('additive: an agent that ALREADY has an unlisted server keeps it (existing agents untouched)', () => {
    writeSharedDotClaude({ 'google-drive': def('gdrive') })
    LIST = 'google-drive'
    ensureIsolatedChannelConfigDir('regi2', 'telegram')           // seeded while it was listed
    LIST = ''                                                      // list narrowed afterwards
    writeSharedDotClaude({ 'google-drive': def('gdrive'), gmail: def('gmail') })
    ensureIsolatedChannelConfigDir('regi2', 'telegram')
    expect(isolatedServers('regi2')).toEqual(['google-drive'])     // kept, gmail not added
  })

  it('the main agent is exempt on the GAP-FILL path too', () => {
    writeSharedDotClaude({ 'google-drive': def('gdrive') })
    LIST = ''
    ensureIsolatedChannelConfigDir(MAIN_AGENT_ID, 'telegram')
    writeSharedDotClaude({ 'google-drive': def('gdrive'), gmail: def('gmail') })
    ensureIsolatedChannelConfigDir(MAIN_AGENT_ID, 'telegram')
    expect(isolatedServers(MAIN_AGENT_ID)).toEqual(['gmail', 'google-drive'])
  })

  it('every refusal leaves a trace: the NAMES only, never a definition', () => {
    const spy = vi.spyOn(logger, 'info')
    writeSharedDotClaude({ gmail: { command: 'npx', args: ['gmail'], env: { TOKEN: 'secret-value-xyz' } } })
    LIST = ''
    ensureIsolatedChannelConfigDir('nyom', 'telegram')
    const rows = spy.mock.calls.filter((c) => (c[0] as { event?: string })?.event === 'mcp-not-inherited')
    expect(rows).toHaveLength(1)
    expect(rows[0][0]).toMatchObject({ name: 'nyom', path: 'seed', notInherited: ['gmail'] })
    expect(JSON.stringify(spy.mock.calls)).not.toContain('secret-value-xyz')
    spy.mockRestore()
  })

  it('the main agent is exempt: its config mirrors the operator\'s own ~/.claude.json', () => {
    writeSharedDotClaude({ 'google-drive': def('gdrive'), gmail: def('gmail') })
    LIST = ''
    ensureIsolatedChannelConfigDir(MAIN_AGENT_ID, 'telegram')
    expect(isolatedServers(MAIN_AGENT_ID)).toEqual(['gmail', 'google-drive'])
  })
})

describe('the 2026-09-05 scope-collision rule survives the filter', () => {
  it('a LISTED server the agent defines in its own .mcp.json is still not shadowed (seed)', () => {
    mkdirSync(join(SANDBOX, 'agents', 'cort'), { recursive: true })
    writeFileSync(join(SANDBOX, 'agents', 'cort', '.mcp.json'), JSON.stringify({ mcpServers: { cortex: def('own-cortex') } }))
    writeSharedDotClaude({ cortex: def('router-cortex'), 'aiam-blog': def('blog') })
    LIST = 'cortex,aiam-blog'
    ensureIsolatedChannelConfigDir('cort', 'telegram')
    expect(isolatedServers('cort')).toEqual(['aiam-blog'])
  })

  it('...and on the gap-fill path too', () => {
    mkdirSync(join(SANDBOX, 'agents', 'cort2'), { recursive: true })
    writeFileSync(join(SANDBOX, 'agents', 'cort2', '.mcp.json'), JSON.stringify({ mcpServers: { cortex: def('own-cortex') } }))
    writeSharedDotClaude({ 'aiam-blog': def('blog') })
    LIST = 'cortex,aiam-blog'
    ensureIsolatedChannelConfigDir('cort2', 'telegram')
    writeSharedDotClaude({ 'aiam-blog': def('blog'), cortex: def('router-cortex') })
    ensureIsolatedChannelConfigDir('cort2', 'telegram')
    expect(isolatedServers('cort2')).toEqual(['aiam-blog'])
  })

  // An UNLISTED server the agent also owns at project scope is refused for two
  // reasons; both traces must be left, whichever rule runs first.
  // Rows are scoped to one agent name so a spy left behind by an earlier failing
  // test cannot leak its rows into this one.
  const logRows = (spy: { mock: { calls: unknown[][] } }, agent: string, pred: (o: Record<string, unknown>) => boolean) =>
    spy.mock.calls
      .map((c: unknown[]) => c[0] as Record<string, unknown>)
      .filter((o: Record<string, unknown>) => o && typeof o === 'object' && o.name === agent && pred(o))

  it('unlisted AND project-scoped logs BOTH labels on the seed path', () => {
    mkdirSync(join(SANDBOX, 'agents', 'ket1'), { recursive: true })
    writeFileSync(join(SANDBOX, 'agents', 'ket1', '.mcp.json'), JSON.stringify({ mcpServers: { cortex: def('own-cortex') } }))
    writeSharedDotClaude({ cortex: def('router-cortex') })
    LIST = ''
    const spy = vi.spyOn(logger, 'info')
    ensureIsolatedChannelConfigDir('ket1', 'telegram')
    expect(logRows(spy, 'ket1', (o) => o.event === 'mcp-not-inherited')).toEqual([
      expect.objectContaining({ name: 'ket1', path: 'seed', notInherited: ['cortex'] }),
    ])
    expect(logRows(spy, 'ket1', (o) => Array.isArray(o.dropped))).toEqual([{ name: 'ket1', dropped: ['cortex'] }])
    expect(isolatedServers('ket1')).toEqual([])
    spy.mockRestore()
  })

  it('unlisted AND project-scoped logs BOTH labels on the gap-fill path', () => {
    mkdirSync(join(SANDBOX, 'agents', 'ket2'), { recursive: true })
    writeFileSync(join(SANDBOX, 'agents', 'ket2', '.mcp.json'), JSON.stringify({ mcpServers: { cortex: def('own-cortex') } }))
    writeSharedDotClaude({})
    LIST = ''
    ensureIsolatedChannelConfigDir('ket2', 'telegram')
    writeSharedDotClaude({ cortex: def('router-cortex') })
    const spy = vi.spyOn(logger, 'info')
    ensureIsolatedChannelConfigDir('ket2', 'telegram')
    expect(logRows(spy, 'ket2', (o) => o.event === 'mcp-not-inherited')).toEqual([
      expect.objectContaining({ name: 'ket2', path: 'gap-fill', notInherited: ['cortex'] }),
    ])
    expect(logRows(spy, 'ket2', (o) => Array.isArray(o.shadowed))).toEqual([{ name: 'ket2', shadowed: ['cortex'] }])
    expect(isolatedServers('ket2')).toEqual([])
    spy.mockRestore()
  })

  it('a LISTED project-scoped server logs only the collision, not a list refusal', () => {
    mkdirSync(join(SANDBOX, 'agents', 'ket3'), { recursive: true })
    writeFileSync(join(SANDBOX, 'agents', 'ket3', '.mcp.json'), JSON.stringify({ mcpServers: { cortex: def('own-cortex') } }))
    writeSharedDotClaude({ cortex: def('router-cortex') })
    LIST = 'cortex'
    const spy = vi.spyOn(logger, 'info')
    ensureIsolatedChannelConfigDir('ket3', 'telegram')
    expect(logRows(spy, 'ket3', (o) => o.event === 'mcp-not-inherited')).toEqual([])
    expect(logRows(spy, 'ket3', (o) => Array.isArray(o.dropped))).toEqual([{ name: 'ket3', dropped: ['cortex'] }])
    spy.mockRestore()
  })

  // The other branch must stay silent: both labels on every refusal would be as
  // useless for diagnosis as none. One-condition cases, on both paths.
  it('a LISTED project-scoped server logs only the collision on the gap-fill path too', () => {
    mkdirSync(join(SANDBOX, 'agents', 'ket4'), { recursive: true })
    writeFileSync(join(SANDBOX, 'agents', 'ket4', '.mcp.json'), JSON.stringify({ mcpServers: { cortex: def('own-cortex') } }))
    writeSharedDotClaude({})
    LIST = 'cortex'
    ensureIsolatedChannelConfigDir('ket4', 'telegram')
    writeSharedDotClaude({ cortex: def('router-cortex') })
    const spy = vi.spyOn(logger, 'info')
    ensureIsolatedChannelConfigDir('ket4', 'telegram')
    expect(logRows(spy, 'ket4', (o) => o.event === 'mcp-not-inherited')).toEqual([])
    expect(logRows(spy, 'ket4', (o) => Array.isArray(o.shadowed))).toEqual([{ name: 'ket4', shadowed: ['cortex'] }])
    spy.mockRestore()
  })

  it('an UNLISTED server the agent does not own logs only the list refusal (seed)', () => {
    mkdirSync(join(SANDBOX, 'agents', 'ket5'), { recursive: true })
    writeFileSync(join(SANDBOX, 'agents', 'ket5', '.mcp.json'), JSON.stringify({ mcpServers: { cortex: def('own-cortex') } }))
    writeSharedDotClaude({ gmail: def('gmail') })
    LIST = ''
    const spy = vi.spyOn(logger, 'info')
    ensureIsolatedChannelConfigDir('ket5', 'telegram')
    expect(logRows(spy, 'ket5', (o) => o.event === 'mcp-not-inherited')).toEqual([
      expect.objectContaining({ path: 'seed', notInherited: ['gmail'] }),
    ])
    expect(logRows(spy, 'ket5', (o) => Array.isArray(o.dropped))).toEqual([])
    spy.mockRestore()
  })

  it('an UNLISTED server the agent does not own logs only the list refusal (gap-fill)', () => {
    mkdirSync(join(SANDBOX, 'agents', 'ket6'), { recursive: true })
    writeFileSync(join(SANDBOX, 'agents', 'ket6', '.mcp.json'), JSON.stringify({ mcpServers: { cortex: def('own-cortex') } }))
    writeSharedDotClaude({})
    LIST = ''
    ensureIsolatedChannelConfigDir('ket6', 'telegram')
    writeSharedDotClaude({ gmail: def('gmail') })
    const spy = vi.spyOn(logger, 'info')
    ensureIsolatedChannelConfigDir('ket6', 'telegram')
    expect(logRows(spy, 'ket6', (o) => o.event === 'mcp-not-inherited')).toEqual([
      expect.objectContaining({ path: 'gap-fill', notInherited: ['gmail'] }),
    ])
    expect(logRows(spy, 'ket6', (o) => Array.isArray(o.shadowed))).toEqual([])
    spy.mockRestore()
  })
})

describe('F4 test gaps (card 1d31cfcc, WhiteHat GO 0c3c3796)', () => {
  it('unreadable setting: getEffectiveSettingValue throwing is the narrow default, not a crash', () => {
    THROW_SETTING = true
    expect(readInheritableMcpServerNames().size).toBe(0)
  })

  it('default (no root .mcp.json at all): the new agent gets the valid empty shape', () => {
    // No writeProjectMcp() call -- PROJECT_ROOT/.mcp.json simply does not exist.
    scaffoldAgentDir('nodef')
    expect(agentMcpServers('nodef')).toEqual([])
  })

  it('unparseable root .mcp.json: inherits nothing, and the log never carries a content fragment (F3)', () => {
    mkdirSync(join(SANDBOX, 'project'), { recursive: true })
    // Deliberately malformed from position 0 (not just a trailing typo): on
    // Node's V8, JSON.parse quotes a snippet of input THIS shaped in its
    // SyntaxError message ("Unexpected token 'g', \"garbage SE\"... is not
    // valid JSON") -- exactly the leak F3 flagged if a secret sat there.
    writeFileSync(join(SANDBOX, 'project', '.mcp.json'), 'garbage SECRET-TOKEN-VALUE not json')
    const spy = vi.spyOn(logger, 'warn')
    scaffoldAgentDir('badjson')
    expect(agentMcpServers('badjson')).toEqual([])
    const call = spy.mock.calls.find((c) => (c[0] as Record<string, unknown>)?.name === 'badjson')
    expect(call).toBeDefined()
    const payload = call![0] as Record<string, unknown>
    // The regression this guards: passing the raw JSON.parse error as `err` lets
    // pino's own serializer pull out `.message`, which on V8 can quote a
    // fragment of the malformed input (see comment above). Asserting on the
    // CALL ARGUMENTS directly (not JSON.stringify(spy.mock.calls), which drops
    // Error.message because it is non-enumerable and so would pass even
    // un-fixed) is what makes this test actually kill the regression.
    expect(payload.err).toBeUndefined()
    expect(typeof payload.errName).toBe('string')
    spy.mockRestore()
  })

  it('F2 fix: a project-scoped mcpServers entry inside shared ~/.claude.json projects[] is filtered too', () => {
    writeFileSync(
      join(SANDBOX, 'home', '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        mcpServers: {},
        projects: {
          '/some/other/project': { mcpServers: { 'aiam-blog': def('blog'), gmail: def('gmail') } },
        },
      }),
    )
    LIST = 'aiam-blog'
    ensureIsolatedChannelConfigDir('projfilt', 'telegram')
    const p = join(SANDBOX, 'agents', 'projfilt', '.claude-config', '.claude.json')
    const j = JSON.parse(readFileSync(p, 'utf-8')) as { projects: Record<string, { mcpServers: Record<string, unknown> }> }
    expect(Object.keys(j.projects['/some/other/project'].mcpServers)).toEqual(['aiam-blog'])
  })
})
