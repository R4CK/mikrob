// Card 5003f37e: the storage layer behind the self-advance half of 900178fa's /clear-enforcement.
// Runs against an in-memory database seeded with the PRODUCTION schema, through the real exported
// functions, in the same shape as kanban-dependencies.test.ts.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase,
  createKanbanCard,
  moveKanbanCard,
  priorInProgressCardForActor,
  setPendingSelfAdvanceClear,
  getPendingSelfAdvanceClears,
  clearPendingSelfAdvanceClear,
} from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
  createKanbanCard({ id: 'a', title: 'A', assignee: 'backend2' })
  createKanbanCard({ id: 'b', title: 'B', assignee: 'backend2' })
})

describe('priorInProgressCardForActor', () => {
  it('is null when the actor never moved anything to in_progress', () => {
    expect(priorInProgressCardForActor('backend2')).toBeNull()
  })

  it('is still null right after the FIRST in_progress move by this actor -- the OFFSET skips the just-inserted row for this same move', () => {
    moveKanbanCard('a', 'in_progress', 0, 'backend2')
    expect(priorInProgressCardForActor('backend2')).toBeNull()
  })

  it('names the SAME card on a reopen (moved to in_progress twice in a row, e.g. a gate FAIL re-dispatch)', () => {
    moveKanbanCard('a', 'in_progress', 0, 'backend2')
    moveKanbanCard('a', 'waiting', 0, 'backend2')
    // force:true stands in for the real unblock (a gate-FAIL verdict comment, per
    // reviewedCardBlocksInProgress) -- irrelevant to what THIS function measures, which is purely
    // "what did the events table record", not the reopen guard itself.
    moveKanbanCard('a', 'in_progress', 0, 'backend2', true)
    expect(priorInProgressCardForActor('backend2')).toBe('a')
  })

  it('names the PREVIOUS card on a genuine switch to a different one', () => {
    moveKanbanCard('a', 'in_progress', 0, 'backend2')
    moveKanbanCard('a', 'waiting', 0, 'backend2')
    moveKanbanCard('b', 'in_progress', 0, 'backend2')
    expect(priorInProgressCardForActor('backend2')).toBe('a')
  })

  it('ignores a DIFFERENT actor entirely', () => {
    moveKanbanCard('a', 'in_progress', 0, 'backend2')
    moveKanbanCard('a', 'waiting', 0, 'backend2')
    createKanbanCard({ id: 'c', title: 'C', assignee: 'qa' })
    moveKanbanCard('c', 'in_progress', 0, 'qa')
    expect(priorInProgressCardForActor('qa')).toBeNull()
  })

  it('ignores a move with no recorded actor', () => {
    moveKanbanCard('a', 'in_progress', 0)
    expect(priorInProgressCardForActor('backend2')).toBeNull()
  })
})

describe('agent_pending_clear (setPendingSelfAdvanceClear / getPendingSelfAdvanceClears / clearPendingSelfAdvanceClear)', () => {
  it('starts empty', () => {
    expect(getPendingSelfAdvanceClears()).toEqual([])
  })

  it('records one row per agent', () => {
    setPendingSelfAdvanceClear('backend2', 'b', 1000)
    const rows = getPendingSelfAdvanceClears()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent_id: 'backend2', card_id: 'b', set_at: 1000 })
  })

  it('a second switch for the SAME agent before the first clear lands overwrites the debt, not adds a second one', () => {
    setPendingSelfAdvanceClear('backend2', 'a', 1000)
    setPendingSelfAdvanceClear('backend2', 'b', 2000)
    const rows = getPendingSelfAdvanceClears()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent_id: 'backend2', card_id: 'b', set_at: 2000 })
  })

  it('tracks separate agents independently', () => {
    setPendingSelfAdvanceClear('backend2', 'a', 1000)
    setPendingSelfAdvanceClear('qa', 'c', 1500)
    expect(getPendingSelfAdvanceClears().map((r) => r.agent_id).sort()).toEqual(['backend2', 'qa'])
  })

  it('clearPendingSelfAdvanceClear removes the row and reports true', () => {
    setPendingSelfAdvanceClear('backend2', 'b', 1000)
    expect(clearPendingSelfAdvanceClear('backend2', 'b')).toBe(true)
    expect(getPendingSelfAdvanceClears()).toEqual([])
  })

  it('CONTROL: clearing a card_id that no longer matches the current debt does nothing (a newer switch overwrote it) -- returns false and the newer debt survives', () => {
    setPendingSelfAdvanceClear('backend2', 'a', 1000)
    setPendingSelfAdvanceClear('backend2', 'b', 2000) // overwritten before the watcher delivered 'a'
    expect(clearPendingSelfAdvanceClear('backend2', 'a')).toBe(false)
    expect(getPendingSelfAdvanceClears()).toEqual([{ agent_id: 'backend2', card_id: 'b', set_at: 2000 }])
  })

  it('clearing a nonexistent agent is a no-op, reports false', () => {
    expect(clearPendingSelfAdvanceClear('nobody', 'x')).toBe(false)
  })
})
