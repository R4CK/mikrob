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
  moveKanbanCard,
  getKanbanCard,
  getKanbanCardEvents,
  addKanbanDependency,
  removeKanbanDependency,
  getKanbanPredecessors,
  getKanbanSuccessors,
  getUnmetKanbanPredecessors,
  getUnmetPredecessorsForAllCards,
} from '../db.js'
import { forceActors } from '../kanban-force-actors.js'

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
    updateKanbanCard('b', { status: 'done' }, { actor: 'mikrob', force: true })
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
    updateKanbanCard('b', { status: 'done' }, { actor: 'mikrob', force: true })
    expect(archiveKanbanCard('b')).toEqual({ ok: true })
    expect(getUnmetKanbanPredecessors('a')).toEqual([])
  })
})

describe('the status guard: an unmet predecessor blocks BOTH transitions (card a8aa9ae5)', () => {
  // Enforced in the db writers, not the routes, because there are THREE doors into a status
  // change -- PUT /api/kanban/:id, POST /api/kanban/:id/move, and db.ts's own scheduler call to
  // moveKanbanCard. The repo already learned this once: the landed-guard comment in the routes
  // says "guarding one of two doors guards neither".
  beforeEach(() => {
    addKanbanDependency('a', 'b') // b must finish before a
  })

  it('planned -> in_progress is refused while the predecessor is open', () => {
    expect(moveKanbanCard('a', 'in_progress', 0, 'someone')).toBe(false)
    expect(getKanbanCard('a')!.status).toBe('planned')
  })

  it('waiting -> done is refused too -- the dependency must be MET, not merely started', () => {
    moveKanbanCard('a', 'waiting', 0, 'mikrob', true)
    expect(moveKanbanCard('a', 'done', 0, 'someone')).toBe(false)
    expect(getKanbanCard('a')!.status).toBe('waiting')
  })

  it('WAITING IS NOT GUARDED: a builder can always hand finished work to a gate', () => {
    // Deliberate. Blocking `waiting` would stop a builder from submitting for review, which is not
    // what a dependency means -- the block belongs at the close, not at the handover.
    expect(moveKanbanCard('a', 'waiting', 0, 'someone')).toBe(true)
    expect(getKanbanCard('a')!.status).toBe('waiting')
  })

  it('THE SAME GUARD ON THE OTHER WRITER: updateKanbanCard refuses it as well', () => {
    expect(updateKanbanCard('a', { status: 'in_progress' }, { actor: 'someone' })).toBe(false)
    expect(getKanbanCard('a')!.status).toBe('planned')
  })

  it('a REORDER inside the same column is never blocked', () => {
    // moveKanbanCard is also the drag-and-drop path. Gating on the target status alone would make
    // a card that is ALREADY in_progress with an open predecessor immovable within its own column.
    moveKanbanCard('a', 'in_progress', 0, 'mikrob', true) // forced in
    expect(moveKanbanCard('a', 'in_progress', 99, 'someone')).toBe(true)
    expect(getKanbanCard('a')!.sort_order).toBe(99)
  })

  it('once the predecessor is done, the transition goes through unforced', () => {
    updateKanbanCard('b', { status: 'done' }, { actor: 'mikrob', force: true })
    expect(moveKanbanCard('a', 'in_progress', 0, 'someone')).toBe(true)
    expect(getKanbanCard('a')!.status).toBe('in_progress')
  })

  it('THE HOLE CYBERSEC FOUND: force:true from an UNLISTED actor does NOT open the guard', () => {
    // The card asked for "the EXISTING force-flag + actor pattern" and the first version shipped
    // force alone. Every sibling guard on this state machine (landed, gate-completeness,
    // newDevStop) requires an allowlisted actor with it -- and the one that once did not was
    // abused (cards 31cc1cd4 / 874a9fb0 / 23594bbc). Measured before the fix: force:true with no
    // actor returned TRUE and wrote actor=null, forced=1.
    expect(moveKanbanCard('a', 'in_progress', 0, undefined, true)).toBe(false)
    expect(moveKanbanCard('a', 'in_progress', 0, 'someone', true)).toBe(false)
    expect(updateKanbanCard('a', { status: 'done' }, { actor: 'someone', force: true })).toBe(false)
    expect(getKanbanCard('a')!.status).toBe('planned')
  })

  it('an ALLOWLISTED actor bypasses it, and the audit row records that it was forced', () => {
    expect(forceActors()).toContain('mikrob') // the control: the fixture really is on the list
    expect(moveKanbanCard('a', 'in_progress', 0, 'mikrob', true)).toBe(true)
    const ev = getKanbanCardEvents('a').at(-1)!
    expect(ev.to_status).toBe('in_progress')
    expect(ev.actor).toBe('mikrob')
    expect(ev.forced).toBe(1) // a bypass that leaves no trace is not a bypass, it is a hole
  })

  it('an ORDINARY forced move is not recorded as an override', () => {
    // force:true is sent routinely by some clients. Recording every one of them as a guard
    // override would make the flag useless for finding the real ones.
    updateKanbanCard('b', { status: 'done' }, { actor: 'mikrob', force: true })
    moveKanbanCard('a', 'in_progress', 0, 'mikrob', true)
    expect(getKanbanCardEvents('a').at(-1)!.forced).toBe(0)
  })

  it('a card with NO predecessors is unaffected', () => {
    expect(moveKanbanCard('c', 'in_progress', 0, 'someone')).toBe(true)
  })
})

describe('the board reports blocked cards without an N+1 (card 38788337)', () => {
  it('a card with an open predecessor is marked, one without is not', () => {
    addKanbanDependency('a', 'b')
    const m = getUnmetPredecessorsForAllCards()
    expect(m.get('a')!.map((c) => c.id)).toEqual(['b'])
    expect(m.has('c')).toBe(false) // no edge at all -- absent, not an empty array
    expect(m.has('b')).toBe(false)
  })

  it('EVERY unmet predecessor is listed, not just the first', () => {
    addKanbanDependency('a', 'b')
    addKanbanDependency('a', 'c')
    expect(getUnmetPredecessorsForAllCards().get('a')!.map((c) => c.id).sort()).toEqual(['b', 'c'])
  })

  it('a DONE predecessor drops out, and the last one dropping unmarks the card', () => {
    addKanbanDependency('a', 'b')
    addKanbanDependency('a', 'c')
    updateKanbanCard('b', { status: 'done' }, { actor: 'mikrob', force: true })
    expect(getUnmetPredecessorsForAllCards().get('a')!.map((c) => c.id)).toEqual(['c'])
    updateKanbanCard('c', { status: 'done' }, { actor: 'mikrob', force: true })
    // Absent, not present-and-empty: the caller reads a missing key as "not blocked".
    expect(getUnmetPredecessorsForAllCards().has('a')).toBe(false)
  })

  it('the bulk map agrees with the per-card predicate, card by card', () => {
    // The two are separate queries -- the list endpoint uses the bulk one, GET /:id the single one.
    // If they could disagree, a card would read blocked on the board and open unblocked, which is
    // exactly the kind of split-brain a derived field is supposed to avoid.
    addKanbanDependency('a', 'b')
    addKanbanDependency('c', 'b')
    const m = getUnmetPredecessorsForAllCards()
    for (const id of ['a', 'b', 'c']) {
      expect((m.get(id) ?? []).map((x) => x.id)).toEqual(getUnmetKanbanPredecessors(id).map((x) => x.id))
    }
  })

  it('the rows carry whole cards, so the board can render a title without another request', () => {
    addKanbanDependency('a', 'b')
    const [blocker] = getUnmetPredecessorsForAllCards().get('a')!
    expect(blocker!.title).toBe('B')
    expect(blocker!.status).toBe('planned')
    // ...and the join column used for grouping must not leak into the card object.
    expect('blocked_id' in blocker!).toBe(false)
  })
})
