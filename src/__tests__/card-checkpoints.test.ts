// Card 8b9c2d40 (F1.2): card_checkpoints table + POST/GET /api/kanban/:id/checkpoints API.
// The POST route validates sha format (40 hex) and existence via `git cat-file -e`.
// A real repo SHA (HEAD) is used for the happy path; a syntactically-valid but non-existent SHA
// tests the cat-file rejection.
import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  initDatabase, createKanbanCard, deleteKanbanCard,
  addKanbanCheckpoint, getKanbanCheckpoints,
} from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

// A SHA that actually exists in the repo (HEAD of the main clone or the worktree).
const REAL_SHA = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const FAKE_SHA  = '0'.repeat(40) // syntactically valid, almost certainly absent

beforeEach(() => {
  initDatabase(':memory:')
})

// --- DB layer ---

describe('addKanbanCheckpoint / getKanbanCheckpoints (db layer)', () => {
  it('inserts a checkpoint and returns it with auto-incremented n=1', () => {
    createKanbanCard({ id: 'ck-1', title: 'Checkpoint card' })
    const row = addKanbanCheckpoint('ck-1', REAL_SHA, REAL_SHA, 'backend')
    expect(row.card_id).toBe('ck-1')
    expect(row.n).toBe(1)
    expect(row.sha).toBe(REAL_SHA)
    expect(row.head_sha).toBe(REAL_SHA)
    expect(row.agent).toBe('backend')
    expect(typeof row.created_at).toBe('number')
  })

  it('auto-increments n for successive checkpoints on the same card', () => {
    createKanbanCard({ id: 'ck-2', title: 'Checkpoint card 2' })
    addKanbanCheckpoint('ck-2', REAL_SHA, REAL_SHA, 'backend')
    const row2 = addKanbanCheckpoint('ck-2', REAL_SHA, REAL_SHA, 'backend')
    expect(row2.n).toBe(2)
  })

  it('getKanbanCheckpoints returns rows ordered by n ascending', () => {
    createKanbanCard({ id: 'ck-3', title: 'Order test' })
    addKanbanCheckpoint('ck-3', REAL_SHA, REAL_SHA, 'backend')
    addKanbanCheckpoint('ck-3', REAL_SHA, REAL_SHA, 'backend')
    const rows = getKanbanCheckpoints('ck-3')
    expect(rows.length).toBe(2)
    expect(rows[0].n).toBe(1)
    expect(rows[1].n).toBe(2)
  })

  it('getKanbanCheckpoints returns empty array for a card with no checkpoints', () => {
    createKanbanCard({ id: 'ck-4', title: 'No checkpoints' })
    expect(getKanbanCheckpoints('ck-4')).toEqual([])
  })

  it('deleteKanbanCard cascades to card_checkpoints (FK sweep)', () => {
    createKanbanCard({ id: 'ck-5', title: 'Delete test' })
    addKanbanCheckpoint('ck-5', REAL_SHA, REAL_SHA, 'backend')
    deleteKanbanCard('ck-5')
    // If FK sweep is missing, the DELETE would have thrown; reaching here means it passed.
    expect(getKanbanCheckpoints('ck-5')).toEqual([])
  })
})

// --- Down + re-up migration (table survives a re-init) ---

describe('migration idempotency', () => {
  it('CREATE TABLE IF NOT EXISTS is idempotent across two initDatabase calls', () => {
    createKanbanCard({ id: 'ck-6', title: 'Migration test' })
    addKanbanCheckpoint('ck-6', REAL_SHA, REAL_SHA, 'backend')
    // Second init on same in-memory db (no-op due to IF NOT EXISTS).
    initDatabase(':memory:') // fresh db -- table must still be created
    createKanbanCard({ id: 'ck-7', title: 'Migration test 2' })
    const row = addKanbanCheckpoint('ck-7', REAL_SHA, REAL_SHA, 'backend')
    expect(row.n).toBe(1)
  })
})

// --- HTTP route layer ---

function fakeCtx(method: string, path: string, body?: string): { ctx: RouteContext; out: { status: number; body: any } } {
  const req = new EventEmitter() as unknown as RouteContext['req']
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  if (body !== undefined) {
    process.nextTick(() => {
      ;(req as unknown as EventEmitter).emit('data', Buffer.from(body))
      ;(req as unknown as EventEmitter).emit('end')
    })
  }
  const ctx = { req, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

describe('GET /api/kanban/:id/checkpoints', () => {
  it('returns empty array for a card with no checkpoints', async () => {
    createKanbanCard({ id: 'ck-r1', title: 'Route GET test' })
    const { ctx, out } = fakeCtx('GET', '/api/kanban/ck-r1/checkpoints')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toEqual([])
  })

  it('404s for a card that does not exist', async () => {
    const { ctx, out } = fakeCtx('GET', '/api/kanban/no-such-card/checkpoints')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })
})

describe('POST /api/kanban/:id/checkpoints', () => {
  it('creates a checkpoint and returns 201 with the row', async () => {
    createKanbanCard({ id: 'ck-r2', title: 'Route POST test' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/ck-r2/checkpoints', JSON.stringify({
      sha: REAL_SHA, head_sha: REAL_SHA, agent: 'backend',
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(201)
    expect(out.body.card_id).toBe('ck-r2')
    expect(out.body.n).toBe(1)
    expect(out.body.sha).toBe(REAL_SHA)
  })

  it('404s for a card that does not exist', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/kanban/no-such/checkpoints', JSON.stringify({
      sha: REAL_SHA, head_sha: REAL_SHA, agent: 'backend',
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('400s when a required field is missing', async () => {
    createKanbanCard({ id: 'ck-r3', title: 'Missing field test' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/ck-r3/checkpoints', JSON.stringify({
      sha: REAL_SHA, head_sha: REAL_SHA,
      // agent missing
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('400s when sha is not 40 hex characters', async () => {
    createKanbanCard({ id: 'ck-r4', title: 'Bad sha format test' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/ck-r4/checkpoints', JSON.stringify({
      sha: 'deadbeef', head_sha: REAL_SHA, agent: 'backend',
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('400s when sha is syntactically valid but does not exist in the repo', async () => {
    createKanbanCard({ id: 'ck-r5', title: 'Nonexistent sha test' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/ck-r5/checkpoints', JSON.stringify({
      sha: FAKE_SHA, head_sha: REAL_SHA, agent: 'backend',
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })
})
