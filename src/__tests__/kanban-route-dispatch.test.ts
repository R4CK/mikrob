// Card 64f56f97 requirement 1: fireCardBuildRoute must shell out to card-build-route.sh with
// CARD_BUILD_ROUTE_DISPATCHER=api, and must never throw or reject regardless of what the
// script does -- the contract the kanban route handlers rely on to call it fire-and-forget.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let stdout = ''
let shouldError: Error | null = null
export let spawns: Array<{ args: string[]; env: Record<string, string> }> = []
vi.mock('node:child_process', () => ({
  execFile: (
    cmd: string,
    args: readonly string[],
    opts: { env?: Record<string, string> },
    cb: (e: Error | null, out: string) => void,
  ) => {
    spawns.push({ args: [cmd, ...args], env: opts.env ?? {} })
    queueMicrotask(() => cb(shouldError, stdout))
  },
}))

let warnLogs: Array<Record<string, unknown>> = []
let infoLogs: Array<Record<string, unknown>> = []
vi.mock('../logger.js', () => ({
  logger: {
    warn: (o: Record<string, unknown>) => warnLogs.push(o),
    info: (o: Record<string, unknown>) => infoLogs.push(o),
  },
}))

const { fireCardBuildRoute } = await import('../web/kanban-route-dispatch.js')

beforeEach(() => {
  stdout = ''
  shouldError = null
  spawns = []
  warnLogs = []
  infoLogs = []
})

describe('fireCardBuildRoute', () => {
  it('invokes card-build-route.sh with the card id and CARD_BUILD_ROUTE_DISPATCHER=api', () => {
    stdout = 'ONLINE'
    fireCardBuildRoute('64f56f97')
    expect(spawns).toHaveLength(1)
    expect(spawns[0]!.args.some((a) => a.includes('card-build-route.sh'))).toBe(true)
    expect(spawns[0]!.args).toContain('64f56f97')
    expect(spawns[0]!.env.CARD_BUILD_ROUTE_DISPATCHER).toBe('api')
  })

  it('logs the verdict on success, never throws', () => {
    stdout = 'LOCAL\n'
    expect(() => fireCardBuildRoute('abc123')).not.toThrow()
    return new Promise((resolve) => queueMicrotask(() => {
      expect(infoLogs[0]).toMatchObject({ cardId: 'abc123', verdict: 'LOCAL' })
      expect(warnLogs).toHaveLength(0)
      resolve(undefined)
    }))
  })

  it('logs a warning and never throws on a script failure (card move must still succeed)', () => {
    shouldError = new Error('spawn failed')
    expect(() => fireCardBuildRoute('def456')).not.toThrow()
    return new Promise((resolve) => queueMicrotask(() => {
      expect(warnLogs[0]).toMatchObject({ cardId: 'def456' })
      resolve(undefined)
    }))
  })
})
