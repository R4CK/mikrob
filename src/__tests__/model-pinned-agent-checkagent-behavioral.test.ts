// Card 60aeca01 (d8d035f8 N1): model-pinned-agents.test.ts's "checkAgent / ... source wiring"
// describe block only greps checkAgent's source text for the literal
// `if (isModelPinned(name)) return` line -- a mutation that turned the pin check into a no-op
// while leaving that exact line elsewhere in a comment, or reordered the real check behind the
// parked-agent branch instead of before it, would not be caught. This file calls the REAL
// checkAgent (exported test-only as `_checkAgentForTest`) on a pinned agent at the deepest weekly
// tier (99%, tier 2) and asserts none of its I/O ran at all -- the pinned branch returns before
// touching any of it, so this needs no behaviour from the mocks beyond "don't throw, count calls".
import { describe, it, expect, vi, beforeEach } from 'vitest'

const agentRunState = vi.fn(() => 'running')
const capturePane = vi.fn(() => null)
const readAgentRemoteHost = vi.fn(() => null)
const readAgentModel = vi.fn(() => 'claude-sonnet-5')
const writeAgentModel = vi.fn()

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../web/channel-monitor.js', () => ({ hardRestartMarveenChannels: vi.fn(() => ({ ok: true })) }))
vi.mock('../web/agent-process.js', () => ({
  agentRunState,
  agentSessionName: (n: string) => `agent-${n}`,
  restartAgentProcess: vi.fn(async () => ({ ok: true })),
  capturePane,
}))
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...real, readAgentRemoteHost, readAgentModel, writeAgentModel }
})

const { _checkAgentForTest } = await import('../web/model-fallback-runner.js')
const { DEFAULT_MODEL_FALLBACK, weeklyTierIndex, DEFAULT_WEEKLY_TIER1_PERCENT, DEFAULT_WEEKLY_TIER2_PERCENT } =
  await import('../model-fallback.js')

describe('checkAgent on a pinned agent at 99% weekly (card d8d035f8, behavioural)', () => {
  beforeEach(() => {
    agentRunState.mockClear()
    capturePane.mockClear()
    readAgentRemoteHost.mockClear()
    readAgentModel.mockClear()
    writeAgentModel.mockClear()
  })

  const tierCfg = { weeklyTier1Percent: DEFAULT_WEEKLY_TIER1_PERCENT, weeklyTier2Percent: DEFAULT_WEEKLY_TIER2_PERCENT }
  const weeklyIdx = weeklyTierIndex(99, tierCfg, 0)
  const cfg = { ...DEFAULT_MODEL_FALLBACK, enabled: true, weeklyTierEnabled: true }

  it('99% resolves to tier 2, the deepest step (sanity on the input, not the thing under test)', () => {
    expect(weeklyIdx).toBe(2)
  })

  it('a real call for a pinned agent touches NONE of the pane/model I/O', async () => {
    await _checkAgentForTest('cybersec', Date.now(), cfg, weeklyIdx)
    expect(agentRunState).not.toHaveBeenCalled()
    expect(capturePane).not.toHaveBeenCalled()
    expect(readAgentRemoteHost).not.toHaveBeenCalled()
    expect(readAgentModel).not.toHaveBeenCalled()
    expect(writeAgentModel).not.toHaveBeenCalled()
  })

  // CONTROL: without this, a checkAgent that touched NOTHING for every agent (pinned or not) --
  // e.g. the pin check accidentally short-circuiting the whole function for everyone -- would
  // satisfy the assertion above for the wrong reason.
  it('CONTROL: a non-pinned agent at the same tier DOES reach the pane/model I/O', async () => {
    await _checkAgentForTest('backend2', Date.now(), cfg, weeklyIdx)
    expect(agentRunState).toHaveBeenCalledWith('backend2')
  })
})
