// Card 335fb927 (WhiteHat2 GO on 41d8e96f msg 10760, F1 MEDIUM): POST /api/kanban let the client
// choose the card id with NO format check, and the dispatch renderer (kanbanMoveInstructions)
// interpolated that id, unquoted, into 3 shell command blocks it hands to another agent to
// copy-paste. Measured PoC: id = `x$(echo pwned > marker)` ran its substitution in all 3 blocks
// (one sits inside a DOUBLE-quoted `python3 -c "..."` argument, where $(...) is expanded by the
// shell before python ever runs; the other two are bare, unquoted curl URL arguments).
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { initDatabase, getKanbanCard } from '../db.js'
import { tryHandleKanban, kanbanMoveInstructions } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'
import { isValidKanbanId, isInvalidKanbanIdShape } from '../web/kanban-id-guard.js'
import { MAIN_AGENT_ID } from '../config.js'

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

// The exact PoC string from the finding: a command-substitution payload shaped like a plausible
// id (starts with a letter, no spaces needed for $(...) to work).
const INJECTION_ID = 'x$(echo pwned > marker)'

describe('isValidKanbanId / isInvalidKanbanIdShape (pure checks)', () => {
  it('accepts letters, digits, underscore, hyphen, up to 64 chars', () => {
    expect(isValidKanbanId('abc123')).toBe(true)
    expect(isValidKanbanId('41d8e96f')).toBe(true)
    expect(isValidKanbanId('card_with-mixed_01')).toBe(true)
    expect(isValidKanbanId('a'.repeat(64))).toBe(true)
  })

  it('rejects the injection PoC and every shell-metacharacter shape', () => {
    expect(isValidKanbanId(INJECTION_ID)).toBe(false)
    expect(isValidKanbanId('a`echo x`')).toBe(false)
    expect(isValidKanbanId('a"b')).toBe(false)
    expect(isValidKanbanId("a'b")).toBe(false)
    expect(isValidKanbanId('a b')).toBe(false)
    expect(isValidKanbanId('a;b')).toBe(false)
    expect(isValidKanbanId('a|b')).toBe(false)
    expect(isValidKanbanId('a>b')).toBe(false)
  })

  it('rejects empty string, too-long string, and non-string shapes', () => {
    expect(isValidKanbanId('')).toBe(false)
    expect(isValidKanbanId('a'.repeat(65))).toBe(false)
    expect(isValidKanbanId(null)).toBe(false)
    expect(isValidKanbanId(undefined)).toBe(false)
    expect(isValidKanbanId(42)).toBe(false)
    expect(isValidKanbanId(['abc'])).toBe(false)
  })

  it('isInvalidKanbanIdShape: present-but-wrong-shape is true, absent/empty is false (mirrors isInvalidAssigneeShape)', () => {
    expect(isInvalidKanbanIdShape(INJECTION_ID)).toBe(true)
    expect(isInvalidKanbanIdShape(undefined)).toBe(false)
    expect(isInvalidKanbanIdShape(null)).toBe(false)
    expect(isInvalidKanbanIdShape('')).toBe(false)
    expect(isInvalidKanbanIdShape('abc123')).toBe(false)
  })
})

describe('POST /api/kanban refuses a non-conforming client-supplied id', () => {
  it('the injection PoC id is refused with 400, no card created', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: INJECTION_ID, title: 'x', status: 'planned' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(getKanbanCard(INJECTION_ID)).toBeFalsy()
  })

  it('a well-formed client-supplied id is still accepted (control)', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: 'my-card_01', title: 'x', status: 'planned' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('my-card_01')).toBeTruthy()
  })

  it('a non-conforming parent_id on create is refused with 400, no card created', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: 'okid1', title: 'x', status: 'planned', parent_id: INJECTION_ID })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(getKanbanCard('okid1')).toBeFalsy()
  })

  it('no id supplied at all still auto-generates one normally (control)', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { title: 'x', status: 'planned' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(typeof out.body.id).toBe('string')
  })
})

describe('PUT /api/kanban/:id refuses a non-conforming parent_id', () => {
  beforeEach(async () => {
    await tryHandleKanban(fakeCtx('/api/kanban', 'POST', { id: 'existing1', title: 'x', status: 'planned' }).ctx)
  })

  it('is refused with 400, parent_id unchanged', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/existing1', 'PUT', { parent_id: INJECTION_ID })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(getKanbanCard('existing1')?.parent_id ?? null).toBeFalsy()
  })

  it('clearing parent_id to null is unaffected (control)', async () => {
    await tryHandleKanban(fakeCtx('/api/kanban', 'POST', { id: 'parent-ok', title: 'p', status: 'planned' }).ctx)
    await tryHandleKanban(fakeCtx('/api/kanban/existing1', 'PUT', { parent_id: 'parent-ok' }).ctx)
    const { ctx, out } = fakeCtx('/api/kanban/existing1', 'PUT', { parent_id: null })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })
})

// WhiteHat2 F1 (card 335fb927, msg 10760): the renderer itself must fail-closed on a bad id, on
// BOTH branches it emits (sub-agent target and MAIN_AGENT_ID target -- the isMainAgent branch adds
// a 3rd command block, "told at a kartyat"). This is a SECOND, independent line of defense: it
// must hold even if the route-level checks above were ever bypassed or called from elsewhere.
describe('kanbanMoveInstructions: fail-closed renderer (both isMainAgent branches)', () => {
  it('sub-agent target: renders NO command when id is the injection PoC', () => {
    const out = kanbanMoveInstructions(INJECTION_ID, 'backend2')
    expect(out).not.toContain('curl')
    expect(out).not.toContain('python3')
    expect(out).toMatch(/FAIL-CLOSED/)
  })

  it('MAIN_AGENT_ID target: renders NO command when id is the injection PoC (covers the 3rd, isMainAgent-only block)', () => {
    const out = kanbanMoveInstructions(INJECTION_ID, MAIN_AGENT_ID)
    expect(out).not.toContain('curl')
    expect(out).not.toContain('python3')
    expect(out).toMatch(/FAIL-CLOSED/)
  })

  it('sub-agent target: a well-formed id still renders the normal 2 command blocks (control)', () => {
    const out = kanbanMoveInstructions('abc123', 'backend2')
    expect(out).toContain('/api/kanban/abc123/comments')
    expect(out).toContain('/api/kanban/abc123/move')
  })

  it('MAIN_AGENT_ID target: a well-formed id still renders all 3 command blocks, quoted (control)', () => {
    const out = kanbanMoveInstructions('abc123', MAIN_AGENT_ID)
    expect(out).toContain(`'http://`) // the quoted curl URL argument, present on every block now
    expect(out).toContain("-X PUT 'http")
    expect(out).toContain("-X POST 'http")
  })

  // M-style widening mutant: if the guard were weakened to allow a space (a common "just one more
  // char" mistake), the injection id above would still be rejected (it has no space) -- but a
  // SPACE-only payload must also be caught. Pin the boundary directly, not just the one PoC string.
  it('rejects an id containing a bare `$(` even without other metacharacters', () => {
    const out = kanbanMoveInstructions('ok$(x)', 'backend2')
    expect(out).not.toContain('curl')
    expect(out).toMatch(/FAIL-CLOSED/)
  })
})
