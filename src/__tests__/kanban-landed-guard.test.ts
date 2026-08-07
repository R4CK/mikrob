// Card 9cc72f2c point 2: catch an unlanded close BEFORE it happens, not in a sweep afterwards.
//
// The sweep found 39 cards standing on commits that never reached origin/main -- after they were
// closed. The trap was already documented and already had a tool; what was missing is that nothing
// ran at the moment of closing. These tests hold the guard to being narrow: it must block the one
// case it claims, and stay out of the way everywhere else, because a close-path guard that fires on
// anything else is one someone will disable.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const card = { id: 'c1', project: 'cleancore', status: 'waiting' as string | undefined }
let comments: Array<{ content: string }> = []

vi.mock('../db.js', () => ({
  getKanbanCard: () => card,
  getKanbanComments: () => comments,
}))
vi.mock('../logger.js', () => ({ logger: { warn: () => {} } }))

/** git stub: `known` are commits that exist, `onMain` are also reachable from origin/main. */
let known = new Set<string>()
let onMain = new Set<string>()
vi.mock('node:child_process', () => ({
  execFileSync: (_cmd: string, args: readonly string[]) => {
    const a = [...args]
    if (a.includes('cat-file')) {
      const sha = a[a.length - 1]!
      if (!known.has(sha)) throw new Error('not a commit')
      return 'commit'
    }
    if (a.includes('rev-parse')) return a[a.length - 1]!
    if (a.includes('--is-ancestor')) {
      const sha = a[a.indexOf('--is-ancestor') + 1]!
      if (!onMain.has(sha)) throw new Error('not an ancestor')
      return ''
    }
    return ''
  },
}))
vi.mock('node:fs', () => ({ existsSync: () => true }))

const { landedGuardVerdict } = await import('../web/kanban-landed-guard.js')

const SHA_A = 'aaaaaaa'
const SHA_B = 'bbbbbbb'

beforeEach(() => {
  card.project = 'cleancore'
  comments = []
  known = new Set([SHA_A, SHA_B])
  onMain = new Set()
})

describe('the landed guard blocks exactly one thing', () => {
  it('blocks closing when the only named commit is not on origin/main', () => {
    comments = [{ content: `REVIEW -- done @ ${SHA_A}` }]
    const v = landedGuardVerdict('c1', 'done', false, 'backend2')
    expect(v.blocked).toBe(true)
    expect(v.message).toContain(SHA_A.slice(0, 8))
  })

  it('allows closing once that commit IS on origin/main', () => {
    comments = [{ content: `REVIEW -- done @ ${SHA_A}` }]
    onMain = new Set([SHA_A])
    expect(landedGuardVerdict('c1', 'done', false, 'backend2').blocked).toBe(false)
  })

  it('allows when ANY named commit landed -- a card may name several', () => {
    // The work landed under one sha and the card also mentions the branch tip; one is enough.
    comments = [{ content: `first ${SHA_A}` }, { content: `landed as ${SHA_B}` }]
    onMain = new Set([SHA_B])
    expect(landedGuardVerdict('c1', 'done', false, 'backend2').blocked).toBe(false)
  })
})

describe('the landed guard stays out of the way', () => {
  it('does not fire on any status other than done', () => {
    comments = [{ content: `REVIEW -- ${SHA_A}` }]
    for (const s of ['in_progress', 'waiting', 'planned']) {
      expect(landedGuardVerdict('c1', s, false, 'backend2').blocked).toBe(false)
    }
  })

  it('does not fire on a card that names no commit', () => {
    // 17 of the 120 cards swept were like this -- E2E/user-story and decision cards. They make no
    // landing claim, so there is nothing to falsify.
    comments = [{ content: 'REVIEW -- 6 user stories verified, no code artefact' }]
    expect(landedGuardVerdict('c1', 'done', false, 'backend2').blocked).toBe(false)
  })

  it('does not treat hex-looking prose as a missing commit', () => {
    // "card 1bf4f8a4" is not a commit. Without the cat-file confirmation the guard would invent a
    // finding out of a card id and block a close that is fine.
    comments = [{ content: 'follow-up of card 1bf4f8a4, see also deadbeef' }]
    expect(landedGuardVerdict('c1', 'done', false, 'backend2').blocked).toBe(false)
  })

  it('does not fire for a project with no repo mapping', () => {
    card.project = 'some-other-product'
    comments = [{ content: `REVIEW -- ${SHA_A}` }]
    expect(landedGuardVerdict('c1', 'done', false, 'backend2').blocked).toBe(false)
  })
})

describe('force is not a free pass', () => {
  it('honours force only for an exempt actor', () => {
    comments = [{ content: `REVIEW -- ${SHA_A}` }]
    expect(landedGuardVerdict('c1', 'done', true, 'mikrob').blocked).toBe(false)
    // A role agent forcing its own close is the bypass that already happened once with newDevStop.
    expect(landedGuardVerdict('c1', 'done', true, 'backend2').blocked).toBe(true)
    expect(landedGuardVerdict('c1', 'done', true, undefined).blocked).toBe(true)
  })
})
