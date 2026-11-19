// Card b296b810 (Peti 14008, 2026-11-16): POST /api/kanban must never create a project-less
// card -- 411 such cards piled up between 2026-09-26 and 2026-11-15 before MikroB manually
// reclassified them by hand. Resolution order: (1) explicit project, (2) parent_id's project
// inherited, (3) a recognised title tag, (4) a speaking 400, never a silent NULL row. PUT must
// apply the same resolution when a caller tries to CLEAR project to empty.

import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { initDatabase, createKanbanCard, getKanbanCard, getChildCards } from '../db.js'
import { tryHandleKanban, resolveCardProject, NO_PROJECT_MESSAGE, INVALID_PROJECT_TYPE_MESSAGE } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeCtx(path: string, method: string, body?: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('resolveCardProject (pure helper)', () => {
  it('an explicit project always wins, over parent and title tag both', () => {
    expect(resolveCardProject('explicit', 'parent-project', '[mopsion] x')).toBe('explicit')
  })

  it('falls back to the parent project when no explicit project is given', () => {
    expect(resolveCardProject(null, 'parent-project', 'no tag here')).toBe('parent-project')
    expect(resolveCardProject(undefined, 'parent-project', null)).toBe('parent-project')
  })

  it('falls back to a title tag when there is no explicit project and no parent project', () => {
    expect(resolveCardProject(null, null, '[mopsion] New feature')).toBe('mopsion')
    expect(resolveCardProject(null, null, '[cleancore] New feature')).toBe('mopsion')
    expect(resolveCardProject(null, null, '[MikroB][INFRA] Something')).toBe('MikroB')
    expect(resolveCardProject(null, null, '[marveen] Something')).toBe('MikroB')
  })

  it('tag matching is case-insensitive and scans every bracket, not just the first', () => {
    expect(resolveCardProject(null, null, '[LOW][mopsion] tagged second')).toBe('mopsion')
    expect(resolveCardProject(null, null, '[MOPSION] upper-case tag')).toBe('mopsion')
  })

  it('returns null when nothing resolves -- explicit empty, no parent, no recognised tag', () => {
    expect(resolveCardProject(null, null, 'Ordinary title with no tag')).toBeNull()
    expect(resolveCardProject('', null, null)).toBeNull()
  })
})

describe('POST /api/kanban -- project is required', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('BLOCKING: no project, no parent_id, no recognised title tag -> 400, no card created', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { title: 'Ordinary card, no tag' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe(NO_PROJECT_MESSAGE)
  })

  it('an explicit project is used as-is', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: 'p1', title: 'x', project: 'mopsion' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('p1')?.project).toBe('mopsion')
  })

  it('a parent_id with a project is inherited when no explicit project is given', async () => {
    createKanbanCard({ id: 'parent-x', title: 'Parent', project: 'mopsion' })
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: 'child-x', title: 'Child', parent_id: 'parent-x' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('child-x')?.project).toBe('mopsion')
  })

  it('a [mopsion] title tag derives the project when there is no explicit project or parent', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: 'tag1', title: '[mopsion][FEATURE] New thing' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('tag1')?.project).toBe('mopsion')
  })

  it('a [MikroB] title tag derives the MikroB project', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: 'tag2', title: '[MikroB][INFRA] Something' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('tag2')?.project).toBe('MikroB')
  })

  it('MUTATION PIN: a parent_id WITHOUT its own project does not fabricate one -- falls through to the tag/400 path', async () => {
    createKanbanCard({ id: 'parentless-parent', title: 'Parent with no project' })
    const { ctx: ctx1, out: out1 } = fakeCtx('/api/kanban', 'POST', { id: 'child-y', title: 'No tag here', parent_id: 'parentless-parent' })
    expect(await tryHandleKanban(ctx1)).toBe(true)
    expect(out1.status).toBe(400)

    const { ctx: ctx2, out: out2 } = fakeCtx('/api/kanban', 'POST', { id: 'child-z', title: '[mopsion] has a tag', parent_id: 'parentless-parent' })
    expect(await tryHandleKanban(ctx2)).toBe(true)
    expect(out2.status).toBe(200)
    expect(getKanbanCard('child-z')?.project).toBe('mopsion')
  })
})

describe('PUT /api/kanban/:id -- clearing project falls back the same way', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('BLOCKING: clearing project to empty with no parent and no title tag -> 400, card unchanged', async () => {
    createKanbanCard({ id: 'clr1', title: 'Ordinary title', project: 'mopsion' })
    const { ctx, out } = fakeCtx('/api/kanban/clr1', 'PUT', { project: '' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe(NO_PROJECT_MESSAGE)
    expect(getKanbanCard('clr1')?.project).toBe('mopsion')
  })

  it('clearing project falls back to the (existing) parent_id\'s project', async () => {
    createKanbanCard({ id: 'clr-parent', title: 'Parent', project: 'MikroB' })
    createKanbanCard({ id: 'clr2', title: 'Child', project: 'mopsion', parent_id: 'clr-parent' })
    const { ctx, out } = fakeCtx('/api/kanban/clr2', 'PUT', { project: null })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('clr2')?.project).toBe('MikroB')
  })

  it('clearing project falls back to a title tag when the (new) title carries one', async () => {
    createKanbanCard({ id: 'clr3', title: 'Old title', project: 'mopsion' })
    const { ctx, out } = fakeCtx('/api/kanban/clr3', 'PUT', { project: null, title: '[MikroB] renamed' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('clr3')?.project).toBe('MikroB')
  })

  it('MUTATION PIN: a PUT that never mentions project at all leaves the existing value untouched', async () => {
    createKanbanCard({ id: 'untouched1', title: 'Old title', project: 'mopsion' })
    const { ctx, out } = fakeCtx('/api/kanban/untouched1', 'PUT', { title: 'New title' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('untouched1')?.project).toBe('mopsion')
  })

  // Cybersec2 NO-GO (comment 32437, F1 MEDIUM): normalizeProjectName only looks at STRING
  // values, so a non-string/non-null `project` passed the old guard untouched and
  // better-sqlite3 silently bound a one-element array as its element -- {"project":[""]} stored
  // an empty-string project with a 200, the exact blank-project class this card closes for a
  // plain string.
  it.each([
    ['[""]', ['']],
    ['[null]', [null]],
    ['123 (a number)', 123],
    ['true (a boolean)', true],
    ['{} (an object)', {}],
  ])('BLOCKING: a non-string, non-null project (%s) is rejected 400, card unchanged', async (_label, badProject) => {
    createKanbanCard({ id: 'badtype1', title: 'Ordinary title', project: 'mopsion' })
    const { ctx, out } = fakeCtx('/api/kanban/badtype1', 'PUT', { project: badProject })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe(INVALID_PROJECT_TYPE_MESSAGE)
    expect(getKanbanCard('badtype1')?.project).toBe('mopsion')
  })

  it('BLOCKING: an array project is rejected even when the title carries a recognised tag (the tag is never consulted)', async () => {
    createKanbanCard({ id: 'badtype2', title: 'Ordinary title', project: 'mopsion' })
    const { ctx, out } = fakeCtx('/api/kanban/badtype2', 'PUT', { project: [''], title: '[mopsion] t' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(getKanbanCard('badtype2')?.project).toBe('mopsion')
  })
})

describe('POST /api/kanban/:id/breakdown/accept -- the other card-creation path', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('BLOCKING: a parent with no project and a subtask title with no tag -> whole batch refused, no card created', async () => {
    createKanbanCard({ id: 'bd-parent-1', title: 'Parentless parent' })
    const { ctx, out } = fakeCtx('/api/kanban/bd-parent-1/breakdown/accept', 'POST', {
      subtasks: [{ title: 'Ordinary subtask', description: 'd', assignee: null, priority: 'normal' }],
    })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe(NO_PROJECT_MESSAGE)
    expect(getChildCards('bd-parent-1')).toHaveLength(0)
  })

  it('inherits the project from a parent that has one', async () => {
    createKanbanCard({ id: 'bd-parent-2', title: 'Parent', project: 'mopsion' })
    const { ctx, out } = fakeCtx('/api/kanban/bd-parent-2/breakdown/accept', 'POST', {
      subtasks: [{ title: 'Ordinary subtask', description: 'd', assignee: null, priority: 'normal' }],
    })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    const [child] = getChildCards('bd-parent-2')
    expect(child.project).toBe('mopsion')
  })

  it('a project-less parent still works when the subtask title itself carries a recognised tag', async () => {
    createKanbanCard({ id: 'bd-parent-3', title: 'Parentless parent' })
    const { ctx, out } = fakeCtx('/api/kanban/bd-parent-3/breakdown/accept', 'POST', {
      subtasks: [{ title: '[MikroB] tagged subtask', description: 'd', assignee: null, priority: 'normal' }],
    })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    const [child] = getChildCards('bd-parent-3')
    expect(child.project).toBe('MikroB')
  })
})
