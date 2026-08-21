// Card 74ba7c78: the sync->async conversion (873c48df) removed an atomicity nobody had written down.
//
// Before it, startAgentProcess/stopAgentProcess were fully synchronous, so the event loop could not
// run anything between the `isAgentRunning()` guard and its effect -- the guard was atomic BY
// ACCIDENT. Making them async was right (a 3-second freeze of the dashboard is not a locking
// strategy), but it left a TOCTOU window across every await, and two concurrent requests could both
// pass the same check. A duplicate tmux session is how an agent ends up with two pollers racing the
// same bot token.
//
// The behaviour is proven on the LOCK itself and on the WIRING, because exercising the real
// functions would drive tmux. That split is deliberate: a mock deep enough to fake tmux would be
// asserting against my own model of tmux, not against the race.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LIFECYCLE_OP_TIMEOUT_MS,
  LifecycleOpTimeoutError,
  lifecycleInFlightCount,
  withLifecycleLock,
} from '../web/agent-process.js'

const AGENT_PROCESS = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'agent-process.ts')
const src = readFileSync(AGENT_PROCESS, 'utf-8')

// The REAL lock from the module -- not a re-implementation. An earlier draft copied the shape here,
// and then deleting the module's coalescing left every test green: the copy was testing itself.
// Agent names are unique per test so the shared module-level map cannot couple them.
let seq = 0
// Default to the SAME operation identity so the existing coalescing cases read unchanged; the
// mixed-overlap cases below pass their own kind/optsKey.
const lock = <T>(suffix: string, op: () => Promise<T>, kind: 'start' | 'stop' | 'restart' = 'start', optsKey = ''): Promise<T> =>
  withLifecycleLock(`t${seq}-${suffix}`, kind, optsKey, op)

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('the per-agent in-flight guard collapses concurrent lifecycle calls', () => {
  beforeEach(() => { seq += 1 })
  it('runs the operation ONCE for two concurrent callers on the same agent', async () => {
    let runs = 0
    const op = async (): Promise<string> => { runs += 1; await tick(20); return 'done' }
    const [a, b] = await Promise.all([lock('alpha', op), lock('alpha', op)])
    expect(runs, 'the second caller started a second operation -- the guard did not coalesce').toBe(1)
    expect(a).toBe('done')
    expect(b).toBe('done')
  })

  it('does NOT couple different agents', async () => {
    let runs = 0
    const op = async (): Promise<void> => { runs += 1; await tick(10) }
    await Promise.all([lock('alpha', op), lock('beta', op)])
    expect(runs, 'a second agent was blocked by the first -- the guard is keyed too coarsely').toBe(2)
  })

  it('releases the slot so a LATER call runs again (it is a guard, not a cache)', async () => {
    let runs = 0
    const op = async (): Promise<void> => { runs += 1; await tick(5) }
    await lock('alpha', op)
    await lock('alpha', op)
    expect(runs).toBe(2)
  })

  it('a failing operation does not poison the agent forever', async () => {
    let runs = 0
    const boom = async (): Promise<void> => { runs += 1; await tick(5); throw new Error('nope') }
    await expect(lock('alpha', boom)).rejects.toThrow('nope')
    await expect(lock('alpha', boom)).rejects.toThrow('nope')
    expect(runs, 'the slot was never released after a rejection').toBe(2)
  })

  it('a rejection reaches BOTH the owner and the joiner', async () => {
    const boom = async (): Promise<void> => { await tick(10); throw new Error('nope') }
    const first = lock('alpha', boom)
    const second = lock('alpha', boom)
    await expect(first).rejects.toThrow('nope')
    await expect(second).rejects.toThrow('nope')
  })

  it('the module starts with nothing in flight (no leaked entries at import time)', () => {
    expect(lifecycleInFlightCount()).toBe(0)
  })
})

describe('a DIFFERENT operation never joins a running one (Cybersec + Cybered NO-GO)', () => {
  beforeEach(() => { seq += 1 })

  // The regression that made the first version worse than the race it fixed: a stop() arriving
  // during a start() was handed the start's promise, never ran, and returned {ok:true}. The caller
  // in routes/agents.ts then drops the desired-state entry unconditionally, so the reconciler stops
  // bringing the agent back -- while it is in fact still running and still burning the shared quota.
  it('a stop arriving during a start RUNS, and returns its OWN result', async () => {
    const ran: string[] = []
    const startOp = async (): Promise<{ ok: boolean; pid?: number }> => {
      ran.push('start'); await tick(30); return { ok: true, pid: 4242 }
    }
    const stopOp = async (): Promise<{ ok: boolean }> => { ran.push('stop'); await tick(5); return { ok: true } }

    const started = lock('alpha', startOp, 'start', 'fresh=false')
    await tick(5)
    const stopped = lock('alpha', stopOp, 'stop', '')
    const [s1, s2] = await Promise.all([started, stopped])

    expect(ran, 'the stop never ran -- it joined the start').toEqual(['start', 'stop'])
    expect(s1).toEqual({ ok: true, pid: 4242 })
    expect(s2, 'the stop caller was handed the start result').toEqual({ ok: true })
  })

  it('a start arriving during a stop RUNS too, after it', async () => {
    const ran: string[] = []
    const stopOp = async (): Promise<{ ok: boolean }> => { ran.push('stop'); await tick(25); return { ok: true } }
    const startOp = async (): Promise<{ ok: boolean; pid?: number }> => {
      ran.push('start'); await tick(5); return { ok: true, pid: 7 }
    }
    const stopped = lock('alpha', stopOp, 'stop', '')
    await tick(5)
    const started = lock('alpha', startOp, 'start', 'fresh=false')
    await Promise.all([stopped, started])
    expect(ran).toEqual(['stop', 'start'])
    expect(await started).toEqual({ ok: true, pid: 7 })
  })

  it('different OPTIONS are a different request too -- a fresh start is not answered by a warm one', async () => {
    const ran: string[] = []
    const warm = async (): Promise<{ ok: boolean; fresh: boolean }> => {
      ran.push('warm'); await tick(25); return { ok: true, fresh: false }
    }
    const fresh = async (): Promise<{ ok: boolean; fresh: boolean }> => {
      ran.push('fresh'); await tick(5); return { ok: true, fresh: true }
    }
    const a = lock('alpha', warm, 'start', 'fresh=false')
    await tick(5)
    const b = lock('alpha', fresh, 'start', 'fresh=true')
    await Promise.all([a, b])
    expect(ran, 'the fresh start silently got the warm run').toEqual(['warm', 'fresh'])
    expect(await b).toEqual({ ok: true, fresh: true })
  })

  it('the queued operation still runs when the one ahead of it FAILS', async () => {
    const ran: string[] = []
    const boom = async (): Promise<never> => { ran.push('start'); await tick(15); throw new Error('start failed') }
    const stopOp = async (): Promise<{ ok: boolean }> => { ran.push('stop'); return { ok: true } }
    const failing = lock('alpha', boom, 'start', 'fresh=false')
    await tick(5)
    const stopped = lock('alpha', stopOp, 'stop', '')
    await expect(failing).rejects.toThrow('start failed')
    expect(await stopped, 'the queued stop inherited the start failure').toEqual({ ok: true })
    expect(ran).toEqual(['start', 'stop'])
  })

  it('still never runs two operations on one agent AT THE SAME TIME', async () => {
    let concurrent = 0
    let peak = 0
    const op = async (): Promise<void> => {
      concurrent += 1; peak = Math.max(peak, concurrent); await tick(15); concurrent -= 1
    }
    await Promise.all([
      lock('alpha', op, 'start', 'fresh=false'),
      lock('alpha', op, 'stop', ''),
      lock('alpha', op, 'restart', 'fresh=true'),
    ])
    expect(peak, 'two lifecycle operations overlapped on one agent').toBe(1)
  })
})

describe('the lifecycle entry points are actually wired through the guard', () => {
  it.each(['startAgentProcess', 'stopAgentProcess', 'restartAgentProcess'])(
    '%s is exported as a locked wrapper',
    (fn) => {
      const at = src.indexOf(`export function ${fn}(`)
      expect(at, `${fn} is not exported as a plain (wrapper) function`).toBeGreaterThan(-1)
      // The body of a wrapper is one line; anything longer means real work crept in beside the lock.
      // Bounded to the function's OWN body: a fixed-size window spilled into the NEXT wrapper,
      // whose body contains the same call -- so the assertion passed even with the lock removed.
      const body = src.slice(at, src.indexOf('\n}', at))
      expect(body, `${fn} does not route through withLifecycleLock -- the TOCTOU window is open again`)
        .toContain('return withLifecycleLock(')
    },
  )

  it.each(['startAgentProcessUnlocked', 'stopAgentProcessUnlocked', 'restartAgentProcessUnlocked'])(
    '%s stays PRIVATE (an exported unlocked variant would be a way around the guard)',
    (fn) => {
      expect(src).toMatch(new RegExp(`async function ${fn}\\(`))
      expect(src, `${fn} is exported -- callers could bypass the guard`).not.toMatch(new RegExp(`export async function ${fn}\\(`))
    },
  )

  it('restart composes the UNLOCKED variants, so it cannot join its own lock', () => {
    // Calling the public ones inside restart would return restart's own in-flight promise and hang.
    expect(src).toContain('await stopAgentProcessUnlocked(name)')
    expect(src).toContain('await startAgentProcessUnlocked(name, opts)')
  })
})

// ── Card ec26c2f1 ─────────────────────────────────────────────────────────────────────────────
// Cybersec on the bc898166 gate: the lock has no timeout, so a wedged lifecycle operation makes
// every caller wait forever. Measured while fixing it, and WORSE than the card stated -- this is
// not only a precondition for adopting upstream's tickRunning guard, it is live today:
// schedule-runner.ts's runCheck() sets its own `tickRunning = true`, then awaits attemptFireTask
// (lines 1244/1374), which awaits startAgentProcess -> withLifecycleLock. That guard has no stale
// check, so one wedged operation latches it true permanently and the WHOLE scheduler stops firing,
// with a logger.debug line as its only trace.
//
// The fix bounds the WAIT and deliberately does NOT release the mutual exclusion -- see the comment
// on withWaitTimeout. These tests pin both halves, because getting only the first one right is how
// the card 74ba7c78 race would come back.
describe('a wedged lifecycle operation releases its CALLER but not its LOCK (card ec26c2f1)', () => {
  beforeEach(() => {
    seq += 1
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** An operation that never settles -- the measured shape of a hung tmux/ssh call. */
  const wedged = () => new Promise<string>(() => {})

  it('THE FIX: the caller is rejected instead of waiting forever', async () => {
    const p = lock('wedge', wedged)
    const assertion = expect(p).rejects.toBeInstanceOf(LifecycleOpTimeoutError)
    await vi.advanceTimersByTimeAsync(LIFECYCLE_OP_TIMEOUT_MS + 1)
    await assertion
  })

  it('the rejection names the agent and the kind, so a log line can be acted on (rule 12)', async () => {
    const p = lock('named', wedged, 'restart', 'fresh=false')
    const caught = p.then<LifecycleOpTimeoutError | null, LifecycleOpTimeoutError | null>(
      () => null,
      (e: unknown) => e as LifecycleOpTimeoutError
    )
    await vi.advanceTimersByTimeAsync(LIFECYCLE_OP_TIMEOUT_MS + 1)
    const err = await caught
    expect(err, 'the wedged call resolved instead of timing out').toBeInstanceOf(
      LifecycleOpTimeoutError
    )
    expect(err?.agent).toContain('named')
    expect(err?.kind).toBe('restart')
    expect(err?.waitedMs).toBe(LIFECYCLE_OP_TIMEOUT_MS)
  })

  it('THE OTHER HALF: the per-agent lock is STILL HELD, so no second operation starts', async () => {
    // Releasing the entry on timeout would be the easy version of this fix and would re-open the
    // exact race two security gates were spent on (card 74ba7c78): a second tmux/ssh call on an
    // agent whose first one is still running somewhere. Nothing here can cancel that first call.
    const before = lifecycleInFlightCount()
    const p = lock('held', wedged)
    p.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(LIFECYCLE_OP_TIMEOUT_MS + 1)
    expect(lifecycleInFlightCount()).toBe(before + 1)
  })

  it('a DIFFERENT request behind a wedged one is bounded too, and still does not run', async () => {
    let ran = 0
    const p1 = lock('queued', wedged, 'start', '')
    p1.catch(() => undefined)
    const p2 = lock(
      'queued',
      async () => {
        ran += 1
        return 'x'
      },
      'stop',
      ''
    )
    const assertion = expect(p2).rejects.toBeInstanceOf(LifecycleOpTimeoutError)
    await vi.advanceTimersByTimeAsync(LIFECYCLE_OP_TIMEOUT_MS + 1)
    await assertion
    expect(ran, 'the queued operation must NOT have run past the wedged holder').toBe(0)
  })

  it('a JOINER of a wedged operation is bounded too (joining is not a way back to waiting forever)', async () => {
    const p1 = lock('join', wedged, 'start', '')
    p1.catch(() => undefined)
    const p2 = lock('join', wedged, 'start', '') // identical identity -> coalesces onto p1
    const assertion = expect(p2).rejects.toBeInstanceOf(LifecycleOpTimeoutError)
    await vi.advanceTimersByTimeAsync(LIFECYCLE_OP_TIMEOUT_MS + 1)
    await assertion
  })

  it('BASELINE: an operation that finishes in time is untouched -- no timeout, entry released', async () => {
    // Without this, a "fix" that rejected everything immediately would look identical to the one
    // under test.
    const before = lifecycleInFlightCount()
    const p = lock('fast', async () => {
      await tick(10)
      return 'done'
    })
    await vi.advanceTimersByTimeAsync(20)
    await expect(p).resolves.toBe('done')
    expect(lifecycleInFlightCount()).toBe(before)
  })

  it('a normally-FAILING operation still surfaces ITS error, not a timeout', async () => {
    const p = lock('boom', async () => {
      throw new Error('tmux said no')
    })
    await expect(p).rejects.toThrow('tmux said no')
  })

  it('the timer does not hold the process open (unref) and is cleared on a normal finish', async () => {
    // A per-call 180s timer that kept the event loop alive would turn every lifecycle call into a
    // 3-minute exit delay. Asserted on the source because there is no observable handle for it.
    expect(src).toContain('timer.unref?.()')
    expect(src).toContain('clearTimeout(timer)')
  })
})
