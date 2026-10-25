// Card 81452ce2 (F3, phase b8ac0ef1): mandatory spec template for non-trivial cards. Per MikroB's
// plan-grilling verdict (comment 16170) this guard is WARN-ONLY -- it must never block the
// transition, only post a warning comment, and must auto-flag an explicit "Termékdöntés: igen"
// field rather than guessing from content.
//
// DELTA-GATE (WhiteHat2 NO-GO, komment 16326): F1 (fire only after a successful transition, trust
// only the card's own description / assignee / mikrob for the product-decision field) and F2
// (exclude the guard's own comments from both scans, reject the unfilled "igen/nem" placeholder,
// durable mikrob approval) are covered below.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const card = {
  id: 'c1',
  title: 'cim',
  status: 'planned' as string,
  description: null as string | null,
  priority: 'normal' as string,
  assignee: 'backend2' as string | null,
}
let comments: Array<{ author: string; content: string }> = []
const addedComments: Array<{ cardId: string; author: string; content: string }> = []
const titleUpdates: Array<{ cardId: string; title: string }> = []

vi.mock('../db.js', () => ({
  getKanbanCard: (id: string) => {
    if (id === 'throws') throw new Error('db unavailable')
    return id === card.id ? card : undefined
  },
  getKanbanComments: () => comments,
  addKanbanComment: (cardId: string, author: string, content: string) => {
    addedComments.push({ cardId, author, content })
    comments = [...comments, { author, content }]
  },
  updateKanbanCard: (cardId: string, fields: { title?: string }) => {
    if (fields.title) {
      card.title = fields.title
      titleUpdates.push({ cardId, title: fields.title })
    }
    return true
  },
}))
vi.mock('../logger.js', () => ({
  logger: { warn: () => {}, info: () => {} },
}))

const { specTemplateGuardCheck, isNonTrivialCard, missingSpecSections } = await import(
  '../web/kanban-spec-template-guard.js'
)

const FULL_SPEC =
  'Kontextus: src/x.ts:1\nKövetelmények: 1) foo\nEllenőrizhető elfogadási kritériumok: npm test zöld\n' +
  'Nincs benne: bar\nFeltételezések: a foo mukodik (Termékdöntés: nem)'

beforeEach(() => {
  card.title = 'cim'
  card.status = 'planned'
  card.description = null
  card.priority = 'normal'
  card.assignee = 'backend2'
  comments = []
  addedComments.length = 0
  titleUpdates.length = 0
  delete process.env.SPEC_TEMPLATE_GUARD
})

describe('isNonTrivialCard', () => {
  it('HIGH/URGENT priority counts', () => {
    expect(isNonTrivialCard('cim', 'high')).toBe(true)
    expect(isNonTrivialCard('cim', 'urgent')).toBe(true)
  })
  it('normal/low priority with no tag does not count', () => {
    expect(isNonTrivialCard('cim', 'normal')).toBe(false)
    expect(isNonTrivialCard('cim', 'low')).toBe(false)
  })
  it('FÁZIS/FELADAT tag counts regardless of priority', () => {
    expect(isNonTrivialCard('[FÁZIS][x] cim', 'low')).toBe(true)
    expect(isNonTrivialCard('[FELADAT][x] cim', 'low')).toBe(true)
    expect(isNonTrivialCard('[FAZIS][x] cim', 'low')).toBe(true)
  })
  it('[SEC] tag counts regardless of priority', () => {
    expect(isNonTrivialCard('[SEC][x] cim', 'low')).toBe(true)
  })
})

const FULL_SPEC_EN =
  'Context: src/x.ts:1\nRequirements: 1) foo\nAcceptance criteria: npm test green\n' +
  'Out of scope: bar\nAssumptions: foo works'

describe('missingSpecSections', () => {
  it('a full spec is missing nothing', () => {
    expect(missingSpecSections(FULL_SPEC)).toEqual([])
  })
  it('an empty text is missing all five', () => {
    expect(missingSpecSections('')).toHaveLength(5)
  })
  // card 867fa8f2 (agent-to-agent English rule): a card written entirely in English must not warn.
  it('a full spec in English is missing nothing', () => {
    expect(missingSpecSections(FULL_SPEC_EN)).toEqual([])
  })
})

describe('specTemplateGuardCheck', () => {
  it('a trivial card (normal priority, no tag) gets no comment even with no spec', () => {
    specTemplateGuardCheck('c1', 'planned', 'in_progress', 'backend2')
    expect(addedComments).toHaveLength(0)
  })

  it('WARN-ONLY: a non-trivial card missing the spec gets a comment but the caller never sees a block', () => {
    card.priority = 'high'
    // the function has no return value to check -- its only observable effect is the comment
    expect(() => specTemplateGuardCheck('c1', 'planned', 'in_progress', 'backend2')).not.toThrow()
    expect(addedComments).toHaveLength(1)
    expect(addedComments[0].content).toContain('SPEC-TEMPLATE WARN')
  })

  it('does not warn twice for the same missing spec (real: the guard\'s own comment is excluded from the scan)', () => {
    card.priority = 'high'
    specTemplateGuardCheck('c1', 'planned', 'in_progress', 'backend2')
    specTemplateGuardCheck('c1', 'planned', 'in_progress', 'backend2')
    specTemplateGuardCheck('c1', 'planned', 'in_progress', 'backend2')
    expect(addedComments).toHaveLength(1)
    // mutation-proof: the warn comment itself names all five sections -- confirm the scan really
    // excludes it (if it didn't, missingSpecSections on the post-warn text would already be [])
    expect(missingSpecSections(addedComments[0].content)).toHaveLength(0)
  })

  it('a non-trivial card WITH the full spec gets no warning', () => {
    card.priority = 'high'
    card.description = FULL_SPEC
    specTemplateGuardCheck('c1', 'planned', 'in_progress', 'backend2')
    expect(addedComments).toHaveLength(0)
  })

  it('only fires on planned -> in_progress, not other prev/next combinations', () => {
    card.priority = 'high'
    specTemplateGuardCheck('c1', 'waiting', 'in_progress', 'backend2')
    expect(addedComments).toHaveLength(0)
    specTemplateGuardCheck('c1', 'planned', 'waiting', 'backend2')
    expect(addedComments).toHaveLength(0)
  })

  it('"Termékdöntés: igen" in the card description auto-tags [BLOKKOLT-Peti-dontes] and requests approval', () => {
    card.priority = 'high'
    card.description = FULL_SPEC.replace('Termékdöntés: nem', 'Termékdöntés: igen')
    specTemplateGuardCheck('c1', 'planned', 'in_progress', 'backend2')
    expect(card.title).toContain('[BLOKKOLT-Peti-dontes]')
    expect(titleUpdates).toHaveLength(1)
    expect(addedComments.some((c) => c.content.includes('Jóváhagyás-kérés'))).toBe(true)
  })

  it('"Termékdöntés: igen" in a comment from the card\'s OWN assignee also auto-tags', () => {
    card.priority = 'high'
    comments = [{ author: 'backend2', content: 'Feltételezések: Termékdöntés: igen' }]
    specTemplateGuardCheck('c1', 'planned', 'in_progress', 'backend2')
    expect(card.title).toContain('[BLOKKOLT-Peti-dontes]')
  })

  it('"Termékdöntés: igen" in a comment from mikrob also auto-tags', () => {
    card.priority = 'high'
    comments = [{ author: 'mikrob', content: 'Feltételezések: Termékdöntés: igen' }]
    specTemplateGuardCheck('c1', 'planned', 'in_progress', 'backend2')
    expect(card.title).toContain('[BLOKKOLT-Peti-dontes]')
  })

  it('F1: "Termékdöntés: igen" in a comment from a THIRD PARTY (not assignee, not mikrob) does NOT auto-tag', () => {
    card.priority = 'high'
    card.assignee = 'backend2'
    comments = [{ author: 'mallory', content: 'Feltételezések: Termékdöntés: igen' }]
    specTemplateGuardCheck('c1', 'planned', 'in_progress', 'backend2')
    expect(card.title).not.toContain('[BLOKKOLT-Peti-dontes]')
    expect(titleUpdates).toHaveLength(0)
  })

  it('MUTATION-PROOF: "Termékdöntés: nem" does NOT auto-tag', () => {
    card.priority = 'high'
    card.description = FULL_SPEC // ends in "Termékdöntés: nem"
    specTemplateGuardCheck('c1', 'planned', 'in_progress', 'backend2')
    expect(card.title).not.toContain('[BLOKKOLT-Peti-dontes]')
  })

  it('F2: the unfilled template placeholder "Termékdöntés: igen/nem" does NOT auto-tag', () => {
    card.priority = 'high'
    card.description = 'Feltételezések: a foo mukodik (Termékdöntés: igen/nem)'
    specTemplateGuardCheck('c1', 'planned', 'in_progress', 'backend2')
    expect(card.title).not.toContain('[BLOKKOLT-Peti-dontes]')
  })

  it('does not re-tag a card already carrying [BLOKKOLT-Peti-dontes]', () => {
    card.priority = 'high'
    card.title = '[BLOKKOLT-Peti-dontes] cim'
    card.description = FULL_SPEC.replace('Termékdöntés: nem', 'Termékdöntés: igen')
    specTemplateGuardCheck('c1', 'planned', 'in_progress', 'backend2')
    expect(titleUpdates).toHaveLength(0)
  })

  it('F2: a durable "Termékdöntés-jóváhagyva" comment from mikrob permanently stops the re-tag, even though the decision line is still present', () => {
    card.priority = 'high'
    card.title = 'cim' // tag already removed by a human after approval
    card.description = FULL_SPEC.replace('Termékdöntés: nem', 'Termékdöntés: igen')
    comments = [{ author: 'mikrob', content: 'Termékdöntés-jóváhagyva, mehet tovább.' }]
    specTemplateGuardCheck('c1', 'planned', 'in_progress', 'backend2')
    expect(card.title).not.toContain('[BLOKKOLT-Peti-dontes]')
    expect(titleUpdates).toHaveLength(0)
  })

  it('kill switch SPEC_TEMPLATE_GUARD=off disables every effect', () => {
    process.env.SPEC_TEMPLATE_GUARD = 'off'
    card.priority = 'urgent'
    card.description = FULL_SPEC.replace('Termékdöntés: nem', 'Termékdöntés: igen')
    specTemplateGuardCheck('c1', 'planned', 'in_progress', 'backend2')
    expect(addedComments).toHaveLength(0)
    expect(titleUpdates).toHaveLength(0)
  })

  it('getKanbanCard returning nothing for an unknown id is a silent no-op', () => {
    expect(() => specTemplateGuardCheck('does-not-exist', 'planned', 'in_progress', 'backend2')).not.toThrow()
    expect(addedComments).toHaveLength(0)
  })

  it('MUTATION-PROOF fail-open: a getKanbanCard THROW (not a mere undefined) is swallowed, never crashes the caller', () => {
    expect(() => specTemplateGuardCheck('throws', 'planned', 'in_progress', 'backend2')).not.toThrow()
    expect(addedComments).toHaveLength(0)
  })
})
