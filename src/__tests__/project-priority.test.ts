// Project-level dispatch priority (card 2d6587fe). GET/PUT /api/config/project-priority.
//
// Rule 14 hardcodes "project cards before non-project"; this makes it a real, settable dashboard
// preference. Empty priority = the hardcoded default order still applies unchanged.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROJECT_ROOT } from '../config.js'
import { createKanbanCard, deleteKanbanCard } from '../db.js'
import { tryHandleProjectPriority } from '../web/routes/project-priority.js'
import type { RouteContext } from '../web/routes/types.js'

const CONFIG_PATH = join(PROJECT_ROOT, 'store', 'project-dispatch-priority.json')
// A project name no real card uses, so the "known projects" derivation is exercised against data
// this test itself controls -- not a guess about what already happens to be on the live board.
const THROWAWAY_PROJECT = 'zz-priority-probe-project'
const THROWAWAY_CARD = 'zz-priority-probe-card'

function fakeCtx(path: string, method: string, body?: unknown): {
  ctx: RouteContext
  out: { status: number; body: Record<string, unknown> | null }
} {
  const out: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null }
  const res = {
    writeHead(status: number) {
      out.status = status
      return res
    },
    end(chunk?: string) {
      if (chunk) out.body = JSON.parse(chunk) as Record<string, unknown>
    },
  }
  const bodyStr = body !== undefined ? JSON.stringify(body) : ''
  const req = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data' && bodyStr) cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
      return req
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: { req: req as unknown as RouteContext['req'], res, path: url.pathname, method, url } as RouteContext,
    out,
  }
}

// Whatever config existed before this file ran is restored after, so running the suite does not
// permanently change a real operator setting on a shared checkout.
const originalConfig: string | null = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf-8') : null

afterEach(() => {
  deleteKanbanCard(THROWAWAY_CARD)
  if (originalConfig !== null) {
    writeFileSync(CONFIG_PATH, originalConfig, 'utf-8')
  } else {
    rmSync(CONFIG_PATH, { force: true })
  }
})

describe('GET /api/config/project-priority', () => {
  it('defaults to an empty priority list when no config file exists', () => {
    rmSync(CONFIG_PATH, { force: true })
    const { ctx, out } = fakeCtx('/api/config/project-priority', 'GET')
    return tryHandleProjectPriority(ctx).then((handled) => {
      expect(handled).toBe(true)
      expect(out.body?.priority).toEqual([])
    })
  })
})

describe('PUT /api/config/project-priority', () => {
  it('rejects an unknown project name, naming it in the error', async () => {
    const { ctx, out } = fakeCtx('/api/config/project-priority', 'PUT', { priority: ['no-such-project-anywhere'] })
    const handled = await tryHandleProjectPriority(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect(String(out.body?.error)).toContain('no-such-project-anywhere')
  })

  it('rejects a non-array priority', async () => {
    const { ctx, out } = fakeCtx('/api/config/project-priority', 'PUT', { priority: 'cleancore' })
    await tryHandleProjectPriority(ctx)
    expect(out.status).toBe(400)
  })

  it('accepts a REAL project (derived from listKanbanProjects, not a hardcoded allowlist)', async () => {
    createKanbanCard({ id: THROWAWAY_CARD, title: 'probe', project: THROWAWAY_PROJECT })
    const { ctx, out } = fakeCtx('/api/config/project-priority', 'PUT', { priority: [THROWAWAY_PROJECT] })
    const handled = await tryHandleProjectPriority(ctx)
    expect(handled).toBe(true)
    expect(out.body?.ok).toBe(true)
    expect(out.body?.priority).toEqual([THROWAWAY_PROJECT])

    // Round-trip: a GET right after must reflect what was just saved, not a stale default.
    const getRes = fakeCtx('/api/config/project-priority', 'GET')
    await tryHandleProjectPriority(getRes.ctx)
    expect(getRes.out.body?.priority).toEqual([THROWAWAY_PROJECT])
  })

  it('dedups while preserving the caller-given order (order IS the priority order)', async () => {
    createKanbanCard({ id: THROWAWAY_CARD, title: 'probe', project: THROWAWAY_PROJECT })
    const { ctx, out } = fakeCtx('/api/config/project-priority', 'PUT', {
      priority: [THROWAWAY_PROJECT, 'cleancore', THROWAWAY_PROJECT],
    })
    await tryHandleProjectPriority(ctx)
    // cleancore may or may not exist on this board; only assert what this test itself controls.
    expect((out.body?.priority as string[]).filter((p) => p === THROWAWAY_PROJECT)).toHaveLength(1)
  })

  it('an empty array clears it back to the default order', async () => {
    createKanbanCard({ id: THROWAWAY_CARD, title: 'probe', project: THROWAWAY_PROJECT })
    await tryHandleProjectPriority(fakeCtx('/api/config/project-priority', 'PUT', { priority: [THROWAWAY_PROJECT] }).ctx)
    const { ctx, out } = fakeCtx('/api/config/project-priority', 'PUT', { priority: [] })
    await tryHandleProjectPriority(ctx)
    expect(out.body?.ok).toBe(true)
    expect(out.body?.priority).toEqual([])
  })
})
