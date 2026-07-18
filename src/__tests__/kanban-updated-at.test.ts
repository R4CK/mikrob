// Regression guard for the kanban `updated_at` write-path (card c2523659).
//
// Context: the card flagged ~669 done cards showing updated_at = 2000-01-01 and a worry that a
// stuck-monitor keying on updated_at WITHOUT a status filter could false-flag done cards. Diagnosis:
//   - every stuck/audit monitor already filters status='in_progress' (stuck-card-monitor,
//     folyamatos-munka-orchestrator, kanban-audit), so done cards are never staleness-checked;
//   - the live DB no longer has ANY sentinel rows (all 763 cards have a sane updated_at);
//   - the write-paths (create/move/comment/update) all stamp updated_at = now.
// The 2000-01-01 rows were legacy/pre-migration data, now clean. This test LOCKS IN the write-path
// behaviour so a future refactor cannot silently reintroduce a stale/sentinel updated_at (which is
// what the monitors depend on to tell "moving" from "stuck"). Uses an in-memory DB -- never the live
// store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addKanbanComment,
  createKanbanCard,
  getKanbanCard,
  initDatabase,
  moveKanbanCard,
  updateKanbanCard,
} from '../db.js'

const secOf = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000)
const at = (iso: string): void => {
  vi.setSystemTime(new Date(iso))
}

describe('kanban updated_at write-path (card c2523659)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    initDatabase(':memory:')
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('createKanbanCard stamps updated_at = now (never a 2000-01-01 sentinel)', () => {
    at('2026-07-18T10:00:00.000Z')
    createKanbanCard({ id: 'C1', title: 'card', status: 'planned' })
    const card = getKanbanCard('C1')!
    expect(card.updated_at).toBe(secOf('2026-07-18T10:00:00.000Z'))
    // the exact failure the card reported: a pre-2020 sentinel updated_at
    expect(card.updated_at).toBeGreaterThan(secOf('2020-01-01T00:00:00.000Z'))
  })

  it('moveKanbanCard refreshes updated_at to now (so an active card is never seen as stuck)', () => {
    at('2026-07-18T10:00:00.000Z')
    createKanbanCard({ id: 'C2', title: 'card', status: 'planned' })
    at('2026-07-18T10:05:00.000Z')
    moveKanbanCard('C2', 'in_progress', 0, 'backend')
    expect(getKanbanCard('C2')!.updated_at).toBe(secOf('2026-07-18T10:05:00.000Z'))
  })

  it('addKanbanComment refreshes the card updated_at to now', () => {
    at('2026-07-18T10:00:00.000Z')
    createKanbanCard({ id: 'C3', title: 'card', status: 'in_progress' })
    at('2026-07-18T11:00:00.000Z')
    addKanbanComment('C3', 'backend', 'REVIEW: kesz')
    expect(getKanbanCard('C3')!.updated_at).toBe(secOf('2026-07-18T11:00:00.000Z'))
  })

  it('updateKanbanCard refreshes updated_at to now', () => {
    at('2026-07-18T10:00:00.000Z')
    createKanbanCard({ id: 'C4', title: 'card', status: 'planned' })
    at('2026-07-18T12:00:00.000Z')
    updateKanbanCard('C4', { title: 'renamed' })
    expect(getKanbanCard('C4')!.updated_at).toBe(secOf('2026-07-18T12:00:00.000Z'))
  })
})
