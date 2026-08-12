import { describe, it, expect, vi } from 'vitest'
import { createRateLimiter, createRateLimitedFetcher } from '../http.js'

// A controllable fake clock: `now` is whatever the test sets it to, `sleep` just records the
// requested delay and resolves immediately (no real waiting in the test suite).
function fakeClock() {
  let current = 0
  const sleepCalls: number[] = []
  return {
    now: () => current,
    advance: (ms: number) => { current += ms },
    sleep: async (ms: number) => { sleepCalls.push(ms) },
    sleepCalls,
  }
}

describe('createRateLimiter', () => {
  it('does not sleep on the very first call', async () => {
    const clock = fakeClock()
    const wait = createRateLimiter(1000, clock)
    await wait()
    expect(clock.sleepCalls).toEqual([])
  })

  it('sleeps for the REMAINING time when called again before the interval has elapsed', async () => {
    const clock = fakeClock()
    const wait = createRateLimiter(1000, clock)
    await wait()
    clock.advance(300)
    await wait()
    expect(clock.sleepCalls).toEqual([700])
  })

  it('does not sleep when the interval has already fully elapsed', async () => {
    const clock = fakeClock()
    const wait = createRateLimiter(1000, clock)
    await wait()
    clock.advance(1500)
    await wait()
    expect(clock.sleepCalls).toEqual([])
  })

  it('sleeps again on a third call spaced too closely after the (slept) second call', async () => {
    const clock = fakeClock()
    const wait = createRateLimiter(1000, clock)
    await wait() // t=0, no sleep
    clock.advance(300)
    await wait() // t=300, sleeps 700 -> lastCallAt recorded as now() at call time = 300, not 1000
    clock.advance(100)
    await wait() // t=400, only 100ms since lastCallAt(300) -> must sleep 900
    expect(clock.sleepCalls).toEqual([700, 900])
  })
})

describe('createRateLimitedFetcher', () => {
  it('waits via the rate limiter BEFORE calling fetchImpl', async () => {
    const clock = fakeClock()
    const order: string[] = []
    const fetchImpl = vi.fn(async () => {
      order.push('fetch')
      return { status: 200, text: async () => 'ok' } as unknown as Response
    })
    const originalSleep = clock.sleep
    clock.sleep = async (ms: number) => { order.push('sleep'); await originalSleep(ms) }

    const fetchText = createRateLimitedFetcher({
      userAgent: 'IngatlanTracker/1.0 (personal use)',
      minIntervalMs: 1000,
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
    })
    await fetchText('https://example.com/a')
    clock.advance(100)
    await fetchText('https://example.com/b')

    expect(order).toEqual(['fetch', 'sleep', 'fetch'])
  })

  it('sends the configured User-Agent header', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, text: async () => 'body' }) as unknown as Response)
    const fetchText = createRateLimitedFetcher({
      userAgent: 'IngatlanTracker/1.0 (personal use)',
      minIntervalMs: 0,
      fetchImpl,
    })
    await fetchText('https://example.com/x')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.com/x',
      { headers: { 'User-Agent': 'IngatlanTracker/1.0 (personal use)' } },
    )
  })

  it('returns the response status and body text', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 404, text: async () => 'not found' }) as unknown as Response)
    const fetchText = createRateLimitedFetcher({ userAgent: 'UA', minIntervalMs: 0, fetchImpl })
    const result = await fetchText('https://example.com/missing')
    expect(result).toEqual({ status: 404, body: 'not found' })
  })
})
