// Card 21597530 (readAgentToolDeny, upstream c5dd9bc6, MikroB plan-grilling verdikt komment 6020:
// GO as a standalone, narrow change). Per-agent, opt-in tool-name deny list: missing/malformed
// "toolDeny" reproduces today's behaviour ([]), a present one is UNIONED onto the deny array
// writeAgentSettingsFromProfile already builds -- MikroB's own stated failure mode was that
// function's "replaces the deny list wholesale on each spawn" comment reading as though a caller
// could silently lose a security-purpose deny entry by supplying toolDeny; this pins that it cannot,
// because readAgentToolDeny's result is PUSHED onto the same array, never assigned over it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readAgentToolDeny } from '../web/agent-config.js'
import { writeAgentSettingsFromProfile, agentSettingsPath } from '../web/agent-scaffold.js'
import { loadProfileTemplate } from '../web/profiles.js'

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
})
