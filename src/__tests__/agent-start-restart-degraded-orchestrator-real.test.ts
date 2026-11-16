// Card d5638d28 round 3 (RedHat NO-GO 32245 F3): the "one shared check" fix (round 2) was never
// pinned against the REAL startAgentProcess/restartAgentProcess -- the only start test mocks
// startAgentProcess.js entirely (agent-start-degraded-orchestrator-guard.test.ts), so a mutant
// that removed the guard from one or both of startAgentProcessUnlocked/restartAgentProcessUnlocked
// stayed 51/51 green. This test calls the REAL functions against a NONEXISTENT agent name, so no
// process is ever actually spawned (both unlocked functions check `existsSync(agentDir(name))`
// and return 'Agent not found' immediately after the degraded-orchestrator check runs) -- the
// guard either refuses first (ok:false with the degraded-orchestrator message) or the call falls
// through to the "Agent not found" error, which is how this test tells "the guard ran and let it
// through" apart from "the guard was never reached at all".
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startAgentProcess, restartAgentProcess } from '../web/agent-process.js'

const AGENT = 'nonexistent-agent-d5638d28-r3-does-not-exist'

let switchDir: string
let SWITCH_PATH: string

beforeEach(() => {
  switchDir = mkdtempSync(join(tmpdir(), 'degraded-guard-real-'))
  SWITCH_PATH = join(switchDir, 'degraded-orchestrator-enabled.json')
  process.env.DEGRADED_ORCHESTRATOR_SWITCH = SWITCH_PATH
  writeFileSync(SWITCH_PATH, JSON.stringify({ enabled: true }))
})

afterEach(() => {
  rmSync(switchDir, { recursive: true, force: true })
  delete process.env.DEGRADED_ORCHESTRATOR_SWITCH
})

describe('startAgentProcess (real function, card d5638d28 round 3)', () => {
  it('switch ON, no force/actor: refused by the degraded-orchestrator guard, never reaches "Agent not found"', async () => {
    const result = await startAgentProcess(AGENT)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('degraded-orchestrator guard')
  })

  it('switch ON, force:true + actor:"mikrob": guard lets it through, reaches "Agent not found"', async () => {
    const result = await startAgentProcess(AGENT, { force: true, actor: 'mikrob' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Agent not found')
  })

  it('switch ON, force:true + actor NOT mikrob: still refused by the guard', async () => {
    const result = await startAgentProcess(AGENT, { force: true, actor: 'someone-else' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('degraded-orchestrator guard')
  })
})

describe('restartAgentProcess (real function, card d5638d28 round 3)', () => {
  it('switch ON, no force/actor: refused by the degraded-orchestrator guard, never reaches "Agent not found"', async () => {
    const result = await restartAgentProcess(AGENT)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('degraded-orchestrator guard')
  })

  it('switch ON, force:true + actor:"mikrob": guard lets it through, reaches "Agent not found"', async () => {
    const result = await restartAgentProcess(AGENT, { force: true, actor: 'mikrob' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Agent not found')
  })

  it('switch ON, force:true + actor NOT mikrob: still refused by the guard', async () => {
    const result = await restartAgentProcess(AGENT, { force: true, actor: 'someone-else' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('degraded-orchestrator guard')
  })
})
