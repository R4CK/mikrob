// Card 1338e68b (codebase-auditor finding (b) on phase 4df3e8e8): the local-LLM offload's
// draft -> online-review handoff lived only in prose. MEASURED on this fleet's own board before the
// guard was written: 11 cards carrying a `local-llm` draft reached `done`, and on NINE of them no
// later comment from any other author even contained the word "draft".
//
// Same discipline as its siblings (kanban-plan-grilling-guard.test.ts, kanban-landed-guard.test.ts):
// block the one case it claims, and stay out of the way everywhere else.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const card = { id: 'c1', status: 'in_progress' as string, description: null as string | null }
let comments: Array<{ author: string; content: string; created_at: number }> = []
let throwOnCard = false
let throwOnComments = false

vi.mock('../db.js', () => ({
  getKanbanCard: () => {
    if (throwOnCard) throw new Error('db down')
    return card
  },
  getKanbanComments: () => {
    if (throwOnComments) throw new Error('db down')
    return comments
  },
}))
vi.mock('../logger.js', () => ({ logger: { warn: () => {}, info: () => {} } }))

const { draftReviewGuardVerdict, newestDraftAt, hasDraftReview, DRAFT_REVIEW_RX } = await import(
  '../web/kanban-draft-review-guard.js'
)

// The real shape store/offload-dispatch.sh posts (measured from the live board).
const DRAFT_BODY =
  '[LOCAL-LLM DRAFT | dispatch-offload] Mechanikus reszek helyi (7B) draftja. DRAFT-ONLY: MikroB + a gate ujra-ellenorzi.'
const draft = (at: number) => ({ author: 'local-llm', content: DRAFT_BODY, created_at: at })
const review = (at: number, author = 'backend2', verdict = 'ELFOGADVA') => ({
  author,
  content: `Atneztem a draftot.\nDraft-Review: ${verdict}\nA tesztek zoldek.`,
  created_at: at,
})

beforeEach(() => {
  card.status = 'in_progress'
  card.description = null
  comments = []
  throwOnCard = false
  throwOnComments = false
})

describe('DRAFT_REVIEW_RX -- the marker is line-anchored, like Gate-SHA', () => {
  it('accepts every verdict in both languages, and both accent spellings', () => {
    for (const v of ['ELFOGADVA', 'ELUTASITVA', 'ELUTASÍTVA', 'RESZBEN', 'RÉSZBEN', 'ACCEPTED', 'REJECTED', 'PARTIAL']) {
      expect(DRAFT_REVIEW_RX.test(`Draft-Review: ${v}`), v).toBe(true)
    }
  })

  it('THE POINT OF THE ANCHOR: quoting the rule mid-sentence does NOT satisfy it', () => {
    // A comment must be able to TALK about the marker without thereby satisfying the guard.
    expect(DRAFT_REVIEW_RX.test('Ne felejtsd el a Draft-Review: ELFOGADVA sort kitenni!')).toBe(false)
  })

  it('leading whitespace is fine (a quoted/indented comment block still counts)', () => {
    expect(DRAFT_REVIEW_RX.test('elozmeny\n  Draft-Review: RESZBEN')).toBe(true)
  })

  it('an unrecognised verdict word is not a review', () => {
    expect(DRAFT_REVIEW_RX.test('Draft-Review: talan')).toBe(false)
    expect(DRAFT_REVIEW_RX.test('Draft-Review:')).toBe(false)
  })

  it('MUTATION-PROOF: a longer word starting with a verdict does not count (identifier boundary)', () => {
    expect(DRAFT_REVIEW_RX.test('Draft-Review: ACCEPTEDISH')).toBe(false)
  })
})

describe('newestDraftAt', () => {
  it('is null when the card carries no local-llm comment at all', () => {
    expect(newestDraftAt([review(10)])).toBe(null)
  })

  it('picks the NEWEST draft, not the first one seen', () => {
    expect(newestDraftAt([draft(50), review(60), draft(70)])).toBe(70)
  })
})

describe('hasDraftReview -- author and freshness are both load-bearing', () => {
  it('a review from a real agent, newer than the draft, satisfies it', () => {
    expect(hasDraftReview([draft(10), review(20)], 10)).toBe(true)
  })

  it('THE SELF-REVIEW HOLE: the local model cannot adjudicate its own draft', () => {
    // The plan-grilling guard shipped this exact hole once (Cybersec HIGH, card 8e42a4c3): a guard
    // that checks only content lets the reviewed party satisfy it.
    const selfReview = { author: 'local-llm', content: 'Draft-Review: ELFOGADVA', created_at: 20 }
    expect(hasDraftReview([draft(10), selfReview], 10)).toBe(false)
  })

  it('gate-pretriage is machine-generated too, and cannot adjudicate either', () => {
    const bot = { author: 'gate-pretriage', content: 'Draft-Review: ELFOGADVA', created_at: 20 }
    expect(hasDraftReview([draft(10), bot], 10)).toBe(false)
  })

  it('FRESHNESS: a review OLDER than the draft is not evidence about it', () => {
    expect(hasDraftReview([review(10), draft(20)], 20)).toBe(false)
  })

  it('a review is evidence for a draft posted in the SAME second (>=, not >)', () => {
    expect(hasDraftReview([draft(10), review(10)], 10)).toBe(true)
  })
})

describe('draftReviewGuardVerdict', () => {
  it('BLOCKS the handoff when an unadjudicated draft is on the card', () => {
    comments = [draft(10)]
    const v = draftReviewGuardVerdict('c1', 'waiting', false, 'backend2')
    expect(v.blocked).toBe(true)
    expect(v.message).toContain('Draft-Review')
  })

  it('ALLOWS it once the draft has been adjudicated', () => {
    comments = [draft(10), review(20)]
    expect(draftReviewGuardVerdict('c1', 'waiting', false, 'backend2').blocked).toBe(false)
  })

  it('a REJECTION is a completed handoff too -- all three verdicts pass', () => {
    // Demanding "accepted" would push agents to rubber-stamp bad drafts, inverting the point.
    for (const v of ['ELFOGADVA', 'RESZBEN', 'ELUTASITVA']) {
      comments = [draft(10), review(20, 'backend2', v)]
      expect(draftReviewGuardVerdict('c1', 'waiting', false, 'backend2').blocked, v).toBe(false)
    }
  })

  it('REGRESSION: a review followed by TWO NEW drafts blocks again -- those were never seen', () => {
    comments = [draft(10), review(20), draft(30), draft(40)]
    expect(draftReviewGuardVerdict('c1', 'waiting', false, 'backend2').blocked).toBe(true)
  })

  it('stays out of the way on a card with no local-llm draft at all', () => {
    comments = [{ author: 'backend2', content: 'REVIEW: kesz.', created_at: 10 }]
    expect(draftReviewGuardVerdict('c1', 'waiting', false, 'backend2').blocked).toBe(false)
  })

  it('only guards the transition INTO waiting -- every other target is untouched', () => {
    comments = [draft(10)]
    for (const s of ['in_progress', 'done', 'planned']) {
      expect(draftReviewGuardVerdict('c1', s, false, 'backend2').blocked, s).toBe(false)
    }
  })

  it('re-asserting waiting on a card ALREADY waiting is not a handoff, so it is not blocked', () => {
    card.status = 'waiting'
    comments = [draft(10)]
    expect(draftReviewGuardVerdict('c1', 'waiting', false, 'backend2').blocked).toBe(false)
  })

  it('force + an allowlisted actor is the escape hatch', () => {
    comments = [draft(10)]
    expect(draftReviewGuardVerdict('c1', 'waiting', true, 'mikrob').blocked).toBe(false)
  })

  it('force from a NON-allowlisted actor is NOT an escape hatch', () => {
    comments = [draft(10)]
    expect(draftReviewGuardVerdict('c1', 'waiting', true, 'backend2').blocked).toBe(true)
  })

  it('FAIL-OPEN: a guard that cannot read the card allows the move, never freezes the board', () => {
    comments = [draft(10)]
    throwOnCard = true
    expect(draftReviewGuardVerdict('c1', 'waiting', false, 'backend2').blocked).toBe(false)
  })

  it('FAIL-OPEN: the same when the comments cannot be read', () => {
    comments = [draft(10)]
    throwOnComments = true
    expect(draftReviewGuardVerdict('c1', 'waiting', false, 'backend2').blocked).toBe(false)
  })
})
