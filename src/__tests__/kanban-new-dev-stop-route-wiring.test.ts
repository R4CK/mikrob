// Card b73722e1 -- exercises newDevStopWouldBlock() -> isLinkedToInProgressCard() through the REAL
// route (tryHandleKanban), not just the pure predicate. Two reasons this file exists on top of
// kanban-new-dev-stop-linked-card.test.ts and weekly-hard-stop.test.ts:
//
// 1) QA2's PASS on an earlier version of this card (gate comment 19004) flagged, as a non-blocking
//    finding, that the actual wiring point -- does newDevStopWouldBlock() really compute and pass
//    linkedToInProgress through to isNewDevStartBlocked()? -- had ZERO regression coverage. QA2
//    proved this by mutating the real call site to a hardcoded `false` and running the whole
//    routes/kanban.js-importing test population (29 files, 316 tests): all green. The mutation was
//    judged fail-safe (reverting to the old, over-blocking behaviour, not opening a bypass), so it
//    was a finding, not a FAIL -- but still asked for a route-level test next round.
//
// 2) WhiteHat2's NO-GO (gate comment 19003) on that same version found two REAL bypasses, both
//    through the route layer specifically: F1, the anti-bypass reference point was a flag field
//    (`updatedAt`) that store/pre-dispatch-check.sh rewrites on EVERY run even while the stop stays
//    continuously active, reopening the bypass window after each write; F2, checking an ancestor's
//    LIVE status let a `done` parent reopened to `in_progress` AFTER the stop started retroactively
//    exempt its pre-stop children. The fix: `isLinkedToInProgressCard` now takes the stop's frozen
//    activation moment (`flag.newDevStopActivatedAt`) and a frozen snapshot of ids that were
//    in_progress AT THAT MOMENT (`flag.inProgressAtActivation`), both requested explicitly at
//    "write a regression test spanning TWO flag writes, on the real route".
//
// readHardStop() is mocked (importOriginal + override) so each test controls exactly what the
// "current flag" says, without touching the real, shared store/weekly-hard-stop.json -- everything
// else in the module (isNewDevStartBlocked, the real predicate under test) stays genuine.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, createKanbanCard, updateKanbanCard, getKanbanCard, getDb } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'
import type { WeeklyHardStop } from '../costops/weekly-hard-stop.js'

// A realistic, epoch-scale activation moment (NOT a small synthetic number): the F1 regression
// test below depends on this being in the same numeric range as a real `created_at`/field-event
// timestamp, or a buggy comparison against the wrong flag field would never actually disagree with
// the fixed one -- a small T0 vs. a real epoch value for the edge would make either comparator
// come out the same way by sheer magnitude, silently defeating the regression test.
const T0 = Math.floor(Date.now() / 1000) - 10_000

const setParentIdFieldEvent = (id: string, newValue: string, at: number) =>
  getDb()
    .prepare(
      "INSERT INTO kanban_card_field_events (card_id, field, old_value, new_value, actor, created_at) VALUES (?, 'parent_id', NULL, ?, 'test', ?)",
    )
    .run(id, newValue, at)

let currentFlag: WeeklyHardStop
vi.mock('../costops/weekly-hard-stop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../costops/weekly-hard-stop.js')>()
  return { ...actual, readHardStop: () => currentFlag }
})

const { tryHandleKanban } = await import('../web/routes/kanban.js')

function post(path: string, method: string, body: unknown) {
  const out: { status: number; body: unknown } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req: any = Readable.from([Buffer.from(JSON.stringify(body))])
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

const open = (id: string) => post(`/api/kanban/${id}/move`, 'POST', { status: 'in_progress', actor: 'backend', reason: 'x' })

beforeEach(() => {
  initDatabase(':memory:')
  currentFlag = {
    active: false,
    percent: 92,
    testStop: 97,
    newDevStop: 90,
    newDevStopActive: true,
    exemptAgents: ['mikrob'],
    reason: 'weekly usage 92% >= new-dev-stop 90%',
    updatedAt: T0,
    newDevStopActivatedAt: T0,
    inProgressAtActivation: ['anchor'],
  }
})

describe('newDevStop route wiring (card b73722e1)', () => {
  it('CONTROL: an unlinked planned card still gets 409 while the stop is active', async () => {
    createKanbanCard({ id: 'anchor', title: 'Anchor', status: 'in_progress' })
    createKanbanCard({ id: 'lonely', title: 'Lonely' })
    const { ctx, out } = open('lonely')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(409)
    expect(getKanbanCard('lonely')!.status).toBe('planned')
  })

  it('a pre-stop child of the snapshotted anchor opens through the real route, no force needed', async () => {
    createKanbanCard({ id: 'anchor', title: 'Anchor', status: 'in_progress' })
    createKanbanCard({ id: 'child', title: 'Child', parent_id: 'anchor' })
    getDb().prepare('UPDATE kanban_cards SET created_at = ? WHERE id = ?').run(T0 - 100, 'child')
    const { ctx, out } = open('child')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('child')!.status).toBe('in_progress')
  })

  it('F1 regression: the reparent-then-wait bypass stays refused across a SECOND flag write that only advances updatedAt (the stop never left activation)', async () => {
    createKanbanCard({ id: 'anchor', title: 'Anchor', status: 'in_progress' })
    createKanbanCard({ id: 'other', title: 'Other' })
    createKanbanCard({ id: 'z', title: 'Z', parent_id: 'other' })

    // Z reparents onto the anchor 50s AFTER the true activation moment T0 -- a card trying to
    // dodge the stop by reparenting right after it starts. Written directly via SQL, NOT through
    // updateKanbanCard: that call would ALSO auto-record its own field-event at the real (huge)
    // wall-clock time, which -- being bigger than both T0 and T0+300 below -- would mask the
    // synthetic T0+50 row under `ORDER BY created_at DESC` and defeat the whole point of this test.
    getDb().prepare('UPDATE kanban_cards SET parent_id = ? WHERE id = ?').run('anchor', 'z')
    setParentIdFieldEvent('z', 'anchor', T0 + 50)

    // FIRST flag write (activation): refused, same under old or fixed code (updatedAt === T0 here).
    let r = open('z')
    expect(await tryHandleKanban(r.ctx)).toBe(true)
    expect(r.out.status).toBe(409)

    // SECOND flag write: store/pre-dispatch-check.sh ran again while the stop stayed continuously
    // active -- write_hard_stop's own fix carries newDevStopActivatedAt/inProgressAtActivation
    // forward UNCHANGED; only updatedAt (no longer read by this guard) moves on. Before the fix,
    // the guard compared the edge against `updatedAt` itself: T0+50 < T0+300 would have exempted
    // Z right here, reopening the bypass this test pins shut.
    currentFlag = { ...currentFlag, updatedAt: T0 + 300 }
    r = open('z')
    expect(await tryHandleKanban(r.ctx)).toBe(true)
    expect(r.out.status).toBe(409) // must STILL be refused -- this is exactly what regressed before the fix
    expect(getKanbanCard('z')!.status).toBe('planned')
  })

  it('F2 regression: reopening a done parent to in_progress AFTER activation does not retroactively exempt its pre-stop planned children', async () => {
    createKanbanCard({ id: 'parent', title: 'Parent', status: 'done' }) // not in_progress at activation -- not in the snapshot
    createKanbanCard({ id: 'child', title: 'Child', parent_id: 'parent' })
    getDb().prepare('UPDATE kanban_cards SET created_at = ? WHERE id = ?').run(T0 - 100, 'child')

    updateKanbanCard('parent', { status: 'in_progress' }, { actor: 'mikrob', force: true })

    const { ctx, out } = open('child')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(409)
    expect(getKanbanCard('child')!.status).toBe('planned')
  })
})
