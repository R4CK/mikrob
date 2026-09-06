// getStuckIncidentAnswers -- card a2c452ff (4/4, parent f92671df): the card's own four questions,
// answered from ONE call against data 878cd292 (detection) and d05d72b3 (resolution) already write.
//
// What these pin, and why each is here rather than being obvious:
//   - DURATION IS COMPUTED, NEVER STORED (the card's own constraint): resolvedAt - detectedAt for a
//     resolved incident, now - detectedAt while still open. A duplicated column would drift from the
//     two timestamps that are the actual source of truth.
//   - "WHAT RESOLVED IT" IS A JOIN, not the bare id: resolved_by_event_id alone cannot say which
//     table to read (see recordSiblingHandover's own comment) -- the description is built from the
//     ACTUAL resolving row's own columns.
//   - THE TWO REPEAT COUNTS ARE INDEPENDENT of whichever OTHER filter is also passed: asking "how
//     often has this card been stuck" must not silently narrow to "...under the one agent you also
//     happened to filter on".
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initDatabase,
  getDb,
  recordStuckIncident,
  recordSiblingHandover,
  maybeResolveStuckIncident,
  getStuckIncidentAnswers,
} from '../db.js'

const tmpDirs: string[] = []
function freshDb(): void {
  const dir = mkdtempSync(join(tmpdir(), 'stuck-query-'))
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

describe('getStuckIncidentAnswers -- Q1/Q2: when, and for how long', () => {
  it('an OPEN incident reports its detection time and an ONGOING duration measured against `nowSec`', () => {
    freshDb()
    recordStuckIncident({
      cardId: 'c1', assignee: 'backend3', verdict: 'DENY:agent-busy',
      detectedAt: 1_000, stalledMs: 1,
    })
    const { incidents } = getStuckIncidentAnswers({ cardId: 'c1', nowSec: 1_500 })
    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toMatchObject({ detectedAt: 1_000, ongoing: true, resolvedAt: null, durationSeconds: 500 })
  })

  it('a RESOLVED incident reports the fixed duration, independent of `nowSec`', () => {
    freshDb()
    recordStuckIncident({
      cardId: 'c1', assignee: 'backend3', verdict: 'DENY:agent-busy',
      detectedAt: 1_000, stalledMs: 1,
    })
    maybeResolveStuckIncident('c1', 'kanban_card_events', 999, 1_300)
    const { incidents } = getStuckIncidentAnswers({ cardId: 'c1', nowSec: 999_999 }) // nowSec must not matter
    expect(incidents[0]).toMatchObject({ ongoing: false, resolvedAt: 1_300, durationSeconds: 300 })
  })
})

describe('getStuckIncidentAnswers -- Q3: what resolved it, joined from the actual event', () => {
  it('describes a kanban_card_events resolution from the REAL row, not the bare id', () => {
    freshDb()
    const db = getDb()
    const ev = db
      .prepare(
        `INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at, forced)
         VALUES ('c1', 'in_progress', 'done', 'backend3', 1300, 0)`,
      )
      .run()
    recordStuckIncident({
      cardId: 'c1', assignee: 'backend3', verdict: 'DENY:agent-busy', detectedAt: 1_000, stalledMs: 1,
    })
    maybeResolveStuckIncident('c1', 'kanban_card_events', Number(ev.lastInsertRowid), 1_300)
    const { incidents } = getStuckIncidentAnswers({ cardId: 'c1' })
    expect(incidents[0]!.resolution).toMatchObject({
      table: 'kanban_card_events',
      eventId: Number(ev.lastInsertRowid),
      description: 'status: in_progress -> done',
    })
  })

  it('describes a kanban_card_field_events resolution (title/[NN%]) from the REAL row', () => {
    freshDb()
    const db = getDb()
    const ev = db
      .prepare(
        `INSERT INTO kanban_card_field_events (card_id, field, old_value, new_value, actor, created_at)
         VALUES ('c1', 'title', '[10%] x', '[55%] x', 'backend3', 1300)`,
      )
      .run()
    recordStuckIncident({
      cardId: 'c1', assignee: 'backend3', verdict: 'DENY:progress', detectedAt: 1_000, stalledMs: 1,
    })
    maybeResolveStuckIncident('c1', 'kanban_card_field_events', Number(ev.lastInsertRowid), 1_300)
    const { incidents } = getStuckIncidentAnswers({ cardId: 'c1' })
    expect(incidents[0]!.resolution).toMatchObject({
      table: 'kanban_card_field_events',
      description: 'title: [10%] x -> [55%] x',
    })
  })

  it('an OPEN incident has no resolution at all', () => {
    freshDb()
    recordStuckIncident({
      cardId: 'c1', assignee: 'backend3', verdict: 'DENY:agent-busy', detectedAt: 1_000, stalledMs: 1,
    })
    const { incidents } = getStuckIncidentAnswers({ cardId: 'c1' })
    expect(incidents[0]!.resolution).toBeNull()
  })

  it('a dangling resolution reference (the target row is gone) describes as null, does not throw', () => {
    freshDb()
    recordStuckIncident({
      cardId: 'c1', assignee: 'backend3', verdict: 'DENY:agent-busy', detectedAt: 1_000, stalledMs: 1,
    })
    maybeResolveStuckIncident('c1', 'kanban_card_events', 999_999, 1_300) // no such event row exists
    let incidents: ReturnType<typeof getStuckIncidentAnswers>['incidents'] | undefined
    expect(() => { incidents = getStuckIncidentAnswers({ cardId: 'c1' }).incidents }).not.toThrow()
    expect(incidents![0]!.resolution).toMatchObject({ eventId: 999_999, description: null })
  })

  it('a sibling_handover resolution reads back from its OWN row too (878cd292\'s writer)', () => {
    freshDb()
    recordSiblingHandover({
      cardId: 'c1', oldAgent: 'backend3', newAgent: 'backend2', detectedAt: 1_000, stalledMs: 1,
    })
    const { incidents } = getStuckIncidentAnswers({ cardId: 'c1' })
    expect(incidents[0]).toMatchObject({ action: 'sibling_handover', actionDetail: 'backend3 -> backend2' })
  })
})

describe('getStuckIncidentAnswers -- Q4: repeat counts, per axis, independent of the OTHER filter', () => {
  it('repeatCountForCard counts every incident this card has had, ignoring an agent filter', () => {
    freshDb()
    recordStuckIncident({ cardId: 'c1', assignee: 'a', verdict: 'DENY:agent-busy', detectedAt: 1, stalledMs: 1 })
    maybeResolveStuckIncident('c1', 'kanban_card_events', 1, 2)
    recordStuckIncident({ cardId: 'c1', assignee: 'b', verdict: 'DENY:agent-busy', detectedAt: 3, stalledMs: 1 })
    // Filtering by an agent that only matches ONE of the two incidents must not shrink the CARD count.
    const { repeatCountForCard } = getStuckIncidentAnswers({ cardId: 'c1', agent: 'b' })
    expect(repeatCountForCard).toBe(2)
  })

  it('repeatCountForAgent counts every incident this agent has had, across ALL cards, ignoring a cardId filter', () => {
    freshDb()
    recordStuckIncident({ cardId: 'c1', assignee: 'backend3', verdict: 'DENY:agent-busy', detectedAt: 1, stalledMs: 1 })
    maybeResolveStuckIncident('c1', 'kanban_card_events', 1, 2)
    recordStuckIncident({ cardId: 'c2', assignee: 'backend3', verdict: 'DENY:agent-busy', detectedAt: 3, stalledMs: 1 })
    const { repeatCountForAgent } = getStuckIncidentAnswers({ cardId: 'c1', agent: 'backend3' })
    expect(repeatCountForAgent).toBe(2)
  })

  it('CONTROL: both counts are null when their own filter was not given', () => {
    freshDb()
    recordStuckIncident({ cardId: 'c1', assignee: 'a', verdict: 'ALLOW', detectedAt: 1, stalledMs: 1 })
    const { repeatCountForCard, repeatCountForAgent } = getStuckIncidentAnswers({})
    expect(repeatCountForCard).toBeNull()
    expect(repeatCountForAgent).toBeNull()
  })

  it('the listed `incidents`, unlike the repeat counts, DOES apply BOTH filters together', () => {
    freshDb()
    recordStuckIncident({ cardId: 'c1', assignee: 'a', verdict: 'ALLOW', detectedAt: 1, stalledMs: 1 })
    maybeResolveStuckIncident('c1', 'kanban_card_events', 1, 2)
    recordStuckIncident({ cardId: 'c1', assignee: 'b', verdict: 'ALLOW', detectedAt: 3, stalledMs: 1 })
    const { incidents } = getStuckIncidentAnswers({ cardId: 'c1', agent: 'b' })
    expect(incidents).toHaveLength(1)
    expect(incidents[0]!.assignee).toBe('b')
  })
})

describe('getStuckIncidentAnswers -- no filters at all', () => {
  it('returns every incident, newest first', () => {
    freshDb()
    recordStuckIncident({ cardId: 'c1', assignee: 'a', verdict: 'ALLOW', detectedAt: 1, stalledMs: 1 })
    recordStuckIncident({ cardId: 'c2', assignee: 'b', verdict: 'ALLOW', detectedAt: 5, stalledMs: 1 })
    const { incidents } = getStuckIncidentAnswers({})
    expect(incidents.map((i) => i.cardId)).toEqual(['c2', 'c1'])
  })
})
