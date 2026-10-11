// WHAT THIS FILE PINS: the WIRING, not the readers.
//
// Three separate reviews found the same shape of hole: the fix was correct, the
// unit tests were green, and a mutant that DISCONNECTED the fix from its caller
// survived all of them. A reader that is never reached, and a rule that is
// called with the wrong argument, both look exactly like a working gate from a
// unit test that calls them directly.
//
// So every case here goes through the production entry point
// (`gatherGateInputs` / `checkAgent`) with the production defaults, and each one
// names the mutant it kills.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FIXTURE = mkdtempSync(join(tmpdir(), 'gate-wiring-'))
const PROJECT_ROOT = join(FIXTURE, 'marveen')
const CONFIG_DIR = join(FIXTURE, 'config')
const MAIN = 'marveen'
const SUB = 'gatewire-sub'

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  MAIN_AGENT_ID: MAIN,
  PROJECT_ROOT,
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
// No tmux in a test run: a pane that cannot be captured is `null`, which the
// gate already treats as "unknown", so it does not decide anything here.
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (n: string) => `agent-${n}`,
  capturePane: () => { throw new Error('no tmux in tests') },
}))
vi.mock('../web/context-guard-runner.js', () => ({ getHardGuardPhase: () => null }))
vi.mock('../web/main-transcript-root.js', () => ({
  configDirFor: () => CONFIG_DIR,
  newestMainConfigRoot: () => CONFIG_DIR,
}))
vi.mock('../web/claude-plans.js', () => ({ resolveAgentConfigDirForRead: () => CONFIG_DIR }))
vi.mock('../web/agent-config.js', () => ({ listAgentNames: () => [MAIN, SUB], agentConfigRoot: () => CONFIG_DIR }))

afterAll(() => { rmSync(FIXTURE, { recursive: true, force: true }) })

describe('restart gate wiring: the report-direction rule runs with the production default', () => {
  // The unit tests for this rule pass the main agent EXPLICITLY, so they say
  // nothing about what the live caller passes. Two mutants survived them:
  // a default that is not MAIN_AGENT_ID, and a caller handing the SENDER in as
  // the main agent (which switches the exclusion off for everyone).
  beforeAll(async () => {
    const { initDatabase, createAgentMessage } = await import('../db.js')
    initDatabase(':memory:')
    // A report upward: must NOT hold a restart back.
    createAgentMessage(SUB, MAIN, 'KESZ: a meres megvan, 20/20 zold.')
    // Real dispatched work to a third party: must still count.
    createAgentMessage(SUB, 'gatewire-other', 'Most rajtad a sor: rendereld le.')
    // The main agent's own delegation: counts, and this is the row the
    // exclusion must never touch.
    createAgentMessage(MAIN, SUB, 'UJ FELADAT: nezd meg a kaput.')
  })

  it('does not count a sub-agent report to the main agent, but counts real work', async () => {
    const { gatherGateInputs } = await import('../web/context-restart-gate-runner.js')
    const { inputs } = await gatherGateInputs(SUB, Date.now())
    expect(inputs.pendingOutboundCount).toBe(1)
  })

  it('still counts what the MAIN agent has dispatched downward', async () => {
    const { gatherGateInputs } = await import('../web/context-restart-gate-runner.js')
    const { inputs } = await gatherGateInputs(MAIN, Date.now())
    expect(inputs.pendingOutboundCount).toBe(1)
  })

  // The default itself, read through the production call. A default that is not
  // MAIN_AGENT_ID leaves the sub-agent's report counted, which is mutant (a);
  // this is the assertion that turns red on it.
  it('the default main-agent argument is the configured MAIN_AGENT_ID', async () => {
    const { getDispatchedPendingStats } = await import('../db.js')
    const explicit = getDispatchedPendingStats(SUB, Date.now(), 2 * 3600_000, MAIN)
    const { gatherGateInputs } = await import('../web/context-restart-gate-runner.js')
    const live = (await gatherGateInputs(SUB, Date.now())).inputs.pendingOutboundCount
    expect(live).toBe(explicit.count)
    // ...and the two differ from the unfiltered reading, or the equality above
    // would also hold for a gate that filters nothing at all.
    const unfiltered = getDispatchedPendingStats(SUB, Date.now(), 2 * 3600_000, 'nobody-is-called-this')
    expect(unfiltered.count).toBe(2)
  })
})

