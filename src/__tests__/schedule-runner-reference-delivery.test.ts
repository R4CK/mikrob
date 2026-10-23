// SCHEDPROMPTREF917 (card e7cd6365 R4): buildScheduledTaskBlock + maybeSendSizeGuardNotice were
// written, tested in isolation (prompt-safety.test.ts, scheduled-run-snapshot.test.ts) and then
// never wired into the real fire path -- attemptFireTaskUnguarded kept calling the plain inline
// wrapScheduledTask() directly. This file exercises the WIRED path end to end: a short body stays
// inline (regression safety -- every existing scheduled-task test relies on this), an oversized
// local-session body switches to a snapshot reference, and a failed snapshot write falls back to
// inline rather than losing the task.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

const mockAppendTaskRun = vi.fn()
const mockSendPrompt = vi.fn((..._a: unknown[]) => 'sent')
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])
const mockWriteSnapshot = vi.fn()

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../db.js', () => ({
  appendTaskRun: (...a: unknown[]) => mockAppendTaskRun(...a),
  listPendingTaskRetries: () => [],
  deletePendingTaskRetry: vi.fn(),
  updatePendingTaskRetry: vi.fn(() => true),
  insertPendingTaskRetryIfNew: vi.fn(),
  markPendingTaskRetryAlert: vi.fn(() => false),
  clearPendingTaskRetryAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
}))

vi.mock('../channel-provider.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../channel-provider.js')>()
  return {
    ...real,
    getProvider: (type: Parameters<typeof real.getProvider>[0]) => ({
      ...real.getProvider(type),
      sendMessage: vi.fn(async () => {}),
      sendPhoto: vi.fn(async () => {}),
    }),
  }
})

vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  readScheduledTask: (n: string) => (mockListScheduledTasks() as Array<{ name: string }>).find(t => t.name === n) ?? null,
  SCHEDULED_TASKS_DIR: '/tmp/marveen-reference-delivery-no-tasks-dir',
  SCHEDULED_TASK_INLINE_MAX_CHARS: 1_500,
  SCHEDULED_TASK_BODY_WARN_CHARS: 20_000,
  MAX_SCHEDULED_TASK_PROMPT_LEN: 50_000,
}))

vi.mock('../web/scheduled-run-snapshot.js', () => ({
  writeScheduledRunSnapshot: (...a: unknown[]) => mockWriteSnapshot(...a),
  isScheduledRunReference: (filePath: string) => filePath.startsWith('/tmp/marveen-reference-delivery-snapshots/'),
}))

vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: vi.fn(async () => false),
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: vi.fn(async () => true),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...(a as [])),
  startAgentProcess: vi.fn(() => ({ ok: true })),
  sessionExistsOnHost: () => true,
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => false),
  resolveAgentProvider: () => 'telegram',
}))

function task(overrides: Partial<ScheduledTask> & { name: string; schedule: string }): ScheduledTask {
  return {
    description: 'reference-delivery fixture',
    prompt: 'Do the thing.',
    agent: 'refagent',
    enabled: true,
    createdAt: 0,
    type: 'task',
    targetSession: 'ref-test-session', // host stays null (local): see resolveTaskTarget
    ...overrides,
  }
}

async function runOneTick() {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  const stop = startScheduleRunner()
  await vi.advanceTimersByTimeAsync(61_000)
  clearInterval(stop)
}

describe('schedule runner: SCHEDPROMPTREF917 reference-delivery wiring', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-31T06:00:00.000Z')) // 08:00 Budapest (CEST, UTC+2) -- cron '0 8 * * *' fires here
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('a normal-sized body stays inline, byte-for-byte the pre-wiring format', async () => {
    mockListScheduledTasks.mockReturnValue([task({ name: 'ref-short', schedule: '0 8 * * *' })])
    await runOneTick()

    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(mockWriteSnapshot).not.toHaveBeenCalled()
    const fullPrompt = mockSendPrompt.mock.calls[0][1] as string
    expect(fullPrompt).toContain('<scheduled-task source="scheduled-task:ref-short">')
    expect(fullPrompt).not.toContain('body-file=')
  })

  it('an oversized local-session body switches to a snapshot reference', async () => {
    mockWriteSnapshot.mockReturnValue({
      filePath: '/tmp/marveen-reference-delivery-snapshots/ref-long-20260731.md',
      sha256: 'deadbeef',
      chars: 2000,
    })
    mockListScheduledTasks.mockReturnValue([
      task({ name: 'ref-long', schedule: '0 8 * * *', prompt: 'x'.repeat(2000) }),
    ])
    await runOneTick()

    expect(mockWriteSnapshot).toHaveBeenCalledTimes(1)
    const fullPrompt = mockSendPrompt.mock.calls[0][1] as string
    expect(fullPrompt).toContain('body-file="/tmp/marveen-reference-delivery-snapshots/ref-long-20260731.md"')
    expect(fullPrompt).toContain('body-sha256="deadbeef"')
  })

  it('a failed snapshot write falls back to inline -- the task is never dropped', async () => {
    mockWriteSnapshot.mockReturnValue(null) // mkdir/write failure (see scheduled-run-snapshot.ts)
    mockListScheduledTasks.mockReturnValue([
      task({ name: 'ref-long-fail', schedule: '0 8 * * *', prompt: 'x'.repeat(2000) }),
    ])
    await runOneTick()

    expect(mockWriteSnapshot).toHaveBeenCalledTimes(1)
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    const fullPrompt = mockSendPrompt.mock.calls[0][1] as string
    expect(fullPrompt).not.toContain('body-file=')
    expect(fullPrompt).toContain('<scheduled-task source="scheduled-task:ref-long-fail">')
  })
})
