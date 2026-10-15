// CLAUDE.md rule 1e (card b73722e1): the newDevStop should not refuse a card that is a
// child/predecessor/successor of a card already in_progress WHEN THE STOP ACTIVATED -- it is a
// subtask of work already underway, not new development. isLinkedToInProgressCard() in db.ts is
// the predicate; this file proves both directions (parent_id chain, dependency edges) and the
// anti-bypass (an edge written AFTER the stop activated must not count, closing the
// reparent-to-dodge-the-stop move).
//
// WhiteHat2 NO-GO (gate comment 19003) on an earlier version of this predicate: F1, the anti-
// bypass reference point used a flag field (`updatedAt`) that store/pre-dispatch-check.sh
// rewrites on EVERY run, even while the stop stays continuously active -- so the bypass window
// reopened after each write. F2, checking the ancestor's LIVE status let a `done` parent reopened
// to `in_progress` AFTER the stop started retroactively exempt its pre-stop children. Both are
// fixed by the caller passing (1) the stop's true, steady activation moment
// (`flag.newDevStopActivatedAt`, never rewritten while already active) and (2) a FROZEN snapshot
// of which card ids were `in_progress` at that exact moment (`flag.inProgressAtActivation`) --
// `isLinkedToInProgressCard` checks membership in that snapshot, not a live status read. These
// tests exercise exactly that two-argument contract.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, updateKanbanCard, addKanbanDependency, getDb, isLinkedToInProgressCard } from '../db.js'

const STOP_AT = 10_000 // the stop's true activation timestamp for every test below

beforeEach(() => {
  initDatabase(':memory:')
})

const setCreatedAt = (id: string, at: number) =>
  getDb().prepare('UPDATE kanban_cards SET created_at = ? WHERE id = ?').run(at, id)

const setParentIdFieldEvent = (id: string, newValue: string, at: number) =>
  getDb()
    .prepare(
      "INSERT INTO kanban_card_field_events (card_id, field, old_value, new_value, actor, created_at) VALUES (?, 'parent_id', NULL, ?, 'test', ?)",
    )
    .run(id, newValue, at)

const setDependencyCreatedAt = (from: string, to: string, at: number) =>
  getDb().prepare('UPDATE kanban_dependencies SET created_at = ? WHERE from_card_id = ? AND to_card_id = ?').run(at, from, to)

describe('isLinkedToInProgressCard: parent_id chain', () => {
  it('a direct child of a snapshotted parent, linked BEFORE the stop, is linked', () => {
    createKanbanCard({ id: 'parent', title: 'Parent' })
    createKanbanCard({ id: 'child', title: 'Child', parent_id: 'parent' })
    setCreatedAt('child', STOP_AT - 100) // parent_id was set at creation, before the stop
    expect(isLinkedToInProgressCard('child', STOP_AT, ['parent'])).toBe(true)
  })

  it('a grandchild (two parent_id hops) of a snapshotted ancestor is linked', () => {
    createKanbanCard({ id: 'phase', title: 'Phase' })
    createKanbanCard({ id: 'task', title: 'Task', parent_id: 'phase' })
    createKanbanCard({ id: 'subtask', title: 'Subtask', parent_id: 'task' })
    setCreatedAt('task', STOP_AT - 200)
    setCreatedAt('subtask', STOP_AT - 100)
    expect(isLinkedToInProgressCard('subtask', STOP_AT, ['phase'])).toBe(true)
  })

  it('NOT linked when the parent was planned (or anything else) at activation, not in the snapshot', () => {
    createKanbanCard({ id: 'parent', title: 'Parent' })
    createKanbanCard({ id: 'child', title: 'Child', parent_id: 'parent' })
    setCreatedAt('child', STOP_AT - 100)
    expect(isLinkedToInProgressCard('child', STOP_AT, [])).toBe(false)
    expect(isLinkedToInProgressCard('child', STOP_AT, ['some-other-card'])).toBe(false)
  })

  it('anti-bypass (F1 shape): reparenting onto a snapshotted card AFTER the stop activated does not count', () => {
    createKanbanCard({ id: 'parent', title: 'Parent' })
    createKanbanCard({ id: 'other', title: 'Other' })
    createKanbanCard({ id: 'child', title: 'Child', parent_id: 'other' })
    // The child reparents onto the snapshotted card, but the edge is audited AFTER the stop's own
    // activation timestamp -- a card trying to dodge the stop by reparenting right before opening.
    updateKanbanCard('child', { parent_id: 'parent' })
    setParentIdFieldEvent('child', 'parent', STOP_AT + 50)
    expect(isLinkedToInProgressCard('child', STOP_AT, ['parent'])).toBe(false)
  })

  it('anti-bypass (F2 shape): a card reopened to in_progress AFTER activation is never in the snapshot, however its live status now reads', () => {
    createKanbanCard({ id: 'parent', title: 'Parent' })
    createKanbanCard({ id: 'child', title: 'Child', parent_id: 'parent' })
    setCreatedAt('child', STOP_AT - 100) // the parent_id edge itself is old and fine
    updateKanbanCard('parent', { status: 'done' }) // then reopened to in_progress AFTER the stop
    updateKanbanCard('parent', { status: 'in_progress' }, { actor: 'mikrob', force: true })
    // 'parent' is NOT in the snapshot (it was done, not in_progress, at activation) -- its current
    // live status must not matter.
    expect(isLinkedToInProgressCard('child', STOP_AT, [])).toBe(false)
  })

  it('a tainted hop higher up the chain blocks the whole climb past it, even if the lower hop is old', () => {
    createKanbanCard({ id: 'phase', title: 'Phase' })
    createKanbanCard({ id: 'other-phase', title: 'Other phase' })
    createKanbanCard({ id: 'task', title: 'Task', parent_id: 'other-phase' })
    createKanbanCard({ id: 'subtask', title: 'Subtask', parent_id: 'task' })
    setCreatedAt('subtask', STOP_AT - 500) // this hop (subtask -> task) is old and fine
    // task reparents from other-phase onto the snapshotted phase, AFTER the stop activated
    updateKanbanCard('task', { parent_id: 'phase' })
    setParentIdFieldEvent('task', 'phase', STOP_AT + 10)
    expect(isLinkedToInProgressCard('subtask', STOP_AT, ['phase'])).toBe(false)
  })

  it('stopActivatedAt === null (old-format flag, no safe reference point) never exempts', () => {
    createKanbanCard({ id: 'parent', title: 'Parent' })
    createKanbanCard({ id: 'child', title: 'Child', parent_id: 'parent' })
    expect(isLinkedToInProgressCard('child', null, ['parent'])).toBe(false)
  })

  it('an empty snapshot never exempts, even with a valid activation timestamp', () => {
    createKanbanCard({ id: 'parent', title: 'Parent' })
    createKanbanCard({ id: 'child', title: 'Child', parent_id: 'parent' })
    setCreatedAt('child', STOP_AT - 100)
    expect(isLinkedToInProgressCard('child', STOP_AT, [])).toBe(false)
  })
})

describe('isLinkedToInProgressCard: dependency edges (predecessor/successor)', () => {
  it('cardId is a PREDECESSOR of a snapshotted successor (someone snapshotted depends on it)', () => {
    createKanbanCard({ id: 'pred', title: 'Pred' })
    createKanbanCard({ id: 'succ', title: 'Succ' })
    addKanbanDependency('succ', 'pred') // succ depends on pred -> pred is succ's predecessor
    setDependencyCreatedAt('succ', 'pred', STOP_AT - 100)
    expect(isLinkedToInProgressCard('pred', STOP_AT, ['succ'])).toBe(true)
  })

  it('cardId is a SUCCESSOR of a snapshotted predecessor (it depends on someone snapshotted)', () => {
    createKanbanCard({ id: 'pred', title: 'Pred' })
    createKanbanCard({ id: 'succ', title: 'Succ' })
    addKanbanDependency('succ', 'pred')
    setDependencyCreatedAt('succ', 'pred', STOP_AT - 100)
    expect(isLinkedToInProgressCard('succ', STOP_AT, ['pred'])).toBe(true)
  })

  it('anti-bypass: a dependency edge added AFTER the stop activated does not count', () => {
    createKanbanCard({ id: 'pred', title: 'Pred' })
    createKanbanCard({ id: 'succ', title: 'Succ' })
    addKanbanDependency('succ', 'pred')
    setDependencyCreatedAt('succ', 'pred', STOP_AT + 50)
    expect(isLinkedToInProgressCard('pred', STOP_AT, ['succ'])).toBe(false)
  })

  it('NOT linked when the linked card is not in the snapshot', () => {
    createKanbanCard({ id: 'pred', title: 'Pred' })
    createKanbanCard({ id: 'succ', title: 'Succ' })
    addKanbanDependency('succ', 'pred')
    setDependencyCreatedAt('succ', 'pred', STOP_AT - 100)
    expect(isLinkedToInProgressCard('pred', STOP_AT, [])).toBe(false)
    expect(isLinkedToInProgressCard('succ', STOP_AT, [])).toBe(false)
  })
})

describe('isLinkedToInProgressCard: an unrelated card is never linked', () => {
  it('no parent, no dependency edge -> false even with a non-empty snapshot', () => {
    createKanbanCard({ id: 'lonely', title: 'Lonely' })
    createKanbanCard({ id: 'busy', title: 'Busy' })
    expect(isLinkedToInProgressCard('lonely', STOP_AT, ['busy'])).toBe(false)
  })
})
