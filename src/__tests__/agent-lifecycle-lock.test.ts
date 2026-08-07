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
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lifecycleInFlightCount, withLifecycleLock } from '../web/agent-process.js'

const AGENT_PROCESS = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'agent-process.ts')
const src = readFileSync(AGENT_PROCESS, 'utf-8')

// The REAL lock from the module -- not a re-implementation. An earlier draft copied the shape here,
// and then deleting the module's coalescing left every test green: the copy was testing itself.
// Agent names are unique per test so the shared module-level map cannot couple them.
let seq = 0
const lock = <T>(suffix: string, op: () => Promise<T>): Promise<T> => withLifecycleLock(`t${seq}-${suffix}`, op)

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
