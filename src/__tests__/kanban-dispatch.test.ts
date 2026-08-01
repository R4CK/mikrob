import { describe, it, expect } from 'vitest'
import { resolveKanbanDispatchTarget } from '../kanban-dispatch.js'

const base = {
  ownerName: 'Gábor',
  botName: 'GorcsevIvan',
  mainAgentId: 'gorcsevivan',
  agentNames: ['tuskohopkins', 'sentinel'],
  isRunning: (n: string) => n === 'tuskohopkins', // only tuskohopkins is "running"
}

describe('resolveKanbanDispatchTarget', () => {
  it('returns null for empty / null / undefined / whitespace assignee', () => {
    expect(resolveKanbanDispatchTarget(null, base)).toBeNull()
    expect(resolveKanbanDispatchTarget(undefined, base)).toBeNull()
    expect(resolveKanbanDispatchTarget('', base)).toBeNull()
    expect(resolveKanbanDispatchTarget('   ', base)).toBeNull()
  })

  it('never dispatches to the human owner', () => {
    expect(resolveKanbanDispatchTarget('Gábor', base)).toBeNull()
  })

  it('maps the bot display name to the main agent id', () => {
    expect(resolveKanbanDispatchTarget('GorcsevIvan', base)).toBe('gorcsevivan')
  })

  it('maps the canonical main agent id to itself', () => {
    expect(resolveKanbanDispatchTarget('gorcsevivan', base)).toBe('gorcsevivan')
  })

  it('matches the bot/main case-insensitively', () => {
    expect(resolveKanbanDispatchTarget('gorcsevIVAN', base)).toBe('gorcsevivan')
    expect(resolveKanbanDispatchTarget('GORCSEVIVAN', base)).toBe('gorcsevivan')
  })

  it('dispatches to a sub-agent only when its session is running', () => {
    expect(resolveKanbanDispatchTarget('tuskohopkins', base)).toBe('tuskohopkins')
    expect(resolveKanbanDispatchTarget('sentinel', base)).toBeNull() // not running -> silent no-op
  })

  it('matches sub-agent names case-insensitively', () => {
    expect(resolveKanbanDispatchTarget('TuskoHopkins', base)).toBe('tuskohopkins')
  })

  it('returns null for an unknown assignee name', () => {
    expect(resolveKanbanDispatchTarget('SomebodyElse', base)).toBeNull()
  })
})

// Self-advance echo suppression (card 7a033f8d): when the agent that moved a card to in_progress IS
// its own assignee, the kanban->agent dispatch is a delayed echo of the agent's own decision and must
// be suppressed. The predicate is fail-safe: only an explicit actor==assignee match suppresses.
import { isSelfAdvanceMove } from '../kanban-dispatch.js'

describe('isSelfAdvanceMove', () => {
  it('is TRUE when the actor equals the assignee (self-advance)', () => {
    expect(isSelfAdvanceMove('backend2', 'backend2')).toBe(true)
  })

  it('matches case- and whitespace-insensitively', () => {
    expect(isSelfAdvanceMove(' Backend2 ', 'backend2')).toBe(true)
    expect(isSelfAdvanceMove('QA', 'qa')).toBe(true)
  })

  it('is FALSE when a DIFFERENT actor moved the card (a real dispatch, e.g. MikroB)', () => {
    expect(isSelfAdvanceMove('backend2', 'mikrob')).toBe(false)
  })

  it('FAILS SAFE to false when the actor is missing -- the normal dispatch still fires', () => {
    expect(isSelfAdvanceMove('backend2', undefined)).toBe(false)
    expect(isSelfAdvanceMove('backend2', null)).toBe(false)
    expect(isSelfAdvanceMove('backend2', '')).toBe(false)
    expect(isSelfAdvanceMove('backend2', '   ')).toBe(false)
  })

  it('is false when the assignee is missing (nothing to compare against)', () => {
    expect(isSelfAdvanceMove(undefined, 'backend2')).toBe(false)
    expect(isSelfAdvanceMove('', 'backend2')).toBe(false)
    expect(isSelfAdvanceMove(null, null)).toBe(false)
  })
})
