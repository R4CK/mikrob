// CLAUDE.md rule 1e (card b73722e1): the newDevStop should not refuse a card that is a
// child/predecessor/successor of an in_progress card -- it is a subtask of work already underway,
// not new development. isLinkedToInProgressCard() in db.ts is the predicate; this file proves both
// directions (parent_id chain, dependency edges) and the anti-bypass (an edge written AFTER the
// stop activated must not count, closing the obvious reparent-to-dodge-the-stop move).
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, updateKanbanCard, addKanbanDependency, getDb, isLinkedToInProgressCard } from '../db.js'

const STOP_AT = 10_000 // the stop's own activation timestamp for every test below

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
  it('a direct child of an in_progress parent, linked BEFORE the stop, is linked', () => {
    createKanbanCard({ id: 'parent', title: 'Parent' })
    createKanbanCard({ id: 'child', title: 'Child', parent_id: 'parent' })
    setCreatedAt('child', STOP_AT - 100) // parent_id was set at creation, before the stop
    updateKanbanCard('parent', { status: 'in_progress' })
    expect(isLinkedToInProgressCard('child', STOP_AT)).toBe(true)
  })

  it('a grandchild (two parent_id hops) of an in_progress ancestor is linked', () => {
    createKanbanCard({ id: 'phase', title: 'Phase' })
    createKanbanCard({ id: 'task', title: 'Task', parent_id: 'phase' })
    createKanbanCard({ id: 'subtask', title: 'Subtask', parent_id: 'task' })
    setCreatedAt('task', STOP_AT - 200)
    setCreatedAt('subtask', STOP_AT - 100)
    updateKanbanCard('phase', { status: 'in_progress' })
    expect(isLinkedToInProgressCard('subtask', STOP_AT)).toBe(true)
  })

  it('NOT linked when the parent is merely planned, not in_progress', () => {
    createKanbanCard({ id: 'parent', title: 'Parent' })
    createKanbanCard({ id: 'child', title: 'Child', parent_id: 'parent' })
    setCreatedAt('child', STOP_AT - 100)
    expect(isLinkedToInProgressCard('child', STOP_AT)).toBe(false)
  })

  it('anti-bypass: reparenting onto an in_progress card AFTER the stop activated does not count', () => {
    createKanbanCard({ id: 'parent', title: 'Parent' })
    createKanbanCard({ id: 'other', title: 'Other' })
    createKanbanCard({ id: 'child', title: 'Child', parent_id: 'other' })
    updateKanbanCard('parent', { status: 'in_progress' })
    // The child reparents onto the in_progress card, but the edge is audited AFTER the stop's own
    // activation timestamp -- a card trying to dodge the stop by reparenting right before opening.
    updateKanbanCard('child', { parent_id: 'parent' })
    setParentIdFieldEvent('child', 'parent', STOP_AT + 50)
    expect(isLinkedToInProgressCard('child', STOP_AT)).toBe(false)
  })

  it('a tainted hop higher up the chain blocks the whole climb past it, even if the lower hop is old', () => {
    createKanbanCard({ id: 'phase', title: 'Phase' })
    createKanbanCard({ id: 'other-phase', title: 'Other phase' })
    createKanbanCard({ id: 'task', title: 'Task', parent_id: 'other-phase' })
    createKanbanCard({ id: 'subtask', title: 'Subtask', parent_id: 'task' })
    setCreatedAt('subtask', STOP_AT - 500) // this hop (subtask -> task) is old and fine
    updateKanbanCard('phase', { status: 'in_progress' })
    // task reparents from other-phase onto the in_progress phase, AFTER the stop activated
    updateKanbanCard('task', { parent_id: 'phase' })
    setParentIdFieldEvent('task', 'phase', STOP_AT + 10)
    expect(isLinkedToInProgressCard('subtask', STOP_AT)).toBe(false)
  })

  it('stopActivatedAt === null (old-format flag, no safe reference point) never exempts', () => {
    createKanbanCard({ id: 'parent', title: 'Parent' })
    createKanbanCard({ id: 'child', title: 'Child', parent_id: 'parent' })
    updateKanbanCard('parent', { status: 'in_progress' })
    expect(isLinkedToInProgressCard('child', null)).toBe(false)
  })
})

describe('isLinkedToInProgressCard: dependency edges (predecessor/successor)', () => {
  it('cardId is a PREDECESSOR of an in_progress successor (someone in_progress depends on it)', () => {
    createKanbanCard({ id: 'pred', title: 'Pred' })
    createKanbanCard({ id: 'succ', title: 'Succ' })
    addKanbanDependency('succ', 'pred') // succ depends on pred -> pred is succ's predecessor
    setDependencyCreatedAt('succ', 'pred', STOP_AT - 100)
    // succ depends on pred (not done), so an ordinary move would itself be dependency-blocked --
    // force it as mikrob purely to get succ into in_progress for this fixture; that guard is not
    // what this test is about.
    updateKanbanCard('succ', { status: 'in_progress' }, { actor: 'mikrob', force: true })
    expect(isLinkedToInProgressCard('pred', STOP_AT)).toBe(true)
  })

  it('cardId is a SUCCESSOR of an in_progress predecessor (it depends on someone in_progress)', () => {
    createKanbanCard({ id: 'pred', title: 'Pred' })
    createKanbanCard({ id: 'succ', title: 'Succ' })
    addKanbanDependency('succ', 'pred')
    setDependencyCreatedAt('succ', 'pred', STOP_AT - 100)
    updateKanbanCard('pred', { status: 'in_progress' })
    expect(isLinkedToInProgressCard('succ', STOP_AT)).toBe(true)
  })

  it('anti-bypass: a dependency edge added AFTER the stop activated does not count', () => {
    createKanbanCard({ id: 'pred', title: 'Pred' })
    createKanbanCard({ id: 'succ', title: 'Succ' })
    addKanbanDependency('succ', 'pred')
    updateKanbanCard('succ', { status: 'in_progress' }, { actor: 'mikrob', force: true })
    setDependencyCreatedAt('succ', 'pred', STOP_AT + 50)
    expect(isLinkedToInProgressCard('pred', STOP_AT)).toBe(false)
  })

  it('NOT linked when the linked card is merely planned, not in_progress', () => {
    createKanbanCard({ id: 'pred', title: 'Pred' })
    createKanbanCard({ id: 'succ', title: 'Succ' })
    addKanbanDependency('succ', 'pred')
    setDependencyCreatedAt('succ', 'pred', STOP_AT - 100)
    expect(isLinkedToInProgressCard('pred', STOP_AT)).toBe(false)
    expect(isLinkedToInProgressCard('succ', STOP_AT)).toBe(false)
  })
})

describe('isLinkedToInProgressCard: an unrelated card is never linked', () => {
  it('no parent, no dependency edge -> false', () => {
    createKanbanCard({ id: 'lonely', title: 'Lonely' })
    createKanbanCard({ id: 'busy', title: 'Busy' })
    updateKanbanCard('busy', { status: 'in_progress' })
    expect(isLinkedToInProgressCard('lonely', STOP_AT)).toBe(false)
  })
})
