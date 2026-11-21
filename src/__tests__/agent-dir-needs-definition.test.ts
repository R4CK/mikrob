import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Card 23a14ae1: on 2026-11-06 a stray watchdog run (wrong INSTALL_DIR, see scripts/watchdog.sh)
// mkdir -p'd a logs/ dir and wrote watchdog.log/dashboard.log under agents/logs. The dashboard
// listed every directory under agents/ as an agent, so "logs" showed up on the team page as a
// phantom agent named "Logs" and was even carried through the settings-migration sweep, despite
// never having a CLAUDE.md of its own. This pins the fix: listAgentNames() (the display/migration
// choke point) now requires a real agent definition; the lifecycle-facing listAllAgentNames()
// stays permissive on purpose (a directory mid-scaffold must still get kept alive).
const SANDBOX = mkdtempSync(join(tmpdir(), 'agentdirdef-'))
const AGENTS = join(SANDBOX, 'agents')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, MAIN_AGENT_ID: 'marveen', PROJECT_ROOT: SANDBOX, STORE_DIR: join(SANDBOX, 'store') }
})

const { listAgentNames, listAllAgentNames } = await import('../web/agent-config.js')

beforeEach(() => {
  rmSync(AGENTS, { recursive: true, force: true })
  mkdirSync(AGENTS, { recursive: true })
})
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('a directory under agents/ needs a real definition to be listed', () => {
  it('a bare folder holding only log files is not listed', () => {
    const dir = join(AGENTS, 'logs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'watchdog.log'), 'x')
    writeFileSync(join(dir, 'dashboard.log'), 'x')

    expect(listAgentNames()).not.toContain('logs')
  })

  it('a real agent (CLAUDE.md present) is still listed', () => {
    const dir = join(AGENTS, 'realagent')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'CLAUDE.md'), 'x')

    expect(listAgentNames()).toContain('realagent')
  })

  it('listAllAgentNames() stays permissive -- lifecycle sweeps must not miss a mid-scaffold agent', () => {
    const dir = join(AGENTS, 'midscaffold')
    mkdirSync(dir, { recursive: true })
    // No CLAUDE.md yet -- the wizard made the dir, the LLM call has not finished.

    expect(listAllAgentNames()).toContain('midscaffold')
    expect(listAgentNames()).not.toContain('midscaffold')
  })
})
