// QA FAIL + Cybered NO-GO (card 82f05633, comments 11481/11486): the first round of tests for
// this card exercised only the two pure functions (cardsInSubject, findOpenUpstreamSyncCards) in
// isolation -- NOT ONE test called the actual HTTP route handler (tryHandleUpdates), so nothing
// proved that POST /api/updates/apply really returns 409 for an open UPSTREAM-SYNC card, that
// spawnUpdateScript is really NOT invoked when it does, or that a check failure really blocks
// the pull instead of silently letting it through. Cybersec's own mutation test (flipping the
// 409 branch to `if (false && ...)`) left the then-existing 37 tests fully green -- the security
// gate's actual wiring had zero coverage. This file closes that gap with real calls to
// tryHandleUpdates, following the established fakeCtx pattern from cli-update-offer.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

const h = vi.hoisted(() => ({
  // Keyed by the argv array joined with a space, so a test can target one specific git
  // invocation without having to replicate every other call's exact shape.
  execResults: new Map<string, string>(),
  execThrows: new Set<string>(),
  spawnCalls: [] as Array<{ file: string; args: string[] }>,
  kanbanCard: undefined as { title: string; status: string } | undefined,
}))

vi.mock('node:child_process', async (orig) => ({
  ...((await orig()) as object),
  execFileSync: vi.fn((file: string, args: string[] = []) => {
    const key = args.join(' ')
    for (const throwKey of h.execThrows) {
      if (key.includes(throwKey)) throw new Error(`mocked failure for: ${key}`)
    }
    for (const [matchKey, result] of h.execResults) {
      if (key.includes(matchKey)) return result
    }
    return '' // safe default: empty stdout (e.g. clean porcelain status)
  }),
  spawn: vi.fn((file: string, args: string[] = []) => {
    h.spawnCalls.push({ file, args })
    const ee = new EventEmitter() as EventEmitter & { pid: number; unref: () => void }
    ee.pid = 12345
    ee.unref = () => {}
    return ee
  }),
}))

vi.mock('../db.js', () => ({
  getKanbanCard: (id: string) => (h.kanbanCard && id ? h.kanbanCard : undefined),
}))

// db.js is mocked above (getKanbanCard only); updates.ts only needs that one export from it.
const { tryHandleUpdates } = await import('../web/routes/updates.js')
const { PROJECT_ROOT } = await import('../config.js')

const PIDFILE = join(PROJECT_ROOT, 'store', 'update.pid')

function fakeCtx(path: string, method: string, body = '') {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() { /* noop */ },
  }
  const req = new EventEmitter() as any
  setTimeout(() => { if (body) req.emit('data', Buffer.from(body)); req.emit('end') }, 1)
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url } as unknown as RouteContext
  return { ctx, out }
}

async function callApply(body: Record<string, unknown> = {}) {
  const { ctx, out } = fakeCtx('/api/updates/apply', 'POST', JSON.stringify(body))
  await tryHandleUpdates(ctx)
  // give the setTimeout(1) in fakeCtx a tick to deliver the body before returning
  await new Promise((r) => setTimeout(r, 5))
  return out
}

beforeEach(() => {
  h.execResults.clear()
  h.execThrows.clear()
  h.spawnCalls.length = 0
  h.kanbanCard = undefined
  // The "everything is clean and fast-forwardable" baseline every test starts from.
  h.execResults.set('rev-parse --abbrev-ref HEAD', 'develop\n')
  h.execResults.set('rev-list --count', '0')
  h.execResults.set('status --porcelain', '')
  // ls-remote (originHasBranch) and fetch succeed with empty/ignored output by default.
})

afterEach(() => {
  if (existsSync(PIDFILE)) unlinkSync(PIDFILE) // the route's own lock file; this worktree is isolated, but clean up anyway
  vi.clearAllMocks()
})

describe('POST /api/updates/apply refuses an open UPSTREAM-SYNC card (card 82f05633, handler-level)', () => {
  it('an open UPSTREAM-SYNC card in the pull range: 409, and spawn (update.sh) is NEVER invoked', async () => {
    h.execResults.set('log --format=%s', 'feat(agents): batch 4 (card ef6a8031)\n')
    h.kanbanCard = { title: '[MikroB][UPSTREAM-SYNC][HIGH] batch', status: 'waiting' }
    const out = await callApply()
    expect(out.status).toBe(409)
    expect(out.body.reason).toBe('open-upstream-sync-card')
    expect(out.body.openCardIds).toContain('ef6a8031')
    expect(h.spawnCalls.length).toBe(0)
  })

  it('a done UPSTREAM-SYNC card in the range: the pull proceeds, spawn IS invoked', async () => {
    h.execResults.set('log --format=%s', 'feat(agents): batch 3 (card ef6a8031)\n')
    h.kanbanCard = { title: '[MikroB][UPSTREAM-SYNC][HIGH] batch', status: 'done' }
    const out = await callApply()
    expect(out.status === 0 || out.status === 200).toBe(true)
    expect(h.spawnCalls.length).toBe(1)
    expect(h.spawnCalls[0]?.args.some((a) => a.includes('update.sh'))).toBe(true)
  })

  it('no card reference at all in the range: the pull proceeds normally, spawn IS invoked', async () => {
    h.execResults.set('log --format=%s', 'chore(fork-guard): re-acknowledge drift\n')
    const out = await callApply()
    expect(out.status === 0 || out.status === 200).toBe(true)
    expect(h.spawnCalls.length).toBe(1)
  })

  it('the fetch itself fails: FAIL-CLOSED -- 500, and spawn is NEVER invoked (not a silent "no open card")', async () => {
    h.execThrows.add('fetch origin')
    const out = await callApply()
    expect(out.status).toBe(500)
    expect(out.body.reason).toBe('open-upstream-sync-check-failed')
    expect(h.spawnCalls.length).toBe(0)
  })

  it('the log call itself fails: FAIL-CLOSED -- 500, and spawn is NEVER invoked', async () => {
    h.execThrows.add('log --format=%s')
    const out = await callApply()
    expect(out.status).toBe(500)
    expect(out.body.reason).toBe('open-upstream-sync-check-failed')
    expect(h.spawnCalls.length).toBe(0)
  })

  it('TOCTOU regression guard: the check fetches origin/<branch> BEFORE computing the range, not the stale @{u}', async () => {
    // If the check ever regresses to reading `HEAD..@{u}` without a fresh fetch first, this
    // would pass by accident (nothing asserts the fetch happened) -- so assert the fetch call
    // itself occurred, not just the final verdict.
    h.execResults.set('log --format=%s', 'chore: noop\n')
    await callApply()
    const execFileSync = (await import('node:child_process')).execFileSync as unknown as ReturnType<typeof vi.fn>
    const fetchCalls = execFileSync.mock.calls.filter((call: unknown[]) => (call[1] as string[] | undefined)?.includes('fetch'))
    expect(fetchCalls.length).toBeGreaterThan(0)
    expect(fetchCalls[0]?.[1]).toEqual(['fetch', 'origin', 'develop'])
  })
})
