// getStuckKanbanCards -- card 7b0b822f: upstream's PULL-based "started-then-idle" scan, kept
// deliberately SEPARATE from the event-driven stuck_incidents mechanism (see db.ts's own comment on
// the function for the full reasoning). These tests pin:
//   - scope is status === 'in_progress' only (planned/waiting/testing/done/archived excluded)
//   - idle time is measured from the LATER of last_status_at and the most recent NON-automated
//     comment -- an automated:true comment must NOT count as activity
//   - the threshold is a strict >= cutoff, overridable per call (never hardcoded in the test)
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb, createKanbanCard, getStuckKanbanCards } from '../db.js'

const tmpDirs: string[] = []
function freshDb(): void {
  const dir = mkdtempSync(join(tmpdir(), 'stuck-kanban-'))
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

function insertCardAt(id: string, status: string, createdAt: number, assignee: string | null = 'backend'): void {
  createKanbanCard({ id, title: `card ${id}`, status: status as never, assignee: assignee ?? undefined })
  getDb().prepare('UPDATE kanban_cards SET created_at = ?, updated_at = ? WHERE id = ?').run(createdAt, createdAt, id)
}

function insertStatusEvent(cardId: string, toStatus: string, createdAt: number): void {
  getDb()
    .prepare(
      `INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at, forced)
       VALUES (?, 'planned', ?, 'backend', ?, 0)`,
    )
    .run(cardId, toStatus, createdAt)
}

function insertComment(cardId: string, createdAt: number, automated: boolean): void {
  getDb()
    .prepare(`INSERT INTO kanban_comments (card_id, author, content, created_at, automated) VALUES (?, 'x', 'y', ?, ?)`)
    .run(cardId, createdAt, automated ? 1 : 0)
}

describe('getStuckKanbanCards -- scope', () => {
  it('includes an in_progress card idle past the threshold', () => {
    freshDb()
    insertCardAt('c1', 'in_progress', 1_000)
    const result = getStuckKanbanCards(2_000, 600)
    expect(result.map((r) => r.cardId)).toEqual(['c1'])
    expect(result[0]).toMatchObject({ cardId: 'c1', lastActivityAt: 1_000, idleSeconds: 1_000 })
  })

  it.each(['planned', 'waiting', 'testing', 'done'])('excludes a %s card regardless of idle time', (status) => {
    freshDb()
    insertCardAt('c1', status, 1_000)
    const result = getStuckKanbanCards(999_999, 600)
    expect(result).toHaveLength(0)
  })

  it('excludes an archived in_progress card', () => {
    freshDb()
    insertCardAt('c1', 'in_progress', 1_000)
    getDb().prepare('UPDATE kanban_cards SET archived_at = ? WHERE id = ?').run(1_500, 'c1')
    const result = getStuckKanbanCards(999_999, 600)
    expect(result).toHaveLength(0)
  })

  it('excludes a card below the idle threshold', () => {
    freshDb()
    insertCardAt('c1', 'in_progress', 1_000)
    const result = getStuckKanbanCards(1_599, 600) // 599s idle, just under 600
    expect(result).toHaveLength(0)
  })

  it('is a strict >= cutoff at the exact threshold', () => {
    freshDb()
    insertCardAt('c1', 'in_progress', 1_000)
    const result = getStuckKanbanCards(1_600, 600) // exactly 600s idle
    expect(result).toHaveLength(1)
  })
})

describe('getStuckKanbanCards -- activity clock', () => {
  it('uses the LAST status-change event, not created_at, when the card has moved', () => {
    freshDb()
    insertCardAt('c1', 'in_progress', 1_000)
    insertStatusEvent('c1', 'in_progress', 5_000) // moved later than creation
    const result = getStuckKanbanCards(6_000, 600)
    expect(result[0]).toMatchObject({ lastActivityAt: 5_000, idleSeconds: 1_000 })
  })

  it('a recent NON-automated comment resets the idle clock (excludes the card)', () => {
    freshDb()
    insertCardAt('c1', 'in_progress', 1_000)
    insertComment('c1', 5_000, false)
    const result = getStuckKanbanCards(5_300, 600) // only 300s since the real comment
    expect(result).toHaveLength(0)
  })

  it('an automated:true comment does NOT reset the idle clock -- the card still shows stuck', () => {
    freshDb()
    insertCardAt('c1', 'in_progress', 1_000)
    insertComment('c1', 5_000, true) // bulk/machine comment, recent
    const result = getStuckKanbanCards(5_300, 600) // 4300s since real start, well past threshold
    expect(result.map((r) => r.cardId)).toEqual(['c1'])
    expect(result[0]).toMatchObject({ lastActivityAt: 1_000, idleSeconds: 4_300 })
  })

  it('uses the MOST RECENT non-automated comment when there are several', () => {
    freshDb()
    insertCardAt('c1', 'in_progress', 1_000)
    insertComment('c1', 2_000, false)
    insertComment('c1', 9_000, false)
    const result = getStuckKanbanCards(9_300, 600)
    expect(result).toHaveLength(0) // only 300s since the latest real comment
  })
})

describe('getStuckKanbanCards -- ordering and shape', () => {
  it('sorts most-idle first and carries assignee/title', () => {
    freshDb()
    insertCardAt('c1', 'in_progress', 1_000, 'backend')
    insertCardAt('c2', 'in_progress', 500, 'qa')
    const result = getStuckKanbanCards(2_000, 600)
    expect(result.map((r) => r.cardId)).toEqual(['c2', 'c1']) // c2 idle longer (1500s > 1000s)
    expect(result[1]).toMatchObject({ cardId: 'c1', title: 'card c1', assignee: 'backend' })
  })
})
