// Card 5d8612b6 (Cybersec MED): the UNAUTH /api/public-digest amplified 1 HTTP request into
// N synchronous tmux subprocess spawns on the Node event loop (~80ms blocking at N=15), so
// ~11 req/s stalled the whole dashboard that the fleet itself runs on. Fix: a short TTL cache
// over the agent-count scan. These tests pin the amplification down -- a cache-hit must not
// spawn, the TTL must actually expire, and the response SHAPE must be untouched (no new leak
// surface). isAgentRunning/listAgentNames are mocked, so no test touches real tmux.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const listAgentNamesMock = vi.fn<() => string[]>(() => ['a', 'b', 'c'])
const isAgentRunningMock = vi.fn<(n: string) => boolean>(() => true)

vi.mock('../web/agent-config.js', () => ({ listAgentNames: listAgentNamesMock }))
vi.mock('../web/agent-process.js', () => ({ isAgentRunning: isAgentRunningMock }))

const { buildPublicDigest } = await import('../web/routes/public-digest.js')

// The cache is module-level and `now` is injected, so each test uses its own time base far
// beyond any previous test's expiry. That keeps the tests independent without exporting a
// test-only reset hook into production code.
let timeBase = 1_000_000_000_000

beforeEach(() => {
  listAgentNamesMock.mockClear()
  isAgentRunningMock.mockClear()
  timeBase += 60 * 60 * 1000 // +1h per test, well past the 10s TTL
})

describe('public-digest agent-count TTL cache (card 5d8612b6)', () => {
  it('two calls inside the TTL window trigger EXACTLY ONE agent scan', () => {
    buildPublicDigest(timeBase)
    const scansAfterFirst = isAgentRunningMock.mock.calls.length
    expect(scansAfterFirst).toBeGreaterThan(0) // the first call really does scan

    buildPublicDigest(timeBase + 1000)
    buildPublicDigest(timeBase + 5000)
    buildPublicDigest(timeBase + 9999)

    // Three further requests, zero further spawns: the amplification is gone.
    expect(isAgentRunningMock.mock.calls.length).toBe(scansAfterFirst)
    expect(listAgentNamesMock).toHaveBeenCalledTimes(1)
  })

  it('recomputes after the TTL expires', () => {
    buildPublicDigest(timeBase)
    expect(listAgentNamesMock).toHaveBeenCalledTimes(1)

    buildPublicDigest(timeBase + 10_000) // exactly at expiry -> stale
    expect(listAgentNamesMock).toHaveBeenCalledTimes(2)

    buildPublicDigest(timeBase + 25_000)
    expect(listAgentNamesMock).toHaveBeenCalledTimes(3)
  })

  it('a cache HIT returns the same counts as the computing call', () => {
    const fresh = buildPublicDigest(timeBase)
    const hit = buildPublicDigest(timeBase + 500)
    expect(hit.agents).toEqual(fresh.agents)
  })

  it('checkedAt still reflects the CURRENT request, not the cached scan time', () => {
    buildPublicDigest(timeBase)
    const hit = buildPublicDigest(timeBase + 3000)
    // Only the expensive scan is cached; the timestamp must stay live or the digest
    // would look frozen to a monitor.
    expect(hit.checkedAt).toBe(timeBase + 3000)
  })

  it('a changed fleet state is picked up on the next recompute', () => {
    isAgentRunningMock.mockReturnValue(true)
    const before = buildPublicDigest(timeBase)
    expect(before.agents.running).toBe(4) // 3 mocked agents + main

    isAgentRunningMock.mockReturnValue(false)
    const stillCached = buildPublicDigest(timeBase + 1000)
    expect(stillCached.agents.running).toBe(4) // inside TTL: intentionally stale

    const afterTtl = buildPublicDigest(timeBase + 11_000)
    expect(afterTtl.agents.running).toBe(1) // only main
  })

  it('the response SHAPE is unchanged -- no new field, no new leak surface', () => {
    const d = buildPublicDigest(timeBase)
    expect(Object.keys(d).sort()).toEqual(['agents', 'checkedAt', 'name', 'ok', 'version'])
    expect(Object.keys(d.agents).sort()).toEqual(['running', 'total'])
    // No cache bookkeeping (expiresAt, cachedAt, ttl, stale) may leak into the payload.
    expect(JSON.stringify(d)).not.toMatch(/expiresAt|cachedAt|ttl|stale/i)
    // And still no topology markers.
    expect(JSON.stringify(d)).not.toMatch(/"roles?"|"path"|"token"|"agentId"|"reports|"userId"/i)
  })
})
