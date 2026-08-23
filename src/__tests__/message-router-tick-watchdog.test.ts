// Regression test for card 4a406989: a tick whose promise never settles
// latches _tickRunning true PERMANENTLY. Every later 5s interval firing sees
// _tickRunning and returns immediately -- no delivery, no "busy" log, no
// abandon-window check, nothing -- forever, silently. A service restart does
// not help if the same live conditions re-wedge the very first tick (a fresh
// process is not what this test proves fixed; the watchdog inside the SAME
// process is).
//
// Reproduces the exact measured state: a pending message never gets
// delivered_at populated after several tick periods, because the tick that
// would process it never returns. Then proves the watchdog forces the guard
// clear after TICK_WATCHDOG_MS and a later tick delivers normally.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockMarkFailed = vi.fn((..._a: unknown[]) => true)
const mockCreateAgentMessage = vi.fn((..._a: unknown[]) => ({ id: 999 }))
const mockSessionExistsOnHost = vi.fn((..._a: unknown[]) => true)
const mockSendPromptToSession = vi.fn(async (..._a: unknown[]) => 'sent' as const)

// Controls the isSessionReadyForPrompt promise per-call: the FIRST call never
// settles (simulating the measured hang); later calls resolve normally so a
// post-watchdog tick can be observed completing, not hanging a second time.
// secondCallNeverResolves (card 5094561b) is null by default (existing tests
// unaffected); the generation-counter test sets it so the SECOND call (the
// tick the watchdog starts after force-clearing the first) also hangs, so a
// late-resolving zombie first call can be tested against a genuinely still-
// running second tick, not one that already finished.
let readyCallCount = 0
let firstCallNeverResolves!: Promise<boolean>
let resolveFirstCall!: (v: boolean) => void
let secondCallNeverResolves: Promise<boolean> | null = null
let resolveSecondCall!: (v: boolean) => void

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => {
    if (toAgent) return []
    return mockGetPendingMessages()
  },
  markMessageDelivered: (...a: unknown[]) => mockMarkDelivered(...a),
  markMessageFailed: (...a: unknown[]) => mockMarkFailed(...a),
  markMessageDone: (..._a: unknown[]) => true,
  createAgentMessage: (...a: unknown[]) => mockCreateAgentMessage(...a),
  stampMessageTrace: (..._a: unknown[]) => false,
  // Card 9566a197: the delivery path re-reads the board for the cards a message was stamped with.
  // vitest THROWS on an export this mock omits, and the throw lands inside the router's per-message
  // try/catch -- the message fails silently and nothing is delivered, which is how its absence
  // showed up here as "0 sends" rather than as a missing-export error.
  getKanbanCardStateByIdPrefix: () => null,
  upsertOtelSpan: (..._a: unknown[]) => undefined,
  closeOtelSpan: (..._a: unknown[]) => false,
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: () => '/tmp/none',
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(() => {
    readyCallCount++
    if (readyCallCount === 1) return firstCallNeverResolves
    if (readyCallCount === 2 && secondCallNeverResolves) return secondCallNeverResolves
    return Promise.resolve(true)
  }),
  clearStaleParkedInput: vi.fn(() => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPromptToSession(...a),
  sessionExistsOnHost: (...a: unknown[]) => mockSessionExistsOnHost(...a),
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'orin-channels',
}))

vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'trusted-peer', safeFrom: 'orin' }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: '' }),
}))

function makePending(count: number, toAgent = 'dex') {
  const nowSec = Math.floor(Date.now() / 1000)
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    from_agent: 'orin',
    to_agent: toAgent,
    content: 'ping',
    created_at: nowSec,
  }))
}

describe('message router tick watchdog (card 4a406989)', () => {
  let handle: NodeJS.Timeout | undefined
  let startMessageRouter: typeof import('../web/message-router.js').startMessageRouter

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    readyCallCount = 0
    // A promise that only settles when the test explicitly resolves it --
    // stands in for the measured never-returning await inside a real tick.
    firstCallNeverResolves = new Promise<boolean>((resolve) => { resolveFirstCall = resolve })
    secondCallNeverResolves = null
    resolveSecondCall = () => {}
    mockSessionExistsOnHost.mockReturnValue(true)
    mockGetPendingMessages.mockReturnValue(makePending(1))
    // _tickRunning/_tickStartedAt are private module-level state in
    // message-router.ts. Without a fresh module instance per test, a hang
    // left latched by one test (by design, in the hang test) would leak
    // into the next test's fresh _tickStartedAt comparison. vi.mock() calls
    // are file-scoped and re-apply after resetModules, so the dynamic
    // re-import below still resolves through the same mocks.
    vi.resetModules()
    ;({ startMessageRouter } = await import('../web/message-router.js'))
  })

  afterEach(() => {
    if (handle) clearInterval(handle)
    vi.useRealTimers()
  })

  it('a tick that never resolves latches the router silent until the watchdog fires', async () => {
    handle = startMessageRouter()

    // First tick fires at t=5000ms and hangs inside isSessionReadyForPrompt.
    await vi.advanceTimersByTimeAsync(5000)
    expect(readyCallCount).toBe(1) // confirms the tick actually started, not skipped

    // Several more interval periods pass. Each one sees _tickRunning still
    // true (the hang has not settled) and must be a no-op: no second call
    // into isSessionReadyForPrompt, no watchdog notice yet (under the 120s
    // threshold), no delivery. 50s elapsed since the hang started (5000ms
    // hang-start + 50000ms here), well under TICK_WATCHDOG_MS.
    await vi.advanceTimersByTimeAsync(5000 * 10) // +50s since hang start
    expect(readyCallCount).toBe(1)
    expect(mockCreateAgentMessage).not.toHaveBeenCalled()

    // Cross the 120s watchdog threshold: 50s + 75s = 125s since the hang
    // started, strictly past TICK_WATCHDOG_MS (the guard is `>`, not `>=`,
    // so landing exactly on 120s would not fire it -- go past). The next
    // interval firing at/after that point must detect the stall, log it,
    // notify the orchestrator, clear the guard, and immediately attempt a
    // fresh tick in the same callback.
    await vi.advanceTimersByTimeAsync(5000 * 15) // +75s, past the threshold
    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1)
    const [, to, body] = mockCreateAgentMessage.mock.calls[0]
    expect(to).toBe('orin') // MAIN_AGENT_ID
    expect(String(body)).toContain('router-watchdog')

    // The recovery tick's own isSessionReadyForPrompt call is the SECOND
    // call overall, and per the mock resolves immediately (true) -- proving
    // the router is delivering again, not merely logging and staying dead.
    expect(readyCallCount).toBe(2)
    expect(mockSendPromptToSession).toHaveBeenCalledTimes(1)
    expect(mockMarkDelivered).toHaveBeenCalledTimes(1)
  })

  it('a tick well under the watchdog threshold never trips it', async () => {
    // Baseline: a tick that resolves normally (never hangs) must NOT ever
    // create a watchdog notice, across many ticks. Empty backlog so the
    // per-message loop (and the never-resolving mock) never engages.
    handle = startMessageRouter()
    mockGetPendingMessages.mockReturnValue([])

    await vi.advanceTimersByTimeAsync(5000 * 40) // 200s of healthy, empty ticks
    expect(mockCreateAgentMessage).not.toHaveBeenCalled()
  })

  // Card 5094561b (Cybersec adversarial finding on this same watchdog): a THIRD tick's
  // guard must survive the FIRST (zombie) tick's own await settling very late -- after
  // the watchdog already force-cleared it and started a second, genuinely running tick.
  it('a zombie first tick resolving LATE does not clear a genuinely running second tick\'s guard', async () => {
    secondCallNeverResolves = new Promise<boolean>((resolve) => { resolveSecondCall = resolve })
    handle = startMessageRouter()

    // Tick A (call #1) fires at t=5000 and hangs.
    await vi.advanceTimersByTimeAsync(5000)
    expect(readyCallCount).toBe(1)

    // Cross the watchdog threshold (same math as the test above: the first firing
    // strictly past 5000 + 120000 is at t=130000). The watchdog force-clears A's guard
    // and starts Tick B (call #2) IN THE SAME CALLBACK INVOCATION -- B also hangs
    // (secondCallNeverResolves), so the guard stays genuinely HELD, now by B.
    await vi.advanceTimersByTimeAsync(125000) // t=130000
    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1) // the watchdog notice for A
    expect(readyCallCount).toBe(2) // B has started

    // THE ADVERSARIAL MOMENT: A's own await FINALLY settles now, long after the
    // watchdog already moved on. Without the generation guard, A's `finally` would
    // unconditionally clear _tickRunning/_tickStartedAt -- which by now belong to B,
    // not A -- falsely freeing a tick that is still genuinely in flight.
    resolveFirstCall(true)
    await vi.advanceTimersByTimeAsync(0) // let A's microtask chain (and its finally) settle

    // One more normal 5s interval passes (t=135000, no second watchdog threshold
    // crossed for B, which only just started at t=130000). If A's late finally wrongly
    // cleared the guard, THIS firing would see _tickRunning=false and start a THIRD
    // tick (call #3) concurrently with B, which is still genuinely hanging -- the
    // exact "readyCallCount 3 -> 4" shape Cybersec measured on the unfixed code.
    await vi.advanceTimersByTimeAsync(5000) // t=135000
    expect(readyCallCount).toBe(2) // still just A (settled) and B (still running) -- no premature third call
    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1) // no second watchdog notice either

    // CONTROL: the mechanism is not simply stuck forever -- when B genuinely finishes,
    // its OWN finally (myGen matches, generation unchanged since B started) clears the
    // guard normally, and the router resumes on the next tick.
    resolveSecondCall(true)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5000) // next normal interval starts a real third tick
    expect(readyCallCount).toBe(3)
  })
})
