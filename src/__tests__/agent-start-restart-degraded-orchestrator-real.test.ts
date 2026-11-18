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
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startAgentProcess, restartAgentProcess } from '../web/agent-process.js'

const AGENT = 'nonexistent-agent-d5638d28-r3-does-not-exist'

/** Source with `//` line comments and /* *\/ blocks removed (card e3cf26d0, same technique as
 *  agent-working-dir-single-source.test.ts's own stripComments). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

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

  // Round 4 (CYBERED NO-GO 32270, RedHat's follow-up on the "known gap" in REVIEW 32264): for a
  // NONEXISTENT agent, restartAgentProcessUnlocked's own early guard and startAgentProcessUnlocked's
  // inner guard are indistinguishable (both refuse, either one alone would pass the tests above) --
  // RedHat measured that removing restartAgentProcessUnlocked's OWN early check alone stays green.
  // The early guard is independently load-bearing for an ALREADY-RUNNING agent: without it, a
  // degraded-mode restart would stop that agent (beginRestart -> stopAgentProcessUnlocked) BEFORE
  // ever reaching the refusal, leaving it dead instead of left running. A live tmux session is not
  // safe to spin up in a unit test, so this pins the SOURCE ORDER instead (RedHat's own accepted
  // alternative): the guard's refusal call must appear before the function's first
  // stopAgentProcessUnlocked call, so the stop can never execute before the refusal has a chance to.
  it('source-order pin: the degraded-orchestrator guard runs before the first stopAgentProcessUnlocked call', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'web', 'agent-process.ts'), 'utf-8')
    const fnStart = src.indexOf('async function restartAgentProcessUnlocked(')
    expect(fnStart).toBeGreaterThan(-1)
    const fnEnd = src.indexOf('\n}\n', fnStart)
    expect(fnEnd).toBeGreaterThan(fnStart)
    // Card e3cf26d0 (RedHat/WhiteHat LOW-4 on d5638d28): a plain indexOf on the raw source found
    // the string `degradedOrchestratorRefusal(` even when the actual call was commented out
    // (`// const refusal = degradedOrchestratorRefusal(...)`), because the text survives in the
    // comment -- the pin passed while proving nothing. Strip comments first, same technique as
    // agent-working-dir-single-source.test.ts's stripComments, so a commented-out call is
    // indistinguishable from an absent one.
    const body = stripComments(src.slice(fnStart, fnEnd))
    const guardIdx = body.indexOf('degradedOrchestratorRefusal(')
    const stopIdx = body.indexOf('stopAgentProcessUnlocked(')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(stopIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(stopIdx)
  })
})
