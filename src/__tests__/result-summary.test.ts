import { describe, it, expect, vi } from 'vitest'

// The route module pulls in the DB and the agent config; neither is needed to measure the
// summary rule, and both would make this test a deployment test instead.
vi.mock('../db.js', () => ({
  createAgentMessage: vi.fn(), getPendingMessages: vi.fn(), listAgentMessages: vi.fn(),
  getAgentConversation: vi.fn(), getAgentConversationThreads: vi.fn(),
  getKanbanSeqByIdPrefix: vi.fn(), markMessageDone: vi.fn(), markMessageFailed: vi.fn(),
  getAgentMessage: vi.fn(), closeOtelSpan: vi.fn(), getPendingBacklogByAgent: vi.fn(),
}))
vi.mock('../web/agent-config.js', () => ({ isKnownAgent: vi.fn(() => true) }))

const { resultSummary, RESULT_NOTIFY_MAX } = await import('../web/routes/messages.js')

describe('resultSummary -- a truncated result stays FOLLOWABLE', () => {
  it('passes a short result through unchanged', () => {
    expect(resultSummary(42, 'done, 3 lines')).toBe('done, 3 lines')
  })

  it('says so when there is no result -- never returns an empty string', () => {
    expect(resultSummary(42, undefined)).toBe('(no result)')
    expect(resultSummary(42, '')).toBe('(no result)')
  })

  it('does not truncate AT the boundary: exactly RESULT_NOTIFY_MAX characters unchanged', () => {
    const exactly = 'x'.repeat(RESULT_NOTIFY_MAX)
    expect(resultSummary(42, exactly)).toBe(exactly)
  })

  it('one character over the boundary already truncates, and says so', () => {
    const over = 'x'.repeat(RESULT_NOTIFY_MAX + 1)
    const out = resultSummary(42, over)
    expect(out).not.toBe(over)
    expect(out).toContain('truncated')
  })

  // THE POINT. The old version named a FIELD ("msg N's result field"), which the recipient
  // could not read in one step -- it twice asked for a resend instead. The marker therefore
  // carries a RUNNABLE command, with the CONCRETE id.
  it('the marker gives a runnable command, with the real message id', () => {
    const out = resultSummary(1767, 'y'.repeat(RESULT_NOTIFY_MAX + 500))
    expect(out).toContain('bash scripts/agent-msg-get.sh 1767')
    // The pointer SAYS what it points to: the named id is not the id of the message being read.
    // Without this an agent queried its own id, got an empty answer, and would have reported
    // data loss.
    expect(out).toContain("NOT this message's own id")
  })

  it('says HOW MUCH was cut -- otherwise there is no way to know if it is worth chasing', () => {
    const out = resultSummary(7, 'z'.repeat(RESULT_NOTIFY_MAX + 137))
    expect(out).toContain('137 more characters')
  })

  it('the part forwarded is the UNCUT start, not some shorter excerpt', () => {
    const original = 'A'.repeat(RESULT_NOTIFY_MAX) + 'B'.repeat(50)
    const out = resultSummary(9, original)
    expect(out.startsWith('A'.repeat(RESULT_NOTIFY_MAX))).toBe(true)
    expect(out).not.toContain('B')
  })

  // The boundary cannot be arbitrary: too small brings back exactly the bug this function
  // exists for (the cut landing mid-argument), too large spends the recipient's context
  // without consent. Both directions measured.
  it('the boundary is generous, but finite', () => {
    expect(RESULT_NOTIFY_MAX).toBeGreaterThanOrEqual(1500)
    expect(RESULT_NOTIFY_MAX).toBeLessThanOrEqual(8000)
  })
})
