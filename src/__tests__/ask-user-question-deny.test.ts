// Card 91cec070: structural, session-level AskUserQuestion denial for every headless role-agent.
// Predecessor 5c6fe8df tried a skill-level `disallowed-tools` frontmatter field; WhiteHat2 (msg
// 11835) found it inert for gate-agents (own project-scoped skill instance + turn-scoped field).
// This pins the actual fix: a whole-tool-name `permissions.deny` entry, written the same way
// SELF_PACE_TOOL_DENY already is, which survives --dangerously-skip-permissions (deny is checked
// before the bypass allow -- measured live 2026-10-14 with a WebSearch control pair: the denied
// tool vanished from both the top-level and deferred-tools list under
// `claude --dangerously-skip-permissions -p`, the control tool did not).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeAgentSettingsFromProfile, agentSettingsPath, agentGetsGovernanceGates } from '../web/agent-scaffold.js'
import { loadProfileTemplate } from '../web/profiles.js'
import { MAIN_AGENT_ID } from '../config.js'

const ROOT = join(__dirname, '..', '..')
const AGENT_NAME = 'askuserq-deny-scaffold-test'
const AGENT_DIR = join(ROOT, 'agents', AGENT_NAME)

function deny(): string[] {
  const settings = JSON.parse(readFileSync(agentSettingsPath(AGENT_NAME), 'utf-8'))
  return settings.permissions.deny as string[]
}

beforeEach(() => {
  // Same safety pattern as agent-tool-deny.test.ts: refuse on anything that looks like a live
  // install rather than a disposable test fixture.
  if (existsSync(join(AGENT_DIR, 'HANDOFF.md'))) {
    throw new Error(`refusing: agents/${AGENT_NAME} looks like a live install, not a test fixture`)
  }
  rmSync(AGENT_DIR, { recursive: true, force: true })
  mkdirSync(AGENT_DIR, { recursive: true })
})
afterEach(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true })
})

describe('AskUserQuestion tool-name deny (card 91cec070)', () => {
  it('a sub-agent (not MAIN_AGENT_ID) is subject to the governance gate', () => {
    expect(agentGetsGovernanceGates(AGENT_NAME)).toBe(true)
    expect(agentGetsGovernanceGates(MAIN_AGENT_ID)).toBe(false)
  })

  it('writeAgentSettingsFromProfile denies AskUserQuestion for a sub-agent', () => {
    writeAgentSettingsFromProfile(AGENT_NAME, loadProfileTemplate('default'))
    expect(deny()).toContain('AskUserQuestion')
  })

  it('the pre-existing SELF_PACE_TOOL_DENY entries survive alongside it (additive, not replaced)', () => {
    writeAgentSettingsFromProfile(AGENT_NAME, loadProfileTemplate('default'))
    const list = deny()
    expect(list).toContain('AskUserQuestion')
    expect(list).toContain('ScheduleWakeup')
    expect(list).toContain('CronCreate')
  })

  it('survives a second write (the respawn)', () => {
    writeAgentSettingsFromProfile(AGENT_NAME, loadProfileTemplate('default'))
    expect(deny()).toContain('AskUserQuestion')
    writeAgentSettingsFromProfile(AGENT_NAME, loadProfileTemplate('default'))
    expect(deny()).toContain('AskUserQuestion')
  })
})
