// Card 6eb298b5: a hard ceiling on consecutive NO-GO/FAIL verdicts on the same card, enforced in
// code rather than left to the self-advance/gate loop to notice on its own. Idea from promptops'
// goal_loop.rs (budget/stop condition lives in code, never the model under evaluation) --
// https://github.com/shellonback/promptops (Apache-2.0, NOTICE file present); idea only, no code
// copied.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const card = {
  id: 'c1',
  title: 'cim',
  status: 'in_progress' as string,
}
let comments: Array<{ author: string; content: string; created_at: number }> = []
const addedComments: Array<{ cardId: string; author: string; content: string }> = []
const titleUpdates: Array<{ cardId: string; title: string }> = []
const sentMessages: Array<{ from: string; to: string; content: string }> = []
let nextCreatedAt = 1

vi.mock('../db.js', () => ({
  getKanbanCard: (id: string) => {
    if (id === 'throws') throw new Error('db unavailable')
    return id === card.id ? card : undefined
  },
  getKanbanComments: () => comments,
  addKanbanComment: (cardId: string, author: string, content: string) => {
    addedComments.push({ cardId, author, content })
    const row = { author, content, created_at: nextCreatedAt++ }
    comments = [...comments, row]
    return row
  },
  updateKanbanCard: (cardId: string, fields: { title?: string }) => {
    if (fields.title) {
      card.title = fields.title
      titleUpdates.push({ cardId, title: fields.title })
    }
    return true
  },
  createAgentMessage: (from: string, to: string, content: string) => {
    sentMessages.push({ from, to, content })
  },
}))
vi.mock('../logger.js', () => ({
  logger: { warn: () => {}, info: () => {} },
}))

const {
  gateBounceGuardCheck,
  consecutiveNegativeVerdictStreak,
  readGateBounceThreshold,
  BOUNCE_TAG,
} = await import('../web/kanban-gate-bounce-guard.js')

function commentRow(author: string, content: string) {
  return { author, content, created_at: nextCreatedAt++ }
}

function postComment(author: string, content: string) {
  const row = commentRow(author, content)
  comments = [...comments, row]
  addedComments.push({ cardId: card.id, author, content })
  gateBounceGuardCheck(card.id, row)
}

beforeEach(() => {
  card.title = 'cim'
  card.status = 'in_progress'
  comments = []
  addedComments.length = 0
  titleUpdates.length = 0
  sentMessages.length = 0
  nextCreatedAt = 1
})

describe('consecutiveNegativeVerdictStreak', () => {
  it('counts a trailing run of NO-GO/FAIL', () => {
    expect(
      consecutiveNegativeVerdictStreak([
        commentRow('qa', 'QA PASS'),
        commentRow('cybersec', 'CYBERSEC NO-GO'),
        commentRow('cybered', 'CYBERED NO-GO'),
      ]),
    ).toBe(2)
  })

  it('resets on a positive verdict in between (NO-GO, GO, NO-GO does not accumulate)', () => {
    expect(
      consecutiveNegativeVerdictStreak([
        commentRow('cybersec', 'CYBERSEC NO-GO'),
        commentRow('cybersec', 'CYBERSEC GO'),
        commentRow('cybersec', 'CYBERSEC NO-GO'),
      ]),
    ).toBe(1)
  })

  it('ignores non-verdict comments without breaking or extending the streak', () => {
    expect(
      consecutiveNegativeVerdictStreak([
        commentRow('qa', 'QA FAIL'),
        commentRow('backend2', 'working on the fix now'),
        commentRow('cybered', 'CYBERED NO-GO'),
      ]),
    ).toBe(2)
  })

  it('is 0 when there are no verdict comments at all', () => {
    expect(consecutiveNegativeVerdictStreak([commentRow('backend2', 'REVIEW: done, see above')])).toBe(0)
  })
})

describe('gateBounceGuardCheck', () => {
  it('3 consecutive NO-GO comments flag the card and send exactly one escalation', () => {
    postComment('qa', 'QA NO-GO')
    postComment('cybersec', 'CYBERSEC NO-GO')
    expect(card.title).toBe('cim')
    expect(sentMessages).toHaveLength(0)

    postComment('cybered', 'CYBERED NO-GO')

    expect(card.title).toBe(`${BOUNCE_TAG} cim`)
    expect(titleUpdates).toHaveLength(1)
    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0].to).toBe('mikrob')
    expect(sentMessages[0].content).toContain('c1')
    expect(addedComments.some((c) => c.author === 'gate-bounce-guard')).toBe(true)
  })

  it('NO-GO, GO, NO-GO does not trip (consecutive only)', () => {
    postComment('cybersec', 'CYBERSEC NO-GO')
    postComment('cybersec', 'CYBERSEC GO')
    postComment('cybersec', 'CYBERSEC NO-GO')
    postComment('qa', 'QA NO-GO')

    // 2 consecutive at the end, threshold is 3 by default -- must not trip.
    expect(card.title).toBe('cim')
    expect(sentMessages).toHaveLength(0)
  })

  it('a 4th consecutive NO-GO after the tag is already set does not send a 2nd escalation', () => {
    postComment('qa', 'QA NO-GO')
    postComment('cybersec', 'CYBERSEC NO-GO')
    postComment('cybered', 'CYBERED NO-GO')
    expect(sentMessages).toHaveLength(1)

    postComment('qa', 'QA NO-GO')
    expect(sentMessages).toHaveLength(1)
  })

  it('a PASS/GO comment itself never trips the guard, even sitting on top of a long negative run', () => {
    postComment('qa', 'QA NO-GO')
    postComment('cybersec', 'CYBERSEC NO-GO')
    postComment('cybered', 'CYBERED GO')

    expect(card.title).toBe('cim')
    expect(sentMessages).toHaveLength(0)
  })

  it('a non-verdict comment does not trip the guard', () => {
    postComment('qa', 'QA NO-GO')
    postComment('cybersec', 'CYBERSEC NO-GO')
    postComment('backend2', 'still working on this')

    expect(card.title).toBe('cim')
    expect(sentMessages).toHaveLength(0)
  })

  it('fails open when the card lookup throws', () => {
    expect(() => gateBounceGuardCheck('throws', { author: 'qa', content: 'QA NO-GO' })).not.toThrow()
    expect(sentMessages).toHaveLength(0)
  })

  it('a missing card is a silent no-op', () => {
    expect(() => gateBounceGuardCheck('nope', { author: 'qa', content: 'QA NO-GO' })).not.toThrow()
    expect(sentMessages).toHaveLength(0)
  })
})

describe('readGateBounceThreshold', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gate-bounce-budget-'))
  })

  it('defaults to 3 when the config file does not exist', () => {
    expect(readGateBounceThreshold(join(dir, 'missing.json'))).toBe(3)
  })

  it('reads an overridden integer from the config file', () => {
    const p = join(dir, 'cfg.json')
    writeFileSync(p, JSON.stringify({ consecutiveThreshold: 5 }))
    expect(readGateBounceThreshold(p)).toBe(5)
  })

  it('falls back to the default on a non-positive-integer value', () => {
    const p = join(dir, 'bad.json')
    writeFileSync(p, JSON.stringify({ consecutiveThreshold: 0 }))
    expect(readGateBounceThreshold(p)).toBe(3)
    writeFileSync(p, JSON.stringify({ consecutiveThreshold: 'lots' }))
    expect(readGateBounceThreshold(p)).toBe(3)
  })

  it('falls back to the default on unparseable JSON', () => {
    const p = join(dir, 'garbage.json')
    writeFileSync(p, '{not json')
    expect(readGateBounceThreshold(p)).toBe(3)
  })
})
