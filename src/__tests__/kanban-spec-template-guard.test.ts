// Card 81452ce2 (F3, phase b8ac0ef1): mandatory spec template for non-trivial cards. Per MikroB's
// plan-grilling verdict (comment 16170) this guard is WARN-ONLY -- it must never block the
// transition, only post a warning comment, and must auto-flag an explicit "Termékdöntés: igen"
// field rather than guessing from content.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const card = {
  id: 'c1',
  title: 'cim',
  status: 'planned' as string,
  description: null as string | null,
  priority: 'normal' as string,
}
let comments: Array<{ author: string; content: string }> = []
const addedComments: Array<{ cardId: string; author: string; content: string }> = []
const titleUpdates: Array<{ cardId: string; title: string }> = []

vi.mock('../db.js', () => ({
  getKanbanCard: (id: string) => (id === card.id ? card : undefined),
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

describe('missingSpecSections', () => {
  it('a full spec is missing nothing', () => {
    expect(missingSpecSections(FULL_SPEC)).toEqual([])
  })
  it('an empty text is missing all five', () => {
    expect(missingSpecSections('')).toHaveLength(5)
  })
})

describe('specTemplateGuardCheck', () => {
  it('a trivial card (normal priority, no tag) gets no comment even with no spec', () => {
    specTemplateGuardCheck('c1', 'in_progress', 'backend2')
    expect(addedComments).toHaveLength(0)
  })

  it('WARN-ONLY: a non-trivial card missing the spec gets a comment but the caller never sees a block', () => {
    card.priority = 'high'
    // the function has no return value to check -- its only observable effect is the comment
    expect(() => specTemplateGuardCheck('c1', 'in_progress', 'backend2')).not.toThrow()
    expect(addedComments).toHaveLength(1)
    expect(addedComments[0].content).toContain('SPEC-TEMPLATE WARN')
  })

  it('does not warn twice for the same missing spec', () => {
    card.priority = 'high'
    specTemplateGuardCheck('c1', 'in_progress', 'backend2')
    specTemplateGuardCheck('c1', 'in_progress', 'backend2')
    expect(addedComments).toHaveLength(1)
  })

  it('a non-trivial card WITH the full spec gets no warning', () => {
    card.priority = 'high'
    card.description = FULL_SPEC
    specTemplateGuardCheck('c1', 'in_progress', 'backend2')
    expect(addedComments).toHaveLength(0)
  })

  it('only fires on planned -> in_progress, not other transitions', () => {
    card.priority = 'high'
    card.status = 'waiting'
    specTemplateGuardCheck('c1', 'in_progress', 'backend2')
    expect(addedComments).toHaveLength(0)
  })

  it('"Termékdöntés: igen" auto-tags [BLOKKOLT-Peti-dontes] and requests approval', () => {
    card.priority = 'high'
    card.description = FULL_SPEC.replace('Termékdöntés: nem', 'Termékdöntés: igen')
    specTemplateGuardCheck('c1', 'in_progress', 'backend2')
    expect(card.title).toContain('[BLOKKOLT-Peti-dontes]')
    expect(titleUpdates).toHaveLength(1)
    expect(addedComments.some((c) => c.content.includes('Jóváhagyás-kérés'))).toBe(true)
  })

  it('MUTATION-PROOF: "Termékdöntés: nem" does NOT auto-tag', () => {
    card.priority = 'high'
    card.description = FULL_SPEC // ends in "Termékdöntés: nem"
    specTemplateGuardCheck('c1', 'in_progress', 'backend2')
    expect(card.title).not.toContain('[BLOKKOLT-Peti-dontes]')
  })

  it('does not re-tag a card already carrying [BLOKKOLT-Peti-dontes]', () => {
    card.priority = 'high'
    card.title = '[BLOKKOLT-Peti-dontes] cim'
    card.description = FULL_SPEC.replace('Termékdöntés: nem', 'Termékdöntés: igen')
    specTemplateGuardCheck('c1', 'in_progress', 'backend2')
    expect(titleUpdates).toHaveLength(0)
  })

  it('kill switch SPEC_TEMPLATE_GUARD=off disables every effect', () => {
    process.env.SPEC_TEMPLATE_GUARD = 'off'
    card.priority = 'urgent'
    card.description = FULL_SPEC.replace('Termékdöntés: nem', 'Termékdöntés: igen')
    specTemplateGuardCheck('c1', 'in_progress', 'backend2')
    expect(addedComments).toHaveLength(0)
    expect(titleUpdates).toHaveLength(0)
  })

  it('a getKanbanCard throw is swallowed (fail-open), never crashes the caller', () => {
    expect(() => specTemplateGuardCheck('does-not-exist', 'in_progress', 'backend2')).not.toThrow()
  })
})
