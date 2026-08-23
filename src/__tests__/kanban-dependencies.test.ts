// Card 2bb82943: the kanban_dependencies edge table -- schema, cascade, cycle rejection, and what
// "satisfied" means. Runs against an in-memory database seeded with the PRODUCTION schema, through
// the real exported functions, in the same shape as kanban-delete-fk.test.ts.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase,
  createKanbanCard,
  deleteKanbanCard,
  updateKanbanCard,
  archiveKanbanCard,
  addKanbanDependency,
  removeKanbanDependency,
  getKanbanPredecessors,
  getKanbanSuccessors,
  getUnmetKanbanPredecessors,
} from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
  createKanbanCard({ id: 'a', title: 'A' })
  createKanbanCard({ id: 'b', title: 'B' })
  createKanbanCard({ id: 'c', title: 'C' })
})

describe('kanban_dependencies: one edge, read from both ends', () => {
  it('a -> b makes b a predecessor of a, and a a successor of b', () => {
    expect(addKanbanDependency('a', 'b')).toEqual({ ok: true })
    expect(getKanbanPredecessors('a').map((c) => c.id)).toEqual(['b'])
    expect(getKanbanSuccessors('b').map((c) => c.id)).toEqual(['a'])
    // ...and nothing leaks into the other direction. One row, two views.
    expect(getKanbanPredecessors('b')).toEqual([])
    expect(getKanbanSuccessors('a')).toEqual([])
  })

  it('predecessors carry the whole card, not just an id -- the modal renders from this', () => {
    addKanbanDependency('a', 'b')
    const [pred] = getKanbanPredecessors('a')
    expect(pred!.title).toBe('B')
    expect(pred!.status).toBe('planned')
  })

  it('the same edge twice is a duplicate, not a second row', () => {
    expect(addKanbanDependency('a', 'b')).toEqual({ ok: true })
    expect(addKanbanDependency('a', 'b')).toEqual({ ok: false, reason: 'duplicate' })
    expect(getKanbanPredecessors('a')).toHaveLength(1)
  })

  it('a card cannot depend on itself', () => {
    expect(addKanbanDependency('a', 'a')).toEqual({ ok: false, reason: 'self' })
    expect(getKanbanPredecessors('a')).toEqual([])
  })

  it('an unknown card on either end is refused, and says WHICH one', () => {
    expect(addKanbanDependency('a', 'nope')).toEqual({ ok: false, reason: 'not-found', missing: 'nope' })
    expect(addKanbanDependency('nope', 'a')).toEqual({ ok: false, reason: 'not-found', missing: 'nope' })
  })

  it('removing an edge removes exactly that edge', () => {
    addKanbanDependency('a', 'b')
    addKanbanDependency('a', 'c')
    expect(removeKanbanDependency('a', 'b')).toBe(true)
    expect(getKanbanPredecessors('a').map((c) => c.id)).toEqual(['c'])
    expect(removeKanbanDependency('a', 'b')).toBe(false) // already gone
  })
})

describe('cycle rejection is TRANSITIVE, not just the A<->B pair', () => {
  it('the direct loop: b already depends on a, so a cannot depend on b', () => {
    addKanbanDependency('b', 'a')
    const r = addKanbanDependency('a', 'b')
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ reason: 'cycle' })
  })

  it('THE ONE A PAIRWISE CHECK MISSES: a->b, b->c, then c->a', () => {
    // Each edge is fine on its own and no two of them form a pair. Closing the loop is what makes
    // every card in it block every other one -- a state the status guard can never resolve, where
    // only `force` gets anyone out. A check that only looked at (from, to) would allow this.
    expect(addKanbanDependency('a', 'b')).toEqual({ ok: true })
    expect(addKanbanDependency('b', 'c')).toEqual({ ok: true })
    const r = addKanbanDependency('c', 'a')
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ reason: 'cycle' })
    // CONTROL: the chain itself survived. Rejecting the closing edge must not undo the legal ones.
    expect(getKanbanPredecessors('a').map((c) => c.id)).toEqual(['b'])
    expect(getKanbanPredecessors('b').map((c) => c.id)).toEqual(['c'])
  })

  it('a DIAMOND is not a cycle -- two paths to the same card stay legal', () => {
    // Proves the check rejects loops, not merely "more than one way to reach a card". Without this
    // the cycle test above would also pass on a stricter, wrong implementation.
    createKanbanCard({ id: 'd', title: 'D' })
    expect(addKanbanDependency('a', 'b')).toEqual({ ok: true })
    expect(addKanbanDependency('a', 'c')).toEqual({ ok: true })
    expect(addKanbanDependency('b', 'd')).toEqual({ ok: true })
    expect(addKanbanDependency('c', 'd')).toEqual({ ok: true })
  })
})

describe('deleting a card CUTS its edges (there is no working ON DELETE CASCADE here)', () => {
  it('edges in BOTH directions go with the card', () => {
    addKanbanDependency('a', 'b') // b blocks a
    addKanbanDependency('b', 'c') // c blocks b
    expect(deleteKanbanCard('b')).toBe(true)
    // a is no longer blocked by anything, and c no longer blocks anything.
    expect(getKanbanPredecessors('a')).toEqual([])
    expect(getKanbanSuccessors('c')).toEqual([])
  })

  it('THE DANGLING-ROW BUG: no edge may survive pointing at a card that is gone', () => {
    // PRAGMA foreign_keys is OFF (better-sqlite3 default, and this codebase never enables it --
    // measured 0 on the live DB), so the table's REFERENCES clauses enforce nothing. Without the
    // explicit DELETE in deleteKanbanCard's transaction these rows would simply stay, and a
    // successor would keep reading a predecessor that no longer exists.
    addKanbanDependency('a', 'b')
    deleteKanbanCard('b')
    // The JOIN would hide a dangling row, so ask the successor side too -- both must be empty.
    expect(getKanbanPredecessors('a')).toEqual([])
    expect(getKanbanSuccessors('b')).toEqual([])
    // And a fresh card reusing that id must NOT inherit the old edge.
    createKanbanCard({ id: 'b', title: 'B again' })
    expect(getKanbanSuccessors('b')).toEqual([])
  })
})

describe('"satisfied" means status=done -- and archiving is NOT a way around it', () => {
  it('an open predecessor is unmet, a done one is not', () => {
    addKanbanDependency('a', 'b')
    expect(getUnmetKanbanPredecessors('a').map((c) => c.id)).toEqual(['b'])
    updateKanbanCard('b', { status: 'done' }, { actor: 'test', force: true })
    expect(getUnmetKanbanPredecessors('a')).toEqual([])
  })

  it('THE BYPASS THIS REFUSES: archiving an UNFINISHED predecessor does not satisfy it', () => {
    // The plan said "done OR archived", on the premise that archiving only happens to done cards.
    // True for the automatic sweep (WHERE status = 'done'), false for archiveKanbanCard(), which
    // only checks that the card's CHILDREN are done. So a single POST /archive on a `planned` leaf
    // would have satisfied a dependency nobody finished -- no force flag, no audit row.
    addKanbanDependency('a', 'b')
    expect(archiveKanbanCard('b')).toEqual({ ok: true })
    expect(getUnmetKanbanPredecessors('a').map((c) => c.id)).toEqual(['b'])
  })

  it('CONTROL: an archived predecessor that IS done still counts as satisfied', () => {
    // The half of the plan's intent that was right: the nightly sweep archives done cards, and
    // archiving leaves `status` alone, so they keep satisfying their successors.
    addKanbanDependency('a', 'b')
    updateKanbanCard('b', { status: 'done' }, { actor: 'test', force: true })
    expect(archiveKanbanCard('b')).toEqual({ ok: true })
    expect(getUnmetKanbanPredecessors('a')).toEqual([])
  })
})
