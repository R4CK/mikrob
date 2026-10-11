// Card e25a549a (Peti, Telegram 10943, 2026-10-11): "A neveden miert van kartya? Neked kiosztani
// kell a feladatokat, nem megoldani." assignee="mikrob" must be refused at the write boundary --
// create (POST /api/kanban) and update (PUT /api/kanban/:id) -- not just discouraged in prose.
//
// Measured before this fix: neither route checked the `assignee` value at all, so a card could be
// opened or reassigned onto MikroB's own name with no pushback, and it would then sit unworked
// (MikroB does not self-advance its own cards, rule 11) and invisible to the fleet dispatch sweep.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { initDatabase, getKanbanCard, createKanbanCard, createIdea, updateKanbanCard } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import { tryHandleIdeas } from '../web/routes/ideas.js'
import type { RouteContext } from '../web/routes/types.js'
import { isForbiddenAssignee, isInvalidAssigneeShape } from '../web/kanban-assignee-guard.js'

function fakeCtx(path: string, method: string, body?: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

beforeEach(() => { initDatabase(':memory:') })

describe('isForbiddenAssignee (pure check)', () => {
  it('matches "mikrob" case-insensitively and trims whitespace', () => {
    expect(isForbiddenAssignee('mikrob')).toBe(true)
    expect(isForbiddenAssignee('MikroB')).toBe(true)
    expect(isForbiddenAssignee('  mikrob  ')).toBe(true)
  })

  it('does not match a real role agent, null, or non-mikrob substrings', () => {
    expect(isForbiddenAssignee('backend2')).toBe(false)
    expect(isForbiddenAssignee(null)).toBe(false)
    expect(isForbiddenAssignee(undefined)).toBe(false)
    expect(isForbiddenAssignee('mikrob-infra')).toBe(false)
    expect(isForbiddenAssignee('not-mikrob')).toBe(false)
  })

  it('a non-string value is never "forbidden" here (that is isInvalidAssigneeShape\'s job)', () => {
    expect(isForbiddenAssignee(['mikrob'])).toBe(false)
    expect(isForbiddenAssignee({ name: 'mikrob' })).toBe(false)
  })

  // WhiteHat F3 (NO-GO komment 15784, kartya e25a549a): zero-width/formatting karakterek es
  // Cirill/Gorog hasonmasok mertek szerint atmentek a sima trim+lowercase osszevetesen.
  it('catches zero-width / soft-hyphen padded and full-width variants (WhiteHat F3)', () => {
    expect(isForbiddenAssignee('mi​krob')).toBe(true) // ZWSP
    expect(isForbiddenAssignee('mikro­b')).toBe(true) // soft hyphen
    expect(isForbiddenAssignee('﻿mikrob')).toBe(true) // BOM
    expect(isForbiddenAssignee('ｍｉｋｒｏｂ')).toBe(true) // full-width "mikrob"
  })

  it('catches Cyrillic/Greek look-alike letters (WhiteHat F3)', () => {
    expect(isForbiddenAssignee('mіkrоb')).toBe(true) // Cyrillic і (U+0456) + о (U+043E) -- mіkrоb visually
    expect(isForbiddenAssignee('мikrob')).toBe(true) // Cyrillic м (U+043C) in place of m
  })

  it('does not fold an unrelated real agent name into a false positive', () => {
    expect(isForbiddenAssignee('bаckend2')).toBe(false) // Cyrillic а folded to "a" -> "backend2", still not mikrob
  })
})

describe('isInvalidAssigneeShape (pure check, WhiteHat F1)', () => {
  it('rejects array, object, number, boolean', () => {
    expect(isInvalidAssigneeShape(['mikrob'])).toBe(true)
    expect(isInvalidAssigneeShape({ name: 'mikrob' })).toBe(true)
    expect(isInvalidAssigneeShape(42)).toBe(true)
    expect(isInvalidAssigneeShape(true)).toBe(true)
  })

  it('accepts string, null, undefined', () => {
    expect(isInvalidAssigneeShape('backend2')).toBe(false)
    expect(isInvalidAssigneeShape(null)).toBe(false)
    expect(isInvalidAssigneeShape(undefined)).toBe(false)
  })
})

describe('createKanbanCard / updateKanbanCard structural backstop (WhiteHat F1/F2, kartya e25a549a)', () => {
  // Measured: better-sqlite3 silently unwraps a one-element array bind parameter to its scalar,
  // so assignee: ['mikrob'] reached the DB as the literal string "mikrob" through the two original
  // route-handlers (typeof check skipped it) -- confirmed directly against better-sqlite3 before
  // this fix (INSERT ... VALUES (?, ?) .run('x', ['mikrob']) -> row { id: 'x', assignee: 'mikrob' }).
  it('createKanbanCard throws on a single-element array assignee (F1)', () => {
    expect(() => createKanbanCard({ id: 'arr1', title: 'x', assignee: ['mikrob'] as unknown as string }))
      .toThrow(/csak szoveg/)
    expect(getKanbanCard('arr1')).toBeFalsy()
  })

  it('createKanbanCard throws on assignee="mikrob" directly (F2: the shared write path, not just the two routes)', () => {
    expect(() => createKanbanCard({ id: 'direct1', title: 'x', assignee: 'mikrob' })).toThrow(/mikrob/i)
    expect(getKanbanCard('direct1')).toBeFalsy()
  })

  it('updateKanbanCard throws on assignee="mikrob" and leaves the row unchanged', () => {
    createKanbanCard({ id: 'u1', title: 'x', assignee: 'backend2' })
    expect(() => updateKanbanCard('u1', { assignee: 'mikrob' })).toThrow(/mikrob/i)
    expect(getKanbanCard('u1')?.assignee).toBe('backend2')
  })
})

describe('POST /api/kanban/:id/breakdown/accept bypasses the route guard without the backstop (F2)', () => {
  beforeEach(() => {
    createKanbanCard({ id: 'parent1', title: 'parent', status: 'planned', assignee: 'backend2' })
  })

  it('refuses a subtask with assignee="mikrob" (QA\'s own live repro) with 400, no card created', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/parent1/breakdown/accept', 'POST', {
      subtasks: [{ title: 'sub', description: 'd', assignee: 'mikrob', priority: 'normal' }],
    })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/mikrob/i)
  })

  it('a real agent subtask still works normally (control)', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/parent1/breakdown/accept', 'POST', {
      subtasks: [{ title: 'sub', description: 'd', assignee: 'backend3', priority: 'normal' }],
    })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard(out.body.created[0])?.assignee).toBe('backend3')
  })
})

describe('idea promotion no longer hardcodes assignee=BOT_NAME (MikroB) and the breakdown path is covered', () => {
  beforeEach(() => {
    createIdea({ id: 'idea1', title: 'Idea', description: 'd', category: 'infra', scope: 'munka', status: 'new', source: 'test', kanban_id: null, impact: null, effort: null })
  })

  it('POST /api/ideas/:id/promote creates the parent card with no assignee, not BOT_NAME', async () => {
    const { ctx, out } = fakeCtx('/api/ideas/idea1/promote', 'POST', { phase: 'plan' })
    expect(await tryHandleIdeas(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard(out.body.kanban_id)?.assignee).toBeFalsy()
  })

  it('POST /api/ideas/:id/promote-breakdown refuses a child subtask with assignee="mikrob" with 400', async () => {
    const { ctx, out } = fakeCtx('/api/ideas/idea1/promote-breakdown', 'POST', {
      subtasks: [{ title: 'sub', assignee: 'mikrob', priority: 'normal' }],
    })
    expect(await tryHandleIdeas(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/mikrob/i)
  })

  it('POST /api/ideas/:id/promote-breakdown with no subtask assignee leaves the parent unassigned, not BOT_NAME (control)', async () => {
    const { ctx, out } = fakeCtx('/api/ideas/idea1/promote-breakdown', 'POST', {
      subtasks: [{ title: 'sub', priority: 'normal' }],
    })
    expect(await tryHandleIdeas(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard(out.body.parent_id)?.assignee).toBeFalsy()
  })
})

describe('POST /api/kanban refuses assignee="mikrob"', () => {
  it('is refused with 400, and no card is created', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: 'blocked01', title: 'x', status: 'planned', assignee: 'mikrob' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/mikrob/i)
    expect(getKanbanCard('blocked01')).toBeFalsy()
  })

  it('a case/whitespace variant is refused the same way', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: 'blocked02', title: 'x', status: 'planned', assignee: ' MikroB ' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(getKanbanCard('blocked02')).toBeFalsy()
  })

  it('a real role agent still creates the card normally (control)', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: 'ok01', title: 'x', status: 'planned', assignee: 'backend2' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('ok01')?.assignee).toBe('backend2')
  })

  it('no assignee at all still creates the card normally (control)', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: 'ok02', title: 'x', status: 'planned' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(getKanbanCard('ok02')).toBeTruthy()
    void out
  })
})

describe('PUT /api/kanban/:id refuses assignee="mikrob"', () => {
  beforeEach(() => {
    createKanbanCard({ id: 'c1', title: 'existing', status: 'planned', assignee: 'backend2' })
  })

  it('is refused with 400, and the existing assignee is unchanged', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/c1', 'PUT', { assignee: 'mikrob' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/mikrob/i)
    expect(getKanbanCard('c1')?.assignee).toBe('backend2')
  })

  it('force:true does NOT bypass the block -- there is no legitimate override for this value', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/c1', 'PUT', { assignee: 'mikrob', force: true, actor: 'mikrob' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(getKanbanCard('c1')?.assignee).toBe('backend2')
  })

  it('reassigning to a different real agent still works normally (control)', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/c1', 'PUT', { assignee: 'backend3' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(getKanbanCard('c1')?.assignee).toBe('backend3')
    void out
  })

  it('an update that does not touch assignee at all is unaffected (control)', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/c1', 'PUT', { title: 'renamed' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(getKanbanCard('c1')?.title).toBe('renamed')
    expect(getKanbanCard('c1')?.assignee).toBe('backend2')
    void out
  })
})
