// Card 906c130f (227f4cc1 folytatása, vibe-kanban idea): line-level (diff) comments, distinct
// from the free-text card-level kanban_comments -- a comment bound to one file+line of one
// commit's diff (Gate-SHA-style), so a gate verdict or REVIEW can point at the exact spot in the
// diff it is about instead of only ever living as prose on the card. Scope is adatmodel+API only;
// rendering is the paired Fron Ted card's (c12abc67) job.
import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  initDatabase, createKanbanCard, deleteKanbanCard,
  addKanbanLineComment, getKanbanLineComments,
} from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

beforeEach(() => {
  initDatabase(':memory:')
})

describe('addKanbanLineComment / getKanbanLineComments (db layer)', () => {
  it('records a comment bound to card+sha+file+line, and returns it back', () => {
    createKanbanCard({ id: 'card-a', title: 'Reviewed card' })
    const row = addKanbanLineComment('card-a', 'abc1234', 'src/foo.ts', 42, 'qa', 'off-by-one here')
    expect(row.card_id).toBe('card-a')
    expect(row.sha).toBe('abc1234')
    expect(row.file).toBe('src/foo.ts')
    expect(row.line).toBe(42)
    expect(row.author).toBe('qa')
    expect(row.content).toBe('off-by-one here')
    expect(typeof row.id).toBe('number')
    expect(typeof row.created_at).toBe('number')
  })

  it('lists every comment for a card, oldest first, when sha is omitted', () => {
    createKanbanCard({ id: 'card-b', title: 'Multi-round card' })
    addKanbanLineComment('card-b', 'sha1', 'a.ts', 1, 'qa', 'first round finding')
    addKanbanLineComment('card-b', 'sha2', 'b.ts', 2, 'cybersec', 'second round finding')
    const all = getKanbanLineComments('card-b')
    expect(all).toHaveLength(2)
    expect(all.map((c) => c.sha)).toEqual(['sha1', 'sha2'])
  })

  it('narrows to one sha when a caller only wants that round\'s comments', () => {
    createKanbanCard({ id: 'card-c', title: 'Multi-round card' })
    addKanbanLineComment('card-c', 'sha1', 'a.ts', 1, 'qa', 'round 1')
    addKanbanLineComment('card-c', 'sha2', 'a.ts', 1, 'qa', 'round 2 (same file+line, different sha)')
    const round1 = getKanbanLineComments('card-c', 'sha1')
    expect(round1).toHaveLength(1)
    expect(round1[0].content).toBe('round 1')
  })

  it('never mixes line comments across cards', () => {
    createKanbanCard({ id: 'card-d', title: 'D' })
    createKanbanCard({ id: 'card-e', title: 'E' })
    addKanbanLineComment('card-d', 'sha1', 'a.ts', 1, 'qa', 'about D')
    addKanbanLineComment('card-e', 'sha1', 'a.ts', 1, 'qa', 'about E')
    expect(getKanbanLineComments('card-d').map((c) => c.content)).toEqual(['about D'])
    expect(getKanbanLineComments('card-e').map((c) => c.content)).toEqual(['about E'])
  })

  it('is deleted together with its card (same FK-safety contract as kanban_comments, card 906c130f follows kanban-delete-fk.test.ts)', () => {
    createKanbanCard({ id: 'card-f', title: 'To be deleted' })
    addKanbanLineComment('card-f', 'sha1', 'a.ts', 1, 'qa', 'will be orphaned if not cascaded')
    expect(deleteKanbanCard('card-f')).toBe(true)
    expect(getKanbanLineComments('card-f')).toHaveLength(0)
  })
})

// Minimal req/res doubles, same shape as kanban-get-by-id-route.test.ts / federation-inbox.test.ts:
// readBody consumes data/end events, json() uses writeHead/end.
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

describe('POST /api/kanban/:id/line-comments', () => {
  it('creates a line comment and returns it', async () => {
    createKanbanCard({ id: 'card-g', title: 'Route test card' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/card-g/line-comments', JSON.stringify({
      sha: 'deadbeef', file: 'src/x.ts', line: 7, author: 'cybersec', content: 'possible bypass here',
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.card_id).toBe('card-g')
    expect(out.body.sha).toBe('deadbeef')
    expect(out.body.file).toBe('src/x.ts')
    expect(out.body.line).toBe(7)
    expect(out.body.content).toBe('possible bypass here')
  })

  it('404s for a card that does not exist, instead of silently creating an orphaned comment', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/kanban/does-not-exist/line-comments', JSON.stringify({
      sha: 'deadbeef', file: 'src/x.ts', line: 7, author: 'cybersec', content: 'x',
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('400s when a required field is missing', async () => {
    createKanbanCard({ id: 'card-h', title: 'Route test card' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/card-h/line-comments', JSON.stringify({
      sha: 'deadbeef', file: 'src/x.ts', line: 7, author: 'cybersec',
      // content missing
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('400s on a non-positive-integer line number instead of persisting a nonsensical anchor', async () => {
    createKanbanCard({ id: 'card-i', title: 'Route test card' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/card-i/line-comments', JSON.stringify({
      sha: 'deadbeef', file: 'src/x.ts', line: 0, author: 'cybersec', content: 'x',
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })
})

describe('GET /api/kanban/:id/line-comments', () => {
  it('lists all comments for a card when sha is omitted', async () => {
    createKanbanCard({ id: 'card-j', title: 'Route test card' })
    addKanbanLineComment('card-j', 'sha1', 'a.ts', 1, 'qa', 'r1')
    addKanbanLineComment('card-j', 'sha2', 'a.ts', 1, 'qa', 'r2')
    const { ctx, out } = fakeCtx('GET', '/api/kanban/card-j/line-comments')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toHaveLength(2)
  })

  it('narrows to ?sha= when given', async () => {
    createKanbanCard({ id: 'card-k', title: 'Route test card' })
    addKanbanLineComment('card-k', 'sha1', 'a.ts', 1, 'qa', 'r1')
    addKanbanLineComment('card-k', 'sha2', 'a.ts', 1, 'qa', 'r2')
    const { ctx, out } = fakeCtx('GET', '/api/kanban/card-k/line-comments?sha=sha1')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toHaveLength(1)
    expect(out.body[0].content).toBe('r1')
  })

  it('returns an empty array, not a 404, for a card with no line comments yet', async () => {
    createKanbanCard({ id: 'card-l', title: 'Route test card' })
    const { ctx, out } = fakeCtx('GET', '/api/kanban/card-l/line-comments')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toEqual([])
  })
})
