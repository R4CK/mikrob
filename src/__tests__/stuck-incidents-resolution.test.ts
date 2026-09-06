// Card d05d72b3 (3/4, parent f92671df): resolve an open stuck_incidents row from data the app
// ALREADY writes, instead of a new explicit "resolve" call a caller has to remember to make --
// the read-side mirror of 878cd292's writer, same "structural, not disciplinary" reasoning
// (code-quality rule 6).
//
// What these pin, and why each is here rather than being obvious:
//   - QUALIFYING EVENTS ONLY, exactly as the card names them: a status transition to `waiting` or
//     `done` (kanban_card_events), or a `title`/`assignee` change (kanban_card_field_events). Every
//     OTHER field change and status value is a negative control -- without them, a writer that
//     resolves on ANY write at all would pass every positive case here too.
//   - THE NEGATIVE CONTROL THE CARD ITSELF NAMES: an event before detection must not resolve it.
//   - ONE RESOLUTION PER INCIDENT: a second qualifying event after the first is a no-op, proven via
//     the REAL write paths (updateKanbanCard/moveKanbanCard), not a reimplementation of the WHERE
//     clause.
//   - TRACEABLE, not just timestamped: resolved_by_event_id alone cannot say which table to look
//     in (both have independent autoincrement id spaces), so resolved_by_event_table is asserted
//     everywhere resolved_by_event_id is.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createKanbanCard,
  updateKanbanCard,
  moveKanbanCard,
  recordStuckIncident,
  maybeResolveStuckIncident,
  initDatabase,
  getDb,
} from '../db.js'

const tmpDirs: string[] = []
function freshDb(): void {
  const dir = mkdtempSync(join(tmpdir(), 'stuck-resolution-'))
  tmpDirs.push(dir)
  initDatabase(join(dir, 'test.db'))
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

/** Detection happens well in the past, so any write the test makes right now is naturally AFTER
 *  it -- no clock mocking needed. */
const PAST_DETECTED_AT = Math.floor(Date.now() / 1000) - 3600

function seedStuckCard(cardId: string): void {
  createKanbanCard({ id: cardId, title: '[10%] a stuck card', status: 'in_progress', assignee: 'backend3' })
  const r = recordStuckIncident({
    cardId,
    assignee: 'backend3',
    verdict: 'DENY:agent-busy',
    detectedAt: PAST_DETECTED_AT,
    stalledMs: 900_000,
  })
  expect(r.kind).toBe('opened')
}

function openIncidentRow(cardId: string): Record<string, unknown> {
  return getDb()
    .prepare(`SELECT * FROM stuck_incidents WHERE card_id = ?`)
    .get(cardId) as Record<string, unknown>
}

describe('maybeResolveStuckIncident -- the boundary condition, in isolation', () => {
  it('an event BEFORE detection does not resolve (the negative control the card names)', () => {
    freshDb()
    seedStuckCard('c1')
    maybeResolveStuckIncident('c1', 'kanban_card_events', 999, PAST_DETECTED_AT - 10)
    const row = openIncidentRow('c1')
    expect(row['resolved_at']).toBeNull()
    expect(row['resolved_by_event_id']).toBeNull()
  })

  it('an event AFTER detection resolves, recording both the id and which table', () => {
    freshDb()
    seedStuckCard('c1')
    const at = PAST_DETECTED_AT + 10
    maybeResolveStuckIncident('c1', 'kanban_card_field_events', 42, at)
    const row = openIncidentRow('c1')
    expect(row['resolved_at']).toBe(at)
    expect(row['resolved_by_event_id']).toBe(42)
    expect(row['resolved_by_event_table']).toBe('kanban_card_field_events')
  })

  it('an event at EXACTLY detected_at does not resolve -- strictly after, not at-or-after', () => {
    freshDb()
    seedStuckCard('c1')
    maybeResolveStuckIncident('c1', 'kanban_card_events', 1, PAST_DETECTED_AT)
    expect(openIncidentRow('c1')['resolved_at']).toBeNull()
  })

  it('a second qualifying call is a no-op -- the first resolution is not overwritten', () => {
    freshDb()
    seedStuckCard('c1')
    const first = PAST_DETECTED_AT + 10
    maybeResolveStuckIncident('c1', 'kanban_card_events', 7, first)
    maybeResolveStuckIncident('c1', 'kanban_card_field_events', 8, first + 100)
    const row = openIncidentRow('c1')
    expect(row['resolved_at']).toBe(first)
    expect(row['resolved_by_event_id']).toBe(7)
    expect(row['resolved_by_event_table']).toBe('kanban_card_events')
  })

  it('does not throw when the table is missing -- same fail-safe posture as the writer side', () => {
    freshDb()
    getDb().exec(`DROP TABLE stuck_incidents`)
    expect(() => maybeResolveStuckIncident('c1', 'kanban_card_events', 1, PAST_DETECTED_AT + 1)).not.toThrow()
  })
})

describe('resolution via the REAL write path -- updateKanbanCard', () => {
  it('a status change to DONE resolves, via kanban_card_events', () => {
    freshDb()
    seedStuckCard('c1')
    updateKanbanCard('c1', { status: 'done' }, { actor: 'backend3' })
    const row = openIncidentRow('c1')
    expect(row['resolved_at']).not.toBeNull()
    expect(row['resolved_by_event_table']).toBe('kanban_card_events')
    const eventRow = getDb()
      .prepare(`SELECT to_status FROM kanban_card_events WHERE id = ?`)
      .get(row['resolved_by_event_id']) as { to_status: string }
    expect(eventRow.to_status).toBe('done')
  })

  it('a status change to WAITING resolves too', () => {
    freshDb()
    seedStuckCard('c1')
    updateKanbanCard('c1', { status: 'waiting' }, { actor: 'backend3' })
    expect(openIncidentRow('c1')['resolved_at']).not.toBeNull()
  })

  it('a status change to PLANNED does NOT resolve -- only waiting/done qualify', () => {
    freshDb()
    seedStuckCard('c1')
    updateKanbanCard('c1', { status: 'planned' }, { actor: 'backend3' })
    expect(openIncidentRow('c1')['resolved_at']).toBeNull()
  })

  it('a TITLE change ([NN%] progress) resolves, via kanban_card_field_events', () => {
    freshDb()
    seedStuckCard('c1')
    updateKanbanCard('c1', { title: '[55%] a stuck card' }, { actor: 'backend3' })
    const row = openIncidentRow('c1')
    expect(row['resolved_at']).not.toBeNull()
    expect(row['resolved_by_event_table']).toBe('kanban_card_field_events')
    const eventRow = getDb()
      .prepare(`SELECT field FROM kanban_card_field_events WHERE id = ?`)
      .get(row['resolved_by_event_id']) as { field: string }
    expect(eventRow.field).toBe('title')
  })

  it('an ASSIGNEE change resolves too', () => {
    freshDb()
    seedStuckCard('c1')
    updateKanbanCard('c1', { assignee: 'backend2' }, { actor: 'backend3' })
    const row = openIncidentRow('c1')
    expect(row['resolved_at']).not.toBeNull()
    const eventRow = getDb()
      .prepare(`SELECT field FROM kanban_card_field_events WHERE id = ?`)
      .get(row['resolved_by_event_id']) as { field: string }
    expect(eventRow.field).toBe('assignee')
  })

  it('a DESCRIPTION change does NOT resolve -- only title/assignee qualify among field changes', () => {
    freshDb()
    seedStuckCard('c1')
    updateKanbanCard('c1', { description: 'new text' }, { actor: 'backend3' })
    expect(openIncidentRow('c1')['resolved_at']).toBeNull()
    // CONTROL: the field event itself WAS written (the audit trail is unaffected), it is simply
    // not a qualifying one for resolution -- distinguishes "not resolved" from "nothing happened".
    expect(
      getDb().prepare(`SELECT COUNT(*) c FROM kanban_card_field_events WHERE card_id='c1' AND field='description'`).get(),
    ).toEqual({ c: 1 })
  })

  it('a second qualifying update (status AND title in one PUT) resolves ONCE, not twice', () => {
    freshDb()
    seedStuckCard('c1')
    updateKanbanCard('c1', { status: 'done', title: '[100%] done' }, { actor: 'backend3' })
    const row = openIncidentRow('c1')
    expect(row['resolved_at']).not.toBeNull()
    // Whichever of the two won the resolution, only ONE row's worth of resolution state exists --
    // the assertion is on the incident, not on which of the two candidate events was credited.
    expect(
      getDb().prepare(`SELECT COUNT(*) c FROM stuck_incidents WHERE card_id='c1' AND resolved_at IS NOT NULL`).get(),
    ).toEqual({ c: 1 })
  })

  it('does not resolve an ALREADY-CLOSED incident on a later card touch', () => {
    freshDb()
    seedStuckCard('c1')
    updateKanbanCard('c1', { status: 'done' }, { actor: 'backend3' })
    const firstResolvedAt = openIncidentRow('c1')['resolved_at']
    updateKanbanCard('c1', { title: '[100%] done, touched again' }, { actor: 'backend3' })
    expect(openIncidentRow('c1')['resolved_at']).toBe(firstResolvedAt)
  })
})

describe('resolution via the REAL write path -- moveKanbanCard (the drag/move path)', () => {
  it('a move to DONE resolves too -- the other live writer of a status transition', () => {
    freshDb()
    seedStuckCard('c1')
    expect(moveKanbanCard('c1', 'done', 0, 'backend3')).toBe(true)
    expect(openIncidentRow('c1')['resolved_by_event_table']).toBe('kanban_card_events')
  })

  it('a move to IN_PROGRESS (unchanged-status reorder aside) does not resolve', () => {
    freshDb()
    seedStuckCard('c1')
    expect(moveKanbanCard('c1', 'in_progress', 1, 'backend3')).toBe(true)
    expect(openIncidentRow('c1')['resolved_at']).toBeNull()
  })
})

describe('resolution scope -- independent per card, and does not touch a resolved incident\'s facts', () => {
  it('two different cards each resolve independently', () => {
    freshDb()
    seedStuckCard('c1')
    seedStuckCard('c2')
    updateKanbanCard('c1', { status: 'done' }, { actor: 'backend3' })
    expect(openIncidentRow('c1')['resolved_at']).not.toBeNull()
    expect(openIncidentRow('c2')['resolved_at']).toBeNull()
  })

  it('resolving does not touch the append-only detection facts', () => {
    freshDb()
    seedStuckCard('c1')
    updateKanbanCard('c1', { status: 'done' }, { actor: 'backend3' })
    const row = openIncidentRow('c1')
    expect(row['action']).toBe('none_denied')
    expect(row['action_detail']).toBe('DENY:agent-busy')
    expect(row['detected_at']).toBe(PAST_DETECTED_AT)
  })
})
