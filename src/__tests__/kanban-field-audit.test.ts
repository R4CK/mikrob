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
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  initDatabase,
  createKanbanCard,
  updateKanbanCard,
  moveKanbanCard,
  getKanbanCardEvents,
  getKanbanCardFieldEvents,
  archiveKanbanCard,
  unarchiveKanbanCard,
  FIELD_AUDIT_VALUE_MAX,
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

describe('the three follow-up findings on this trail (card 7fd6dd23, Cybersec)', () => {
  it('F-1 THE DEAD FIELD: archiving writes an audit row -- it used to be declared and unreachable', () => {
    // archived_at was in the audited-field list and could never fire: archiveKanbanCard writes the
    // column with its OWN update, so nothing reached updateKanbanCard's comparison loop. Measured
    // before the fix: zero rows in either table after an archive. A declared-but-unreachable audit
    // field claims coverage it does not have, which is worse than an honest gap -- a reader stops
    // looking.
    expect(archiveKanbanCard('c1', { actor: 'mikrob' })).toEqual({ ok: true })
    const ev = getKanbanCardFieldEvents('c1')
    expect(ev).toHaveLength(1)
    expect(ev[0]!.field).toBe('archived_at')
    expect(ev[0]!.old_value).toBeNull()
    expect(ev[0]!.new_value).not.toBeNull()
    expect(ev[0]!.actor).toBe('mikrob')
  })

  it('F-1 the other direction: unarchiving is audited too, and keeps the value it cleared', () => {
    archiveKanbanCard('c1', { actor: 'mikrob' })
    const archivedAt = getKanbanCardFieldEvents('c1')[0]!.new_value
    expect(unarchiveKanbanCard('c1', { actor: 'someone' })).toBe(true)
    const last = getKanbanCardFieldEvents('c1').at(-1)!
    expect(last.field).toBe('archived_at')
    expect(last.old_value).toBe(archivedAt) // the chain reconstructs without guessing
    expect(last.new_value).toBeNull()
    expect(last.actor).toBe('someone')
  })

  it('F-1 CONTROL: a refused archive writes NO row', () => {
    // Otherwise the trail would record attempts as if they had happened.
    createKanbanCard({ id: 'parent', title: 'P' })
    createKanbanCard({ id: 'kid', title: 'K', parent_id: 'parent', status: 'planned' })
    expect(archiveKanbanCard('parent', { actor: 'mikrob' }).ok).toBe(false)
    expect(getKanbanCardFieldEvents('parent')).toEqual([])
  })

  it('F-3 a long value is CAPPED, and the cut is visible', () => {
    // Without a bound this table keeps every past version of a long description for ever, and the
    // endpoint hands them back. A cap and not a hash: a hash bounds the growth and destroys the one
    // thing the row is for -- saying what it used to say.
    const long = 'x'.repeat(FIELD_AUDIT_VALUE_MAX + 250)
    updateKanbanCard('c1', { description: long }, { actor: 'someone' })
    const stored = getKanbanCardFieldEvents('c1')[0]!.new_value!
    expect(stored.length).toBeLessThan(long.length)
    expect(stored).toContain('levágva') // a truncated value must not read as the whole one
  })

  it('F-3 a value at the limit is stored WHOLE -- the cap must not clip what fits', () => {
    const exact = 'y'.repeat(FIELD_AUDIT_VALUE_MAX)
    updateKanbanCard('c1', { description: exact }, { actor: 'someone' })
    expect(getKanbanCardFieldEvents('c1')[0]!.new_value).toBe(exact)
  })
})

describe('F-2: a fleet transfer carries the field trail, not just the status one (card 7fd6dd23)', () => {
  // A SHAPE test on the source, deliberately, and I say so rather than implying more: importFleet
  // needs a live DB and filesystem, so the existing suite drives it with mocked modules and fixture
  // payloads. What can be asserted cheaply and still means something is that both halves name the
  // table -- an export that reads it and an import that writes it. Without both, a restored board
  // would look fully attributed while every pre-transfer edit had silently vanished.
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'fleet-transfer.ts'),
    'utf-8',
  )
  const exec = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')

  it('the export READS the table', () => {
    expect(exec).toMatch(/SELECT \* FROM kanban_card_field_events/)
  })

  it('the import WRITES it, idempotently on (card_id, created_at, field)', () => {
    expect(exec).toMatch(/INSERT INTO kanban_card_field_events/)
    expect(exec).toMatch(/SELECT 1 FROM kanban_card_field_events WHERE card_id = \? AND created_at = \? AND field = \?/)
  })

  it('the payload key is OPTIONAL, so an export taken before this existed still imports', () => {
    // The existing fleet-transfer fixtures have no cardFieldEvents key at all. If the field were
    // required, this change would break every stored export rather than extend it.
    expect(SRC).toMatch(/cardFieldEvents\?:/)
    expect(exec).toMatch(/fleet\.kanban\?\.cardFieldEvents \?\? \[\]/)
  })
})
