import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// Card e9d3cd12 (Cybersec on the ec26c2f1 gate).
//
// Card ec26c2f1 gave withLifecycleLock a wait budget, so a wedged agent now makes startAgentProcess
// REJECT instead of hanging forever. That was the right trade -- but it moved the failure onto a
// channel schedule-runner never watched. Neither attemptFireTask's call site (:578) nor the two
// loops that drive it had a catch, so ONE stuck agent aborted the whole tick: every task ordered
// after it silently did not fire, and lastCheckMs never advanced.
//
// The harness mirrors schedule-runner-retry-missing.test.ts deliberately -- same mocks, same
// one-tick driver -- because the claim here is about the SAME loop that file already exercises,
// just with a rejecting dependency instead of a resolving one.
const mockAppendTaskRun = vi.fn()
const mockDeletePendingRetry = vi.fn()
const mockUpdatePendingRetry = vi.fn(() => true)
const mockListPendingRetries = vi.fn(() => [] as unknown[])
const mockSendPrompt = vi.fn((..._a: unknown[]) => 'sent')
const mockSessionExists = vi.fn(() => true)
const mockSessionReady = vi.fn((..._a: unknown[]): unknown => true)
const mockStartAgent = vi.fn((..._a: unknown[]): unknown => ({ ok: true }))
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))
vi.mock('../db.js', () => ({
  appendTaskRun: (...a: unknown[]) => mockAppendTaskRun(...a),
  listPendingTaskRetries: () => mockListPendingRetries(),
  deletePendingTaskRetry: (...a: unknown[]) => mockDeletePendingRetry(...a),
  updatePendingTaskRetry: mockUpdatePendingRetry,
  insertPendingTaskRetryIfNew: vi.fn(),
  markPendingTaskRetryAlert: vi.fn(() => false),
  clearPendingTaskRetryAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
}))
vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: vi.fn(async () => {}),
  sendTelegramPhoto: vi.fn(async () => {}),
}))
vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  SCHEDULED_TASKS_DIR: '/tmp/marveen-tick-rejection-no-tasks-dir',
}))
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: (...a: unknown[]) => mockSessionReady(...a),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  startAgentProcess: (...a: unknown[]) => mockStartAgent(...a),
  sessionExistsOnHost: () => mockSessionExists(),
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => false),
}))

function task(name: string, agent: string): ScheduledTask {
  return {
    name,
    schedule: '0 8 * * *',
    description: 'tick-rejection fixture',
    prompt: 'Do the thing.',
    agent,
    enabled: true,
    createdAt: 0,
    type: 'task',
    targetSession: `${agent}-session`,
  }
}

const WEDGED = task('e9d3cd12-wedged', 'wedgedagent')
const HEALTHY = task('e9d3cd12-healthy', 'healthyagent')

function retryRow(t: ScheduledTask, agent: string) {
  return {
    task_name: t.name,
    agent_name: agent,
    first_attempt: Date.now() - 5 * 60000,
    last_attempt: Date.now() - 60000,
    attempt_count: 5,
    last_reason: 'busy',
    alerted_at: null,
  }
}

async function runOneTick(): Promise<void> {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  const stop = startScheduleRunner()
  await vi.advanceTimersByTimeAsync(61_000)
  clearInterval(stop)
}

describe('one wedged agent cannot end the tick (card e9d3cd12)', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    vi.useFakeTimers()
    // A quiet moment: no cron occurrence for the fixtures, so only the pending-retry loop acts.
    vi.setSystemTime(new Date('2026-07-31T10:30:00.000Z'))
    mockListScheduledTasks.mockReturnValue([WEDGED, HEALTHY])
    mockSendPrompt.mockImplementation(() => 'sent')
    mockSessionReady.mockImplementation(() => true)
    mockStartAgent.mockImplementation(() => ({ ok: true }))
    mockSessionExists.mockReturnValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('THE MAPPING: a REJECTING auto-start becomes the existing "missing" outcome, not a thrown tick', async () => {
    // The session is gone, so the tick takes the auto-start branch -- and the auto-start rejects,
    // which is exactly what a wedged agent now does since card ec26c2f1.
    mockSessionExists.mockReturnValue(false)
    mockStartAgent.mockImplementation(() =>
      Promise.reject(new Error('lifecycle start did not settle'))
    )
    mockListPendingRetries.mockReturnValue([retryRow(WEDGED, 'wedgedagent')])

    await runOneTick()

    // 'missing' is the same verdict the !start.ok branch produces, so the retry row survives and
    // the operator-alert path keeps working -- rather than the row being stranded by a dead tick.
    expect(mockUpdatePendingRetry).toHaveBeenCalledWith(
      WEDGED.name,
      'wedgedagent',
      expect.any(Number),
      'missing'
    )
    expect(mockDeletePendingRetry).not.toHaveBeenCalled()
  })

  // The rejection below comes from isSessionReadyForPrompt, and the choice is the whole point of
  // these two tests. My FIRST version threw from sendPromptToSession instead -- and it passed
  // WITHOUT the fix, because attemptFireTask already wraps its own body (lines 720-915) in a
  // try/catch that returns 'error'. That version proved nothing. The reachable gap is the awaits
  // BEFORE that try opens: startAgentProcess (mapped precisely above), isSessionReadyForPrompt and
  // checkTaskMcpRequirements. A test for a backstop has to enter through the hole the backstop
  // covers, or the pre-existing catch answers for it.
  const wedgeReadiness = (): void => {
    mockSessionReady.mockImplementation((...a: unknown[]) => {
      if (String(a[0]).includes('wedgedagent'))
        return Promise.reject(new Error('tmux probe exploded'))
      return true
    })
  }

  it('THE LOOP SURVIVES: a task rejecting OUTSIDE the inner catch does not stop the ones behind it', async () => {
    wedgeReadiness()
    mockListPendingRetries.mockReturnValue([
      retryRow(WEDGED, 'wedgedagent'),
      retryRow(HEALTHY, 'healthyagent'),
    ])

    await runOneTick()

    const targets = mockSendPrompt.mock.calls.map((c) => String(c[0]))
    expect(
      targets.some((t) => t.includes('healthyagent')),
      'the SECOND task never ran -- one rejecting task ended the tick'
    ).toBe(true)
  })

  it('the rejecting task is recorded as an error, so it is visible rather than silently skipped', async () => {
    wedgeReadiness()
    mockListPendingRetries.mockReturnValue([retryRow(WEDGED, 'wedgedagent')])

    await runOneTick()

    expect(mockUpdatePendingRetry).toHaveBeenCalledWith(
      WEDGED.name,
      'wedgedagent',
      expect.any(Number),
      'error'
    )
  })

  it('CONTROL: an in-BODY throw was already handled before this card -- the backstop is not for that', async () => {
    // Documents the boundary the two tests above depend on. If someone later removes
    // attemptFireTask's own try/catch, this goes red and says why, instead of the backstop quietly
    // absorbing a much wider class than it was reasoned about for.
    mockSendPrompt.mockImplementation((...a: unknown[]) => {
      if (String(a[0]).includes('wedgedagent')) throw new Error('tmux send exploded')
      return 'sent'
    })
    mockListPendingRetries.mockReturnValue([
      retryRow(WEDGED, 'wedgedagent'),
      retryRow(HEALTHY, 'healthyagent'),
    ])

    await runOneTick()

    const targets = mockSendPrompt.mock.calls.map((c) => String(c[0]))
    expect(targets.some((t) => t.includes('healthyagent'))).toBe(true)
  })

  it('BASELINE: with everything healthy the retry drains normally (the guard did not swallow success)', async () => {
    // Without this, a change that turned every outcome into 'error' would look identical to the fix.
    mockListPendingRetries.mockReturnValue([retryRow(HEALTHY, 'healthyagent')])
    await runOneTick()
    expect(mockDeletePendingRetry).toHaveBeenCalledWith(HEALTHY.name, 'healthyagent')
  })
})
