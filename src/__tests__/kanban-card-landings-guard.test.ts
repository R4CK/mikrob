// Card 339ad171 (F2.2, Feladat 471d0fdc): the done-guard reading card_landings, warn-only first.
// Kesz-ha: LANDING_GUARD=warn|enforce|off (default warn); tests for missing row, a row that does
// NOT name the gated sha ("non-ancestor sha" in the card's own wording), and the "Landing: n/a"
// exemption; force:true by mikrob still possible (audited by the existing write path, not by
// this guard).
import { describe, it, expect, beforeEach, vi } from 'vitest'

interface Card {
  id: string
  project: string | null
  description: string | null
}
interface Comment {
  author: string
  content: string
}

let card: Card | undefined
let comments: Comment[] = []
let landings: Array<{ card_id: string; work_sha: string; merge_sha: string }> = []
const addedComments: Array<{ cardId: string; author: string; content: string }> = []

vi.mock('../db.js', () => ({
  getKanbanCard: (id: string) => {
    if (id === 'throws') throw new Error('db unavailable')
    return card && card.id === id ? card : undefined
  },
  getKanbanComments: () => comments,
  listCardLandings: (cardId: string) => landings.filter((l) => l.card_id === cardId),
  addKanbanComment: (cardId: string, author: string, content: string) => {
    addedComments.push({ cardId, author, content })
    comments = [...comments, { author, content }]
  },
}))
vi.mock('../kanban-force-actors.js', () => ({
  isForceActor: (force: boolean) => force === true,
}))
vi.mock('../web/kanban-landed-guard.js', () => ({
  PROJECT_REPOS: {
    marveen: { root: '/x', mainRef: 'origin/develop' },
    mopsion: { root: '/y', mainRef: 'origin/main' },
    cleancore: { root: '/y', mainRef: 'origin/main' },
  },
  NO_REPO_PROJECTS: new Set(['', 'ingatlan']),
  GENERATED_COMMENT_AUTHORS: new Set(['local-llm', 'gate-pretriage', 'gemini-orch-review']),
}))
vi.mock('../web/kanban-gate-completeness-guard.js', () => ({
  GATE_AGENT_NAMES: new Set(['qa', 'qa2', 'cybersec', 'cybersec2', 'cybered']),
}))
vi.mock('../logger.js', () => ({
  logger: { warn: () => {}, info: () => {} },
}))

const { cardLandingsGuardVerdict } = await import('../web/kanban-card-landings-guard.js')

const GATED_SHA = 'abc1234567890abc1234567890abc1234567890'
const REVIEW_WITH_SHA = `REVIEW\nGate-SHA: ${GATED_SHA}`

beforeEach(() => {
  card = { id: 'c1', project: 'marveen', description: null }
  comments = []
  landings = []
  addedComments.length = 0
  delete process.env.LANDING_GUARD
})

describe('cardLandingsGuardVerdict', () => {
  it('only applies to a transition to done -- every other status is a no-op', () => {
    const v = cardLandingsGuardVerdict('c1', 'in_progress', false, 'backend3')
    expect(v.blocked).toBe(false)
    expect(addedComments).toHaveLength(0)
  })

  it('LANDING_GUARD=off disables every effect, even with zero landing rows', () => {
    process.env.LANDING_GUARD = 'off'
    const v = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
    expect(v.blocked).toBe(false)
    expect(addedComments).toHaveLength(0)
  })

  it('a force actor always passes, even with zero landing rows', () => {
    const v = cardLandingsGuardVerdict('c1', 'done', true, 'mikrob')
    expect(v.blocked).toBe(false)
    expect(addedComments).toHaveLength(0)
  })

  it('a project with no mapped repo (NO_REPO_PROJECTS) is a silent no-op', () => {
    card!.project = 'ingatlan'
    const v = cardLandingsGuardVerdict('c1', 'done', false, 'jogasz')
    expect(v.blocked).toBe(false)
    expect(addedComments).toHaveLength(0)
  })

  it('a completely unmapped, unlisted project is also a no-op (kanban-landed-guard.ts owns that case)', () => {
    card!.project = 'some-new-project-nobody-wired-up'
    const v = cardLandingsGuardVerdict('c1', 'done', false, 'mikrob')
    expect(v.blocked).toBe(false)
    expect(addedComments).toHaveLength(0)
  })

  it('an explicit "Landing: n/a" line in the description exempts the card, no warning either', () => {
    card!.description = 'Config-only change.\nLanding: n/a'
    const v = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
    expect(v.blocked).toBe(false)
    expect(addedComments).toHaveLength(0)
  })

  it('no gated sha at all: "Landing: n/a" in ANY comment exempts the card (nothing to bypass)', () => {
    comments = [{ author: 'backend3', content: 'Research card, Landing: N/A' }]
    const v = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
    expect(v.blocked).toBe(false)
    expect(addedComments).toHaveLength(0)
  })

  it('WARN-ONLY (default): missing row -> comment posted, never blocked', () => {
    comments = [{ author: 'backend3', content: REVIEW_WITH_SHA }]
    const v = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
    expect(v.blocked).toBe(false)
    expect(addedComments).toHaveLength(1)
    expect(addedComments[0].content).toContain('LANDING-GUARD WARN')
  })

  it('a row exists for the card but names a DIFFERENT sha than the gated one -> still warns (Mikrob 28280)', () => {
    comments = [{ author: 'backend3', content: REVIEW_WITH_SHA }]
    landings = [{ card_id: 'c1', work_sha: 'deadbeef00000000deadbeef00000000deadbeef', merge_sha: 'deadbeef00000000deadbeef00000000deadbeef' }]
    const v = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
    expect(v.blocked).toBe(false)
    expect(addedComments).toHaveLength(1)
    expect(addedComments[0].content).toContain('none a gate-elt')
  })

  it('a row whose work_sha matches the gated sha passes silently', () => {
    comments = [{ author: 'backend3', content: REVIEW_WITH_SHA }]
    landings = [{ card_id: 'c1', work_sha: GATED_SHA, merge_sha: 'deadbeef00000000deadbeef00000000deadbeef' }]
    const v = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
    expect(v.blocked).toBe(false)
    expect(addedComments).toHaveLength(0)
  })

  it('a row whose merge_sha matches the gated sha passes silently too', () => {
    comments = [{ author: 'backend3', content: REVIEW_WITH_SHA }]
    landings = [{ card_id: 'c1', work_sha: 'deadbeef00000000deadbeef00000000deadbeef', merge_sha: GATED_SHA }]
    const v = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
    expect(v.blocked).toBe(false)
    expect(addedComments).toHaveLength(0)
  })

  it('a short-sha Gate-SHA line still matches a full-sha landing row (prefix match)', () => {
    comments = [{ author: 'backend3', content: `REVIEW\nGate-SHA: ${GATED_SHA.slice(0, 10)}` }]
    landings = [{ card_id: 'c1', work_sha: GATED_SHA, merge_sha: '' }]
    const v = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
    expect(v.blocked).toBe(false)
    expect(addedComments).toHaveLength(0)
  })

  it('does not warn twice for the same card', () => {
    comments = [{ author: 'backend3', content: REVIEW_WITH_SHA }]
    cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
    cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
    cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
    expect(addedComments).toHaveLength(1)
  })

  it('BYPASS GUARD: a "Landing: n/a" in an UNRELATED later comment does NOT exempt a real gated sha with no matching row', () => {
    comments = [
      { author: 'backend3', content: REVIEW_WITH_SHA },
      { author: 'mallory', content: 'unrelated chatter\nLanding: n/a (just testing)' },
    ]
    const v = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
    expect(v.blocked).toBe(false) // warn-only, never blocks
    expect(addedComments).toHaveLength(1) // but it DID warn -- the n/a line was correctly ignored
  })

  it('"Landing: n/a" INSIDE the declaring REVIEW comment itself does exempt (legitimate config-only pattern)', () => {
    comments = [{ author: 'backend3', content: `${REVIEW_WITH_SHA}\nLanding: n/a` }]
    const v = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
    expect(v.blocked).toBe(false)
    expect(addedComments).toHaveLength(0)
  })

  it('ENFORCE mode: missing row is blocked with a 409-shaped message', () => {
    process.env.LANDING_GUARD = 'enforce'
    comments = [{ author: 'backend3', content: REVIEW_WITH_SHA }]
    const v = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
    expect(v.blocked).toBe(true)
    expect(v.message).toContain('card_landings')
    expect(addedComments).toHaveLength(0) // enforce blocks instead of warning
  })

  it('ENFORCE mode: a row matching the gated sha still passes', () => {
    process.env.LANDING_GUARD = 'enforce'
    comments = [{ author: 'backend3', content: REVIEW_WITH_SHA }]
    landings = [{ card_id: 'c1', work_sha: GATED_SHA, merge_sha: '' }]
    const v = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
    expect(v.blocked).toBe(false)
  })

  it('ENFORCE mode: a force actor still bypasses the block', () => {
    process.env.LANDING_GUARD = 'enforce'
    const v = cardLandingsGuardVerdict('c1', 'done', true, 'mikrob')
    expect(v.blocked).toBe(false)
  })

  it('REGRESSION (default = warn): existing done-closures with no landing row keep working, never blocked', () => {
    const v = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
    expect(v.blocked).toBe(false)
  })

  it('mopsion/cleancore projects resolve through PROJECT_REPOS too, not just marveen', () => {
    card!.project = 'mopsion'
    comments = [{ author: 'backend3', content: REVIEW_WITH_SHA }]
    const v = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
    expect(v.blocked).toBe(false)
    expect(addedComments).toHaveLength(1) // still warns -- mopsion has code too, just no row
  })

  it('getKanbanCard returning nothing for an unknown id is a silent no-op', () => {
    const v = cardLandingsGuardVerdict('does-not-exist', 'done', false, 'backend3')
    expect(v.blocked).toBe(false)
    expect(addedComments).toHaveLength(0)
  })

  it('MUTATION-PROOF fail-open: a getKanbanCard THROW never blocks and never crashes the caller', () => {
    expect(() => cardLandingsGuardVerdict('throws', 'done', false, 'backend3')).not.toThrow()
    const v = cardLandingsGuardVerdict('throws', 'done', false, 'backend3')
    expect(v.blocked).toBe(false)
  })

  // Cybersec2 NO-GO (card 339ad171, comment 33084) -- the three findings below, each reproduced
  // against the PRE-FIX guard first (it fails) before pinning the fixed behaviour.
  describe('cybersec2 NO-GO fixes', () => {
    it('F1: the guard does NOT exempt itself via its own warn comment on the next (enforce) check', () => {
      // No gated sha at all -- an ungated card -- so this exercises the `!gated` exemption-scan
      // branch the F1 finding named. WARN first (posts the guard's own comment, which quotes
      // "Landing: n/a" verbatim), then flip to ENFORCE on the SAME card: must still block.
      comments = []
      const warned = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
      expect(warned.blocked).toBe(false)
      expect(addedComments).toHaveLength(1)
      expect(addedComments[0].author).toBe('card-landings-guard')

      process.env.LANDING_GUARD = 'enforce'
      const enforced = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
      expect(enforced.blocked).toBe(true)
    })

    it('F1: a generated/local-llm comment containing "Landing: n/a" also does not exempt', () => {
      comments = [{ author: 'local-llm', content: 'draft note\nLanding: n/a' }]
      process.env.LANDING_GUARD = 'enforce'
      const v = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
      expect(v.blocked).toBe(true)
    })

    it('F2: an UNGATED card (no REVIEW/Gate-SHA at all) is NOT proven landed by a row on card_id alone', () => {
      // No REVIEW comment at all -- `gated` is null -- but a row exists for this card_id (the
      // "a docs commit merely says see card <id>" class the binding rule names).
      comments = []
      landings = [{ card_id: 'c1', work_sha: 'deadbeef00000000deadbeef00000000deadbeef', merge_sha: '' }]
      process.env.LANDING_GUARD = 'enforce'
      const v = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
      expect(v.blocked).toBe(true)
    })

    it('F2: WARN-ONLY, same ungated-but-has-a-row shape, still warns (not silently exempt)', () => {
      comments = []
      landings = [{ card_id: 'c1', work_sha: 'deadbeef00000000deadbeef00000000deadbeef', merge_sha: '' }]
      const v = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
      expect(v.blocked).toBe(false)
      expect(addedComments).toHaveLength(1)
    })

    it('F3: a GATE-authored "REVIEW"-shaped comment cannot override the real builder REVIEW\'s gated sha', () => {
      // Builder's real REVIEW names GATED_SHA; a later comment from "cybersec" restates its own
      // Gate-SHA line (a legitimate thing for a gate to post) -- this must NOT become the sha the
      // landing is bound to. A row matching the BUILDER's sha must still pass.
      comments = [
        { author: 'backend3', content: REVIEW_WITH_SHA },
        { author: 'cybersec', content: 'REVIEW\nGate-SHA: deadbeef00000000deadbeef00000000deadbeef' },
      ]
      landings = [{ card_id: 'c1', work_sha: GATED_SHA, merge_sha: '' }]
      const v = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
      expect(v.blocked).toBe(false)
      expect(addedComments).toHaveLength(0)
    })

    it('F3: ...and a row matching the GATE comment\'s sha (not the builder\'s) is correctly rejected', () => {
      comments = [
        { author: 'backend3', content: REVIEW_WITH_SHA },
        { author: 'cybersec', content: 'REVIEW\nGate-SHA: deadbeef00000000deadbeef00000000deadbeef' },
      ]
      landings = [{ card_id: 'c1', work_sha: 'deadbeef00000000deadbeef00000000deadbeef', merge_sha: '' }]
      process.env.LANDING_GUARD = 'enforce'
      const v = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
      expect(v.blocked).toBe(true)
    })

    it('F3: a generated/local-llm "REVIEW"-shaped comment cannot supply the gated sha either', () => {
      comments = [
        { author: 'backend3', content: REVIEW_WITH_SHA },
        { author: 'local-llm', content: 'REVIEW\nGate-SHA: deadbeef00000000deadbeef00000000deadbeef' },
      ]
      landings = [{ card_id: 'c1', work_sha: GATED_SHA, merge_sha: '' }]
      const v = cardLandingsGuardVerdict('c1', 'done', false, 'backend3')
      expect(v.blocked).toBe(false)
      expect(addedComments).toHaveLength(0)
    })
  })
})
