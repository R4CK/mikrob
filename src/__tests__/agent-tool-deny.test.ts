// Card 21597530 (readAgentToolDeny, upstream c5dd9bc6, MikroB plan-grilling verdikt komment 6020:
// GO as a standalone, narrow change). Per-agent, opt-in tool-name deny list: missing/malformed
// "toolDeny" reproduces today's behaviour ([]), a present one is UNIONED onto the deny array
// writeAgentSettingsFromProfile already builds -- MikroB's own stated failure mode was that
// function's "replaces the deny list wholesale on each spawn" comment reading as though a caller
// could silently lose a security-purpose deny entry by supplying toolDeny; this pins that it cannot,
// because readAgentToolDeny's result is PUSHED onto the same array, never assigned over it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readAgentToolDeny, sanitizeToolDenyList, TOOL_DENY_MAX_PER_AGENT } from '../web/agent-config.js'
import { writeAgentSettingsFromProfile, agentSettingsPath } from '../web/agent-scaffold.js'
import { loadProfileTemplate } from '../web/profiles.js'
import { logger } from '../logger.js'

const ROOT = join(__dirname, '..', '..')
const AGENT_NAME = 'tooldeny-scaffold-test'
const AGENT_DIR = join(ROOT, 'agents', AGENT_NAME)
const CONFIG_PATH = join(AGENT_DIR, 'agent-config.json')

function writeConfig(content: Record<string, unknown>): void {
  mkdirSync(AGENT_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(content, null, 2))
}

beforeEach(() => {
  // Same safety pattern as heartbeat-hook-wiring.test.ts: refuse if this looks like a live
  // install rather than the disposable, gitignored `agents/` runtime-state directory a test
  // checkout has. AGENT_NAME is synthetic (never a real fleet agent), so a HANDOFF.md here would
  // mean something has gone very wrong, not that this is expected state.
  if (existsSync(join(AGENT_DIR, 'HANDOFF.md'))) {
    throw new Error(`refusing: agents/${AGENT_NAME} looks like a live install, not a test fixture`)
  }
  rmSync(AGENT_DIR, { recursive: true, force: true })
})
afterEach(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true })
})

describe('readAgentToolDeny (card 21597530)', () => {
  it('no agent-config.json at all -> []', () => {
    expect(readAgentToolDeny(AGENT_NAME)).toEqual([])
  })

  it('agent-config.json without a toolDeny key -> []', () => {
    writeConfig({ model: 'claude-sonnet-5' })
    expect(readAgentToolDeny(AGENT_NAME)).toEqual([])
  })

  it('a present toolDeny array is returned as-is', () => {
    writeConfig({ toolDeny: ['Artifact', 'Workflow'] })
    expect(readAgentToolDeny(AGENT_NAME)).toEqual(['Artifact', 'Workflow'])
  })

  it('a non-array toolDeny is ignored, not thrown on -> []', () => {
    writeConfig({ toolDeny: 'Artifact' })
    expect(readAgentToolDeny(AGENT_NAME)).toEqual([])
  })

  it('non-string entries inside toolDeny are filtered out, not thrown on', () => {
    writeConfig({ toolDeny: ['Artifact', 42, null, 'Workflow'] })
    expect(readAgentToolDeny(AGENT_NAME)).toEqual(['Artifact', 'Workflow'])
  })

  it('malformed JSON -> [], not a throw', () => {
    mkdirSync(AGENT_DIR, { recursive: true })
    writeFileSync(CONFIG_PATH, '{ not json')
    expect(readAgentToolDeny(AGENT_NAME)).toEqual([])
  })
})

// Card b5b7eb6b child b0d84dc3 (upstream ORSIKTXRATA914, 1abd45cf): only bare tool names are
// accepted, entries are deduped, and the list is capped -- ported alongside readAgentToolDeny.
describe('sanitizeToolDenyList (card b0d84dc3)', () => {
  it('rejects a "Tool(pattern)" shape -- this field can only ever widen the deny list with bare names', () => {
    expect(sanitizeToolDenyList(['Bash(rm *)'])).toEqual([])
  })

  it('rejects an empty string and a name starting with a digit or symbol', () => {
    expect(sanitizeToolDenyList(['', '1Tool', '_Tool', 'Tool Name'])).toEqual([])
  })

  it('accepts an mcp__server__tool-shaped name', () => {
    expect(sanitizeToolDenyList(['mcp__playwright__browser_click'])).toEqual(['mcp__playwright__browser_click'])
  })

  it('trims whitespace before validating', () => {
    expect(sanitizeToolDenyList(['  Artifact  '])).toEqual(['Artifact'])
  })

  it('dedupes repeated entries, keeping the first occurrence', () => {
    expect(sanitizeToolDenyList(['Artifact', 'Workflow', 'Artifact'])).toEqual(['Artifact', 'Workflow'])
  })

  it('caps at TOOL_DENY_MAX_PER_AGENT, keeping the first entries in order', () => {
    const names = Array.from({ length: TOOL_DENY_MAX_PER_AGENT + 10 }, (_, i) => `Tool${i}`)
    const out = sanitizeToolDenyList(names)
    expect(out).toHaveLength(TOOL_DENY_MAX_PER_AGENT)
    expect(out).toEqual(names.slice(0, TOOL_DENY_MAX_PER_AGENT))
  })

  it('non-array input -> []', () => {
    expect(sanitizeToolDenyList('Artifact')).toEqual([])
    expect(sanitizeToolDenyList(null)).toEqual([])
    expect(sanitizeToolDenyList(undefined)).toEqual([])
  })
})

// Card 7a52fa9c (Cybersec GO on b0d84dc3 @fe4b323f, msg 6197): a hyphenated qualified MCP tool
// name (real shape: mcp__<server>__<tool>, and the server segment CAN be hyphenated) was silently
// dropped by the old letters/digits/underscore-only regex -- an operator who denied
// mcp__code-review-graph__apply_refactor_tool got no deny and no warning. Truncation past
// TOOL_DENY_MAX_PER_AGENT was equally silent.
describe('sanitizeToolDenyList: hyphenated names and silent-drop signal (card 7a52fa9c)', () => {
  it('keeps a hyphenated qualified MCP tool name (the exact shape that silently dropped)', () => {
    expect(sanitizeToolDenyList(['mcp__code-review-graph__apply_refactor_tool']))
      .toEqual(['mcp__code-review-graph__apply_refactor_tool'])
  })

  it('WARNs when an invalid-shape entry is dropped', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    expect(sanitizeToolDenyList(['Bash(rm *)', 'Artifact'])).toEqual(['Artifact'])
    expect(warn).toHaveBeenCalledTimes(1)
    const [fields, msg] = warn.mock.calls[0]!
    expect(msg).toContain('sanitizeToolDenyList')
    expect((fields as { value?: string }).value).toBe('Bash(rm *)')
    warn.mockRestore()
  })

  it('WARNs once per entry truncated past TOOL_DENY_MAX_PER_AGENT, naming the value', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    const names = Array.from({ length: TOOL_DENY_MAX_PER_AGENT + 3 }, (_, i) => `Tool${i}`)
    const out = sanitizeToolDenyList(names)
    expect(out).toHaveLength(TOOL_DENY_MAX_PER_AGENT)
    expect(warn).toHaveBeenCalledTimes(3)
    const values = warn.mock.calls.map(([fields]) => (fields as { value?: string }).value)
    expect(values).toEqual([`Tool${TOOL_DENY_MAX_PER_AGENT}`, `Tool${TOOL_DENY_MAX_PER_AGENT + 1}`, `Tool${TOOL_DENY_MAX_PER_AGENT + 2}`])
    warn.mockRestore()
  })

  it('does NOT warn on a duplicate -- the name is already denied, nothing was lost', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    expect(sanitizeToolDenyList(['Artifact', 'Artifact'])).toEqual(['Artifact'])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('readAgentToolDeny threads the agent name into the warning context', () => {
    writeConfig({ toolDeny: ['Bash(rm *)'] })
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    expect(readAgentToolDeny(AGENT_NAME)).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    const [fields] = warn.mock.calls[0]!
    expect((fields as { context?: string }).context).toBe(AGENT_NAME)
    warn.mockRestore()
  })
})

describe('writeAgentSettingsFromProfile unions toolDeny, never replaces (card 21597530)', () => {
  function deny(): string[] {
    const settings = JSON.parse(readFileSync(agentSettingsPath(AGENT_NAME), 'utf-8'))
    return settings.permissions.deny as string[]
  }

  it('no toolDeny configured: deny list is unaffected (todays behaviour)', () => {
    const before = (() => {
      writeAgentSettingsFromProfile(AGENT_NAME, loadProfileTemplate('default'))
      return deny()
    })()
    rmSync(AGENT_DIR, { recursive: true, force: true })
    writeConfig({ toolDeny: [] })
    writeAgentSettingsFromProfile(AGENT_NAME, loadProfileTemplate('default'))
    expect(deny()).toEqual(before)
  })

  it('a configured toolDeny entry is UNIONED into the deny list, alongside it, not in place of it', () => {
    writeConfig({ toolDeny: ['Artifact', 'Workflow'] })
    writeAgentSettingsFromProfile(AGENT_NAME, loadProfileTemplate('default'))
    const list = deny()
    expect(list).toContain('Artifact')
    expect(list).toContain('Workflow')
    // The pre-existing, security-purpose deny entries must SURVIVE alongside the new ones -- this
    // is the exact failure mode MikroB's verdict warned about ("whole-cseréli" reading).
    const profile = loadProfileTemplate('default')
    const priorEntry = profile.filesystem.deny[0]
    expect(priorEntry, 'fixture assumption: default profile has at least one filesystem.deny entry').toBeTruthy()
    expect(list.some((d) => d.includes(priorEntry.replace(/^\{[A-Z_]+\}\//, '')))).toBe(true)
  })

  it('an unknown/garbage tool name does not throw and is written verbatim', () => {
    writeConfig({ toolDeny: ['TotallyNotARealTool123'] })
    expect(() => writeAgentSettingsFromProfile(AGENT_NAME, loadProfileTemplate('default'))).not.toThrow()
    expect(deny()).toContain('TotallyNotARealTool123')
  })

  it('a "Tool(pattern)" shaped toolDeny entry is rejected, not written as a pattern rule', () => {
    writeConfig({ toolDeny: ['Bash(rm *)', 'Artifact'] })
    writeAgentSettingsFromProfile(AGENT_NAME, loadProfileTemplate('default'))
    const list = deny()
    expect(list).not.toContain('Bash(rm *)')
    expect(list).toContain('Artifact')
  })

  // Card b0d84dc3 (upstream ORSIKTXRATA914): a hand-edited toolDeny must survive a SECOND spawn
  // write (the respawn), not only the first -- settings.json is derived state, rebuilt wholesale
  // from the profile on every spawn, so this is the exact scenario the durable agent-config.json
  // home exists for.
  it('a toolDeny entry survives a second write (the respawn)', () => {
    writeConfig({ toolDeny: ['Artifact'] })
    writeAgentSettingsFromProfile(AGENT_NAME, loadProfileTemplate('default'))
    expect(deny()).toContain('Artifact')
    // The respawn: nothing about the config changed, but the scaffold rebuilds settings.json again.
    writeAgentSettingsFromProfile(AGENT_NAME, loadProfileTemplate('default'))
    expect(deny()).toContain('Artifact')
  })

  // Card b0d84dc3 (upstream ORSIKTXRATA914): the write must be additive to the deny list only --
  // a toolDeny entry must never leak into permissions.allow, which the profile template owns.
  it('does not touch the allow list', () => {
    writeConfig({ toolDeny: ['Artifact', 'Workflow'] })
    const profile = loadProfileTemplate('default')
    writeAgentSettingsFromProfile(AGENT_NAME, profile)
    const settings = JSON.parse(readFileSync(agentSettingsPath(AGENT_NAME), 'utf-8'))
    expect(settings.permissions.allow).toHaveLength(profile.filesystem.allow.length)
    expect(settings.permissions.allow).not.toContain('Artifact')
    expect(settings.permissions.allow).not.toContain('Workflow')
  })
})
