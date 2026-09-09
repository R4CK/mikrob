// Card 5b00c5ec (parent 01c846bf): markKanbanCardDispatched is a CLAIM, and its boolean says
// whether THIS call won it -- not whether the row exists.
//
// WHY THE DISTINCTION IS THE WHOLE TEST. The old statement was `WHERE id=?`, so `changes > 0` was
// true for the winner AND for anyone arriving second. A caller branching on that value would have
// read "I won" from a result that only ever meant "the card is real". The two cases are told apart
// here by asking TWICE: the second call is the one whose answer used to be wrong.
//
// The missing-card case is kept as the control. Without it, a mutation that made the function
// always return false would pass the two assertions that matter most, and this file would be
// asserting a constant rather than a behaviour.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase,
  createKanbanCard,
  markKanbanCardDispatched,
  getKanbanCard,
  moveKanbanCard,
} from '../db.js'

describe('markKanbanCardDispatched claims the dispatch (card 5b00c5ec)', () => {
  beforeEach(() => {
    // Same in-memory setup as kanban-dispatch-rearm.test.ts, the sibling that pins the RELEASE
    // half of this column's contract. Sharing the idiom keeps the two readable side by side.
    initDatabase(':memory:')
    createKanbanCard({ id: 'claim-1', title: 'c', status: 'planned' })
  })

  it('the FIRST claim wins and the SECOND loses -- the boolean is the claim, not the row', () => {
    expect(markKanbanCardDispatched('claim-1'), 'the first caller must win').toBe(true)
    expect(
      markKanbanCardDispatched('claim-1'),
      'the second caller must LOSE -- with the old `WHERE id=?` this was true, which is the defect',
    ).toBe(false)
  })

  it('the winning claim actually stamps the column (the true is not a bare constant)', () => {
    markKanbanCardDispatched('claim-1')
    expect(getKanbanCard('claim-1')?.dispatched_at).toBeTruthy()
  })

  it('CONTROL: a missing card id is false, so "always false" cannot pass this file', () => {
    expect(markKanbanCardDispatched('no-such-card')).toBe(false)
  })

  it('the claim is RELEASABLE, so losing it is not permanent', () => {
    // This is what makes claiming BEFORE the send safe to consider (card c4da93bf's open
    // question): moveKanbanCard clears the column when the card leaves in_progress, so a claim
    // that was taken and not used comes back rather than burning the card's dispatch forever.
    expect(markKanbanCardDispatched('claim-1')).toBe(true)
    moveKanbanCard('claim-1', 'in_progress', 0)
    moveKanbanCard('claim-1', 'planned', 0)
    expect(getKanbanCard('claim-1')?.dispatched_at).toBeNull()
    expect(markKanbanCardDispatched('claim-1'), 'the claim is available again').toBe(true)
  })
})
