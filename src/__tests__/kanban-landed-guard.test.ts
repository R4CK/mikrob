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
/** Counts spawns, so the "one cat-file, not one per token" fix is asserted and not just intended. */
export let spawns: string[][] = []
vi.mock('node:child_process', () => ({
  execFile: (
    _cmd: string,
    args: readonly string[],
    _opts: unknown,
    cb: (e: Error | null, out: string) => void,
  ) => {
    const a = [...args]
    spawns.push(a)
    let stdinBuf = ''
    queueMicrotask(() => {
      if (a.includes('cat-file')) {
        // --batch-check answers one line per stdin token.
        const lines = stdinBuf
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((tok) => (known.has(tok) ? `${tok} commit 42` : `${tok} missing`))
        cb(null, lines.join('\n'))
        return
      }
      if (a.includes('--is-ancestor')) {
        const sha = a[a.indexOf('--is-ancestor') + 1]!
        cb(onMain.has(sha) ? null : new Error('not an ancestor'), '')
        return
      }
      cb(null, '')
    })
    return { stdin: { end: (s: string) => { stdinBuf = s } } }
  },
}))
vi.mock('node:fs', () => ({ existsSync: () => true }))

const { landedGuardVerdict } = await import('../web/kanban-landed-guard.js')

const SHA_A = 'aaaaaaa'
const SHA_B = 'bbbbbbb'

beforeEach(() => {
  spawns = []
  card.project = 'cleancore'
  comments = []
  known = new Set([SHA_A, SHA_B])
  onMain = new Set()
})

describe('the landed guard blocks exactly one thing', () => {
  it('blocks closing when the only named commit is not on origin/main', async () => {
    comments = [{ content: `REVIEW -- done @ ${SHA_A}` }]
    const v = await landedGuardVerdict('c1', 'done', false, 'backend2')
    expect(v.blocked).toBe(true)
    expect(v.message).toContain(SHA_A.slice(0, 8))
  })

  it('allows closing once that commit IS on origin/main', async () => {
    comments = [{ content: `REVIEW -- done @ ${SHA_A}` }]
    onMain = new Set([SHA_A])
    expect((await landedGuardVerdict('c1', 'done', false, 'backend2')).blocked).toBe(false)
  })

  it('allows when ANY named commit landed -- a card may name several', async () => {
    // The work landed under one sha and the card also mentions the branch tip; one is enough.
    comments = [{ content: `first ${SHA_A}` }, { content: `landed as ${SHA_B}` }]
    onMain = new Set([SHA_B])
    expect((await landedGuardVerdict('c1', 'done', false, 'backend2')).blocked).toBe(false)
  })
})

describe('the landed guard stays out of the way', () => {
  it('does not fire on any status other than done', async () => {
    comments = [{ content: `REVIEW -- ${SHA_A}` }]
    for (const s of ['in_progress', 'waiting', 'planned']) {
      expect((await landedGuardVerdict('c1', s, false, 'backend2')).blocked).toBe(false)
    }
  })

  it('does not fire on a card that names no commit', async () => {
    // 17 of the 120 cards swept were like this -- E2E/user-story and decision cards. They make no
    // landing claim, so there is nothing to falsify.
    comments = [{ content: 'REVIEW -- 6 user stories verified, no code artefact' }]
    expect((await landedGuardVerdict('c1', 'done', false, 'backend2')).blocked).toBe(false)
  })

  it('does not treat hex-looking prose as a missing commit', async () => {
    // "card 1bf4f8a4" is not a commit. Without the cat-file confirmation the guard would invent a
    // finding out of a card id and block a close that is fine.
    comments = [{ content: 'follow-up of card 1bf4f8a4, see also deadbeef' }]
    expect((await landedGuardVerdict('c1', 'done', false, 'backend2')).blocked).toBe(false)
  })

  it('does not fire for a project with no repo mapping', async () => {
    card.project = 'some-other-product'
    comments = [{ content: `REVIEW -- ${SHA_A}` }]
    expect((await landedGuardVerdict('c1', 'done', false, 'backend2')).blocked).toBe(false)
  })
})

describe('the guard does not stall the single-threaded server (Cybersec NO-GO on v1)', () => {
  // The first version froze the WHOLE fleet API for 3-7s on every close: execFileSync, one `git
  // cat-file` spawn per candidate token (110 of them at ~42ms), plus a fixed 2.5s fetch. /api/messages
  // sits in the same process, so inter-agent delivery stopped too. These assertions pin the shape of
  // the fix, not just its intent -- "it feels faster" is not a check.
  it('resolves ALL candidates in ONE cat-file spawn, however many tokens the card has', async () => {
    const manyTokens = Array.from({ length: 60 }, (_, i) => `deadbe${i.toString(16).padStart(2, '0')}`).join(' ')
    comments = [{ content: `REVIEW -- ${SHA_A} ${manyTokens}` }]
    onMain = new Set([SHA_A])
    await landedGuardVerdict('c1', 'done', false, 'backend2')
    expect(spawns.filter((s) => s.includes('cat-file')).length).toBe(1)
  })

  it('does NOT fetch on the happy path -- that was the fixed 2.5s on every close', async () => {
    comments = [{ content: `REVIEW -- ${SHA_A}` }]
    onMain = new Set([SHA_A])
    await landedGuardVerdict('c1', 'done', false, 'backend2')
    expect(spawns.some((s) => s.includes('fetch'))).toBe(false)
  })

  it('fetches ONLY when it is about to block, then re-checks', async () => {
    // The asymmetry that makes skipping the fetch safe: a stale ref can only make us block something
    // that is fine (loud, and the fetch clears it), never wave through something that is not.
    comments = [{ content: `REVIEW -- ${SHA_A}` }]
    onMain = new Set()
    const v = await landedGuardVerdict('c1', 'done', false, 'backend2')
    expect(v.blocked).toBe(true)
    expect(spawns.filter((s) => s.includes('fetch')).length).toBe(1)
    // The re-check after the fetch is what makes the fetch worth doing.
    expect(spawns.filter((s) => s.includes('--is-ancestor')).length).toBeGreaterThan(1)
  })

  it('spawns nothing at all for a status other than done', async () => {
    comments = [{ content: `REVIEW -- ${SHA_A}` }]
    await landedGuardVerdict('c1', 'waiting', false, 'backend2')
    expect(spawns.length).toBe(0)
  })
})

describe('marveen own cards are covered too (card 84091afd)', () => {
  it.each(['marveen', 'mikrob-infra', 'fleet-infra', 'mikrob'])(
    'project %s is checked, not silently exempt',
    async (project) => {
      card.project = project
      comments = [{ content: `REVIEW -- ${SHA_A}` }]
      onMain = new Set()
      expect((await landedGuardVerdict('c1', 'done', false, 'backend2')).blocked).toBe(true)
    },
  )
})

describe('force is not a free pass', () => {
  it('honours force only for an exempt actor', async () => {
    comments = [{ content: `REVIEW -- ${SHA_A}` }]
    expect((await landedGuardVerdict('c1', 'done', true, 'mikrob')).blocked).toBe(false)
    // A role agent forcing its own close is the bypass that already happened once with newDevStop.
    expect((await landedGuardVerdict('c1', 'done', true, 'backend2')).blocked).toBe(true)
    expect((await landedGuardVerdict('c1', 'done', true, undefined)).blocked).toBe(true)
  })
})
