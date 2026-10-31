// Card 64f56f97 requirement 1: fireCardBuildRoute must shell out to card-build-route.sh with
// CARD_BUILD_ROUTE_DISPATCHER=api, and must never throw or reject regardless of what the
// script does -- the contract the kanban route handlers rely on to call it fire-and-forget.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

interface FakeChild extends EventEmitter {
  pid: number
  stdout: EventEmitter
}

function makeFakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = pid
  child.stdout = new EventEmitter()
  return child
}

export let spawns: Array<{ args: string[]; env: Record<string, string>; child: FakeChild; finish: (code: number) => void }> = []
// Card 97f9ca58: spawns no longer resolve on their own microtask -- the cap means a queued call's
// spawn invocation does not even happen until an earlier one's 'exit' event fires. Tests that
// need to see the queue drain call `resolveSpawn(i)` explicitly instead of relying on a delay.
let nextPid = 1000
let nextStdout = ''
vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: readonly string[], opts: { env?: Record<string, string> }) => {
    const child = makeFakeChild(nextPid++)
    spawns.push({
      args: [cmd, ...args],
      env: opts.env ?? {},
      child,
      finish: (code: number) => {
        if (nextStdout) child.stdout.emit('data', Buffer.from(nextStdout))
        child.emit('exit', code, null)
      },
    })
    return child
  },
}))

function resolveSpawn(i: number, code = 0): void {
  spawns[i]!.finish(code)
}

let warnLogs: Array<Record<string, unknown>> = []
let infoLogs: Array<Record<string, unknown>> = []
vi.mock('../logger.js', () => ({
  logger: {
    warn: (o: Record<string, unknown>) => warnLogs.push(o),
    info: (o: Record<string, unknown>) => infoLogs.push(o),
  },
}))

const { fireCardBuildRoute, __resetRouteDispatchStateForTests } = await import('../web/kanban-route-dispatch.js')

beforeEach(() => {
  nextStdout = ''
  spawns = []
  nextPid = 1000
  warnLogs = []
  infoLogs = []
  __resetRouteDispatchStateForTests()
})

describe('fireCardBuildRoute', () => {
  it('invokes card-build-route.sh with the card id and CARD_BUILD_ROUTE_DISPATCHER=api', () => {
    fireCardBuildRoute('64f56f97')
    expect(spawns).toHaveLength(1)
    expect(spawns[0]!.args.some((a) => a.includes('card-build-route.sh'))).toBe(true)
    expect(spawns[0]!.args).toContain('64f56f97')
    expect(spawns[0]!.env.CARD_BUILD_ROUTE_DISPATCHER).toBe('api')
  })

  it('logs the verdict on success, never throws', () => {
    nextStdout = 'LOCAL\n'
    expect(() => fireCardBuildRoute('abc123')).not.toThrow()
    resolveSpawn(0, 0)
    expect(infoLogs[0]).toMatchObject({ cardId: 'abc123', verdict: 'LOCAL' })
    expect(warnLogs).toHaveLength(0)
  })

  it('logs a warning and never throws on a script failure (card move must still succeed)', () => {
    expect(() => fireCardBuildRoute('def456')).not.toThrow()
    resolveSpawn(0, 1)
    expect(warnLogs[0]).toMatchObject({ cardId: 'def456' })
  })

  it('logs a warning on a spawn-level error event, never throws', () => {
    expect(() => fireCardBuildRoute('ghi789')).not.toThrow()
    spawns[0]!.child.emit('error', new Error('ENOENT'))
    expect(warnLogs[0]).toMatchObject({ cardId: 'ghi789' })
  })
})

// Card 97f9ca58, WhiteHat GO 26845 F1: no cap/dedupe meant 120 back-to-back transitions ->
// +709 OS processes (stubbed lower bound), and PUT in_progress->planned->in_progress re-arms
// the same card. These pin the fix at the fireCardBuildRoute level (process-count evidence
// against the real script lives in the REVIEW, not here -- this proves the SHAPE of the fix).
describe('fireCardBuildRoute: cap, dedupe, queue (card 97f9ca58)', () => {
  it('re-arming the same card while its run is still in flight spawns it only once -- RED without the in-flight Set', () => {
    fireCardBuildRoute('same-card')
    fireCardBuildRoute('same-card')
    fireCardBuildRoute('same-card')
    expect(spawns).toHaveLength(1)
    expect(warnLogs.some((w) => w['cardId'] === 'same-card')).toBe(true)
  })

  it('re-arming the same card AFTER its run finished spawns it again (not a permanent dedupe)', () => {
    fireCardBuildRoute('same-card')
    resolveSpawn(0)
    fireCardBuildRoute('same-card')
    expect(spawns).toHaveLength(2)
  })

  it('caps concurrent children at 3 and queues the rest -- RED (4th spawns immediately) without the cap', () => {
    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) fireCardBuildRoute(id)
    // Only the first 3 distinct cards actually invoked spawn; c4/c5 are queued, not spawned.
    expect(spawns).toHaveLength(3)
    expect(spawns.map((s) => s.args[2])).toEqual(['c1', 'c2', 'c3'])
  })

  it('a queued card spawns once an earlier slot frees up', () => {
    for (const id of ['c1', 'c2', 'c3', 'c4']) fireCardBuildRoute(id)
    expect(spawns).toHaveLength(3)
    resolveSpawn(0) // c1 finishes -> frees a slot for the queued c4
    expect(spawns).toHaveLength(4)
    expect(spawns[3]!.args[2]).toBe('c4')
  })

  it('drops and logs a dispatch beyond the bounded queue instead of growing it unbounded', () => {
    for (let i = 0; i < 3 + 20; i++) fireCardBuildRoute(`q${i}`)
    // 3 running + 20 queued = 23 accepted; the 24th is dropped.
    fireCardBuildRoute('overflow')
    expect(spawns).toHaveLength(3)
    expect(warnLogs.some((w) => w['cardId'] === 'overflow' && String(w['queueLength'] ?? '') !== '')).toBe(true)
  })
})
