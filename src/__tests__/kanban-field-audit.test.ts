// Card 51878c59: a non-status card edit used to leave no trace at all.
//
// THE INCIDENT THIS ANSWERS. On card 8d673233 a [50%] marker appeared in the TITLE, the board
// showed progress nobody had made, and afterwards NOBODY could say who wrote it -- the offload
// script was suspected and independently cleared (card 8b925388: three HTTP calls, none of them a
// title write). The reason it was unanswerable is here: updateKanbanCard only wrote to
// kanban_card_events when the STATUS changed, so every other field moved silently.
//
// That matters more than "an edit is untracked", because the fleet keeps its PROGRESS marker in
// the title ([NN%], working rule 2). The field that says how far along a piece of work is had no
// audit at all.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase,
  createKanbanCard,
  updateKanbanCard,
  moveKanbanCard,
  getKanbanCardEvents,
  getKanbanCardFieldEvents,
} from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
  createKanbanCard({ id: 'c1', title: 'Original title', priority: 'normal' })
})

describe('a non-status card edit is attributable (card 51878c59)', () => {
  it('THE INCIDENT SHAPE: a [NN%] written into the title names who did it, and when', () => {
    updateKanbanCard('c1', { title: '[50%] Original title' }, { actor: 'someone' })
    const ev = getKanbanCardFieldEvents('c1')
    expect(ev).toHaveLength(1)
    expect(ev[0]!.field).toBe('title')
    expect(ev[0]!.old_value).toBe('Original title')
    expect(ev[0]!.new_value).toBe('[50%] Original title')
    expect(ev[0]!.actor).toBe('someone')
    expect(ev[0]!.created_at).toBeGreaterThan(0)
  })

  it('an edit with NO actor is still recorded -- as an unnamed one, not as nothing', () => {
    // `actor` is self-declared and optional, so a null here is honest. Dropping the row instead
    // would restore exactly the hole this card is about: an edit that happened and left no trace.
    updateKanbanCard('c1', { title: 'Renamed' }, {})
    const ev = getKanbanCardFieldEvents('c1')
    expect(ev).toHaveLength(1)
    expect(ev[0]!.actor).toBeNull()
  })

  it('several fields changed at once produce one row EACH, not one lumped row', () => {
    updateKanbanCard('c1', { title: 'T2', priority: 'high', assignee: 'backend' }, { actor: 'mikrob' })
    const fields = getKanbanCardFieldEvents('c1').map((e) => e.field).sort()
    expect(fields).toEqual(['assignee', 'priority', 'title'])
  })

  it('a write that changes NOTHING records nothing', () => {
    updateKanbanCard('c1', { title: 'Original title' }, { actor: 'someone' })
    expect(getKanbanCardFieldEvents('c1')).toEqual([])
  })

  it('STATUS is not duplicated here -- kanban_card_events already owns it', () => {
    // Auditing it in both places would make the two disagree the first time one of them changed.
    moveKanbanCard('c1', 'in_progress', 0, 'someone')
    expect(getKanbanCardEvents('c1')).toHaveLength(1)
    expect(getKanbanCardFieldEvents('c1').map((e) => e.field)).not.toContain('status')
  })

  it('a status change made through updateKanbanCard still lands in the STATUS table only', () => {
    updateKanbanCard('c1', { status: 'in_progress' }, { actor: 'someone' })
    expect(getKanbanCardEvents('c1')).toHaveLength(1)
    expect(getKanbanCardFieldEvents('c1')).toEqual([])
  })

  it('sort_order is deliberately NOT audited -- a drag rewrites it on every card that shifted', () => {
    // Auditing it would bury the edits somebody actually wants to find under reordering noise.
    updateKanbanCard('c1', { sort_order: 42 }, { actor: 'someone' })
    expect(getKanbanCardFieldEvents('c1')).toEqual([])
  })

  it('the trail is ordered oldest-first, so a reader can follow what happened', () => {
    updateKanbanCard('c1', { title: 'A' }, { actor: 'first' })
    updateKanbanCard('c1', { title: 'B' }, { actor: 'second' })
    const ev = getKanbanCardFieldEvents('c1')
    expect(ev.map((e) => e.actor)).toEqual(['first', 'second'])
    expect(ev.map((e) => e.new_value)).toEqual(['A', 'B'])
    // ...and each row carries the value it REPLACED, so the chain reconstructs without guessing.
    expect(ev[1]!.old_value).toBe('A')
  })
})
