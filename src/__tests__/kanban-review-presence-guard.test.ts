// Card 18fbb3a8 (F3.1 follow-up): server-side, warn-only check that a transition to `waiting`
// carries a recent REVIEW comment from the card's own assignee. Mirrors the mock shape of
// kanban-spec-template-guard.test.ts -- same guard family, same fail-open-on-error discipline.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const card = {
  id: 'c1',
  title: 'cim',
  status: 'waiting' as string,
  assignee: 'backend' as string | null,
}
let comments: Array<{ author: string; content: string; created_at: number }> = []
const addedComments: Array<{ cardId: string; author: string; content: string }> = []

vi.mock('../db.js', () => ({
  getKanbanCard: (id: string) => {
    if (id === 'throws') throw new Error('db unavailable')
    return id === card.id ? card : undefined
  },
  getKanbanComments: () => comments,
  addKanbanComment: (cardId: string, author: string, content: string) => {
    addedComments.push({ cardId, author, content })
  },
}))
vi.mock('../logger.js', () => ({
  logger: { warn: () => {}, info: () => {} },
}))

const { reviewPresenceGuardCheck, hasRecentReviewFrom } = await import(
  '../web/kanban-review-presence-guard.js'
)

beforeEach(() => {
  card.title = 'cim'
  card.assignee = 'backend'
  comments = []
  addedComments.length = 0
  delete process.env.REVIEW_PRESENCE_GUARD
})

describe('hasRecentReviewFrom (pure)', () => {
  it('true for a fresh REVIEW from the right author', () => {
    const now = 1_000_000
    const cs = [{ author: 'backend', content: 'REVIEW: done.\nGate-SHA: abc', created_at: now - 60 }]
    expect(hasRecentReviewFrom(cs, 'backend', now)).toBe(true)
  })

  it('false when the REVIEW is older than the window', () => {
    const now = 1_000_000
    const cs = [{ author: 'backend', content: 'REVIEW: done.', created_at: now - 2000 }]
    expect(hasRecentReviewFrom(cs, 'backend', now)).toBe(false)
  })

  it('false when the REVIEW is from a different author', () => {
    const now = 1_000_000
    const cs = [{ author: 'qa', content: 'REVIEW: done.', created_at: now - 60 }]
    expect(hasRecentReviewFrom(cs, 'backend', now)).toBe(false)
  })

  it('false when "review" only appears mid-sentence, not as a line marker', () => {
    const now = 1_000_000
    const cs = [{ author: 'backend', content: "don't forget the REVIEW: line next time", created_at: now - 60 }]
    // not line-anchored -- this text does not start with the marker on its own line
    expect(hasRecentReviewFrom(cs, 'backend', now)).toBe(false)
  })

  it('a REVIEW comment later in a multi-line body still counts (marker is per-line, not file-start-only)', () => {
    const now = 1_000_000
    const cs = [{ author: 'backend', content: 'intro line\nREVIEW: done.', created_at: now - 60 }]
    expect(hasRecentReviewFrom(cs, 'backend', now)).toBe(true)
  })

  it('false when the comment timestamp is in the future relative to now', () => {
    const now = 1_000_000
    const cs = [{ author: 'backend', content: 'REVIEW: done.', created_at: now + 60 }]
    expect(hasRecentReviewFrom(cs, 'backend', now)).toBe(false)
  })
})

describe('reviewPresenceGuardCheck (side effect, warn-only)', () => {
  it('does nothing when nextStatus is not waiting', () => {
    reviewPresenceGuardCheck('c1', 'in_progress', 'in_progress', 'backend')
    expect(addedComments).toHaveLength(0)
  })

  it('does nothing when prevStatus was already waiting (no real transition)', () => {
    reviewPresenceGuardCheck('c1', 'waiting', 'waiting', 'backend')
    expect(addedComments).toHaveLength(0)
  })

  it('posts a warning when moved to waiting with no recent REVIEW from the assignee', () => {
    comments = []
    reviewPresenceGuardCheck('c1', 'in_progress', 'waiting', 'backend')
    expect(addedComments).toHaveLength(1)
    expect(addedComments[0].author).toBe('review-presence-guard')
    expect(addedComments[0].content).toMatch(/WARNING/)
    expect(addedComments[0].content).toMatch(/backend/)
  })

  it('posts nothing when the assignee posted a REVIEW just before the move', () => {
    const now = Math.floor(Date.now() / 1000)
    comments = [{ author: 'backend', content: 'REVIEW: all good.\nGate-SHA: abc123', created_at: now - 30 }]
    reviewPresenceGuardCheck('c1', 'in_progress', 'waiting', 'backend')
    expect(addedComments).toHaveLength(0)
  })

  it('still warns when the only REVIEW is from a DIFFERENT author than the assignee', () => {
    const now = Math.floor(Date.now() / 1000)
    comments = [{ author: 'qa', content: 'REVIEW: all good.', created_at: now - 30 }]
    reviewPresenceGuardCheck('c1', 'in_progress', 'waiting', 'backend')
    expect(addedComments).toHaveLength(1)
  })

  it('still warns when the assignee REVIEW is stale (older than the 30-minute window)', () => {
    const now = Math.floor(Date.now() / 1000)
    comments = [{ author: 'backend', content: 'REVIEW: all good.', created_at: now - 3600 }]
    reviewPresenceGuardCheck('c1', 'in_progress', 'waiting', 'backend')
    expect(addedComments).toHaveLength(1)
  })

  it('does nothing for an unknown card', () => {
    reviewPresenceGuardCheck('nope', 'in_progress', 'waiting', 'backend')
    expect(addedComments).toHaveLength(0)
  })

  it('does nothing when the card has no assignee', () => {
    card.assignee = null
    reviewPresenceGuardCheck('c1', 'in_progress', 'waiting', 'backend')
    expect(addedComments).toHaveLength(0)
  })

  it('fails open (no throw, no side effect) when the db lookup throws', () => {
    expect(() => reviewPresenceGuardCheck('throws', 'in_progress', 'waiting', 'backend')).not.toThrow()
    expect(addedComments).toHaveLength(0)
  })

  it('is fully disabled via REVIEW_PRESENCE_GUARD=off', () => {
    process.env.REVIEW_PRESENCE_GUARD = 'off'
    comments = []
    reviewPresenceGuardCheck('c1', 'in_progress', 'waiting', 'backend')
    expect(addedComments).toHaveLength(0)
  })
})
