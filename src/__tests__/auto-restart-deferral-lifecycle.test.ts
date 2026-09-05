// The open-question deferral STREAK's lifecycle (card 4276708e, Cybersec finding 3).
//
// The pure deferral maths (deferralOverride, restartBlockedBy) is already covered in
// src/auto-restart.ts's own suite -- nine cases. None of them touched the runner, and the defect was
// not in the maths: it was in the runner's early returns. `openQuestionDeferrals` was cleared when a
// question got answered or a restart ran, but NOT when auto-restart was disabled, and NOT when the
// agent stopped running. Its sibling map `lastRestart` was cleared on the disabled branch, which is
// what makes the omission visible as an inconsistency rather than a design choice.
//
// WHY IT MATTERS, concretely: the streak's sinceMs is the clock the deferral cap is measured
// against. A stale one survives disable -> enable, so the NEXT open question -- a brand-new one the
// owner has only just been asked -- is measured against the OLD clock, the cap reads as long
// exceeded, and the override fires on the FIRST tick. The restart then cuts through exactly the
// exchange the open-question signal exists to protect.
//
// Cybersec flagged this statically and deliberately did not run it (exercising it live restarts real
// fleet sessions). This is the sandboxed verification: every effect is mocked, nothing restarts.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const restartAgentProcess = vi.fn(async () => {})
const agentRunState = vi.fn(() => 'running' as string)
const capturePane = vi.fn(() => 'idle pane' as string | null)
const hasOpenInboundQuestion = vi.fn(() => false)
const readAutoRestartConfig = vi.fn(() => ({
  enabled: true, mode: 'continue', dailyTime: null, intervalHours: 1,
  openQuestionDeferralCapHours: 6,
}) as any)

// The wrappers forward NO arguments on purpose: the assertions below are about call COUNTS and
// the streak map, never about arguments, and a declared-but-unused parameter is a lint finding in
// this repo (no argsIgnorePattern, so even `_name` counts).
vi.mock('../web/agent-process.js', () => ({
  agentRunState: () => agentRunState(),
  agentSessionName: (n: string) => `agent-${n}`,
  restartAgentProcess: () => restartAgentProcess(),
  capturePane: () => capturePane(),
}))
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => ['a1'],
  readAgentRemoteHost: () => null,
}))
vi.mock('../web/channel-monitor.js', () => ({ respawnMainSessionFresh: () => {} }))
vi.mock('../web/auto-restart-store.js', () => ({
  readAutoRestartConfig: () => readAutoRestartConfig(),
}))
vi.mock('../db.js', () => ({
  hasOpenInboundQuestion: () => hasOpenInboundQuestion(),
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../pane-state.js', () => ({ paneLooksIdle: () => true }))

import {
  checkAgent,
  resetAutoRestartRunnerStateForTest,
  peekOpenQuestionDeferralForTest,
} from '../web/auto-restart-runner.js'

const T0 = 1_788_500_000_000
const HOUR = 3_600_000

beforeEach(() => {
  resetAutoRestartRunnerStateForTest()
  restartAgentProcess.mockClear()
  agentRunState.mockReturnValue('running')
  capturePane.mockReturnValue('idle pane')
  hasOpenInboundQuestion.mockReturnValue(false)
  readAutoRestartConfig.mockReturnValue({
    enabled: true, mode: 'continue', dailyTime: null, intervalHours: 1,
    openQuestionDeferralCapHours: 6,
  } as any)
})

/** Seed-on-first-sight, then a tick past the interval so the restart is genuinely due. */
async function seedThenDueTick(now: number, name = 'a1'): Promise<void> {
  await checkAgent(name, T0)          // first sight: records lastRestart, acts on nothing
  await checkAgent(name, now)         // due
}

describe('the streak is SET while a question defers the restart', () => {
  it('an open question on a due restart starts the streak', async () => {
    // Without this, every "it gets cleared" case below could pass on a map that is never populated.
    hasOpenInboundQuestion.mockReturnValue(true)
    await seedThenDueTick(T0 + 2 * HOUR)
    expect(peekOpenQuestionDeferralForTest('a1')?.sinceMs).toBe(T0 + 2 * HOUR)
    expect(restartAgentProcess).not.toHaveBeenCalled()
  })
})

describe('the streak is CLEARED on both early returns (Cybersec finding 3)', () => {
  it('disabling auto-restart clears it, like its sibling lastRestart already did', async () => {
    hasOpenInboundQuestion.mockReturnValue(true)
    await seedThenDueTick(T0 + 2 * HOUR)
    expect(peekOpenQuestionDeferralForTest('a1')).not.toBeNull()

    readAutoRestartConfig.mockReturnValue({ enabled: false } as any)
    await checkAgent('a1', T0 + 3 * HOUR)
    expect(peekOpenQuestionDeferralForTest('a1')).toBeNull()
  })

  it('an agent that stops running clears it too', async () => {
    hasOpenInboundQuestion.mockReturnValue(true)
    await seedThenDueTick(T0 + 2 * HOUR)
    expect(peekOpenQuestionDeferralForTest('a1')).not.toBeNull()

    agentRunState.mockReturnValue('stopped')
    await checkAgent('a1', T0 + 3 * HOUR)
    expect(peekOpenQuestionDeferralForTest('a1')).toBeNull()
  })
})

describe('THE ACTUAL DEFECT: a stale clock must not override a brand-new question', () => {
  it('after disable -> enable, a fresh question is measured from NOW, not the old sinceMs', async () => {
    // Streak opens at T0+2h with a 6h cap.
    hasOpenInboundQuestion.mockReturnValue(true)
    await seedThenDueTick(T0 + 2 * HOUR)

    // Owner disables auto-restart for a while; the question is answered meanwhile.
    readAutoRestartConfig.mockReturnValue({ enabled: false } as any)
    await checkAgent('a1', T0 + 3 * HOUR)

    // Re-enabled a long time later, and a NEW question is open.
    readAutoRestartConfig.mockReturnValue({
      enabled: true, mode: 'continue', dailyTime: null, intervalHours: 1,
      openQuestionDeferralCapHours: 6,
    } as any)
    resetSeedForReenable()
    await checkAgent('a1', T0 + 50 * HOUR)   // first sight after re-enable
    await checkAgent('a1', T0 + 52 * HOUR)   // due again, question still open

    // The clock must have restarted: sinceMs is the NEW sighting, not T0+2h.
    expect(peekOpenQuestionDeferralForTest('a1')?.sinceMs).toBe(T0 + 52 * HOUR)
    // And crucially the override has NOT fired -- the restart is still deferred.
    expect(restartAgentProcess).not.toHaveBeenCalled()
  })

  // Re-enabling also has to re-seed lastRestart; the runner does that itself by deleting the entry
  // on the disabled branch, so nothing is needed here beyond letting the next tick seed again.
  function resetSeedForReenable(): void { /* intentionally empty -- documents the dependency */ }
})
