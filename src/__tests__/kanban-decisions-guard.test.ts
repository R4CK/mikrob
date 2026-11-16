// Card 9b1ccbca: five cards failed QA on 2026-09-25 purely over a missing DECISIONS.md entry
// (197947ae, dac2e52b, c2aeefa5, 2564e877, f4cd1783, 9163495b) -- the code itself was fine every
// time. These tests hold the guard to the two things it claims: warn (never block) a trivial card,
// and block a non-trivial ([FÁZIS]/[FELADAT]/HIGH/URGENT/[SEC]) card, both ONLY when the declared
// Gate-SHA's own diff carries no DECISIONS.md line naming the card's id.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const card = { id: 'c1', project: 'marveen', status: 'in_progress' as string | undefined, title: 'plain card', priority: 'normal' as string | null }
let comments: Array<{ author?: string; content: string; created_at?: number }> = []
export let addedComments: Array<{ cardId: string; author: string; content: string }> = []

vi.mock('../db.js', () => ({
  getKanbanCard: () => card,
  getKanbanComments: () => comments.map((c) => ({ author: c.author ?? 'backend', content: c.content, created_at: c.created_at ?? 0 })),
  addKanbanComment: (cardId: string, author: string, content: string) => {
    addedComments.push({ cardId, author, content })
  },
  updateKanbanCard: () => true,
  listKanbanCards: () => [],
}))
vi.mock('../logger.js', () => ({
  logger: { warn: () => {}, info: () => {} },
}))

/** git diff stub: `decisionsDiff` is the raw `git diff <sha>^1 <sha> -- DECISIONS.md` stdout. */
let decisionsDiff = ''
// Per-sha override (card a5f5cfd8): decisionsEntryState() is called with ONE sha per invocation,
// but a test asserting "latest REVIEW's Gate-SHA wins" needs two DIFFERENT shas to resolve to
// two DIFFERENT diffs in the same test. Empty by default -- falls back to the single `decisionsDiff`
// above, so every pre-existing test (one sha per test) is untouched.
let decisionsDiffBySha: Record<string, string> = {}
let diffShouldFail = false
export let diffCalls: string[][] = []
vi.mock('node:child_process', () => ({
  execFile: (
    _cmd: string,
    args: readonly string[],
    _opts: unknown,
    cb: (e: Error | null, out: string) => void,
  ) => {
    const a = [...args]
    diffCalls.push(a)
    queueMicrotask(() => {
      if (a.includes('diff')) {
        if (diffShouldFail) { cb(new Error('bad revision'), ''); return }
        const sha = a[5] // git() prepends ['-C', repo, ...]: ['-C', repo, 'diff', '--no-color', `${sha}^1`, sha, '--', 'DECISIONS.md']
        cb(null, (sha !== undefined && sha in decisionsDiffBySha) ? decisionsDiffBySha[sha]! : decisionsDiff)
        return
      }
      cb(null, '')
    })
    return { stdin: { end: () => {} } }
  },
}))
vi.mock('node:fs', () => ({ existsSync: () => true }))

const { decisionsGuardVerdict, decisionsGuardCheck } = await import('../web/kanban-decisions-guard.js')

const SHA = 'cafefeed'

beforeEach(() => {
  card.project = 'marveen'
  card.status = 'in_progress'
  card.title = 'plain card'
  card.priority = 'normal'
  comments = []
  addedComments = []
  decisionsDiff = ''
  decisionsDiffBySha = {}
  diffShouldFail = false
  diffCalls = []
})

describe('decisionsGuardVerdict (blocking path, non-trivial cards only)', () => {
  it('blocks a HIGH-priority card whose Gate-SHA diff names no DECISIONS.md line for this card', async () => {
    card.priority = 'high'
    comments = [{ content: `REVIEW: done\nGate-SHA: ${SHA}` }]
    decisionsDiff = '+something unrelated\n+another line (card 00000000)\n'
    const v = await decisionsGuardVerdict('c1', 'waiting', false, 'fullstack')
    expect(v.blocked).toBe(true)
    expect(v.message).toContain(SHA)
    expect(v.message).toContain('c1')
  })

  it('allows the same HIGH-priority card once the diff has an added line naming the card id', async () => {
    card.priority = 'high'
    comments = [{ content: `REVIEW: done\nGate-SHA: ${SHA}` }]
    decisionsDiff = '+## 2026-10-17 -- döntés a c1 kártyán\n+leírás...\n'
    const v = await decisionsGuardVerdict('c1', 'waiting', false, 'fullstack')
    expect(v.blocked).toBe(false)
  })

  // Card a5f5cfd8 (backend2 report on 12d91d4b, msg 19979): the guard already sources its sha
  // from latestReviewGateSha() -- the LATEST comment matching `/^\s*REVIEW\b/im`, same convention
  // gate-closure-check.py's declared_shas() uses (card 3e4dc2c3: a non-REVIEW comment's Gate-SHA
  // must never sink an otherwise-correct round). A plain follow-up comment that only MENTIONS a
  // corrected Gate-SHA -- without a line opening with "REVIEW" -- does NOT count; these two tests
  // pin that this is working as designed, not a bug: with two REAL REVIEW comments, the LATER
  // one's sha is the one checked, either way.
  it('two REVIEW comments: only the LATER sha carries the DECISIONS entry -> move allowed', async () => {
    card.priority = 'high'
    const SHA_OLD = 'aaaaaaaa'
    const SHA_NEW = 'bbbbbbbb'
    comments = [
      { content: `REVIEW: first pass\nGate-SHA: ${SHA_OLD}`, created_at: 1 },
      { content: `REVIEW: corrected\nGate-SHA: ${SHA_NEW}`, created_at: 2 },
    ]
    decisionsDiffBySha = {
      [SHA_OLD]: '+unrelated\n',
      [SHA_NEW]: '+## decision for c1\n',
    }
    const v = await decisionsGuardVerdict('c1', 'waiting', false, 'fullstack')
    expect(v.blocked).toBe(false)
  })

  it('two REVIEW comments: only the EARLIER sha carries the DECISIONS entry -> refused, citing the later sha', async () => {
    card.priority = 'high'
    const SHA_OLD = 'aaaaaaaa'
    const SHA_NEW = 'bbbbbbbb'
    comments = [
      { content: `REVIEW: first pass\nGate-SHA: ${SHA_OLD}`, created_at: 1 },
      { content: `REVIEW: corrected\nGate-SHA: ${SHA_NEW}`, created_at: 2 },
    ]
    decisionsDiffBySha = {
      [SHA_OLD]: '+## decision for c1\n',
      [SHA_NEW]: '+unrelated\n',
    }
    const v = await decisionsGuardVerdict('c1', 'waiting', false, 'fullstack')
    expect(v.blocked).toBe(true)
    expect(v.message).toContain(SHA_NEW)
    expect(v.message).not.toContain(SHA_OLD)
  })

  it('a plain follow-up comment (no line opening with "REVIEW") does not override the prior REVIEW\'s sha', async () => {
    card.priority = 'high'
    const SHA_REVIEW = 'aaaaaaaa'
    const SHA_MENTIONED = 'bbbbbbbb'
    comments = [
      { content: `REVIEW: done\nGate-SHA: ${SHA_REVIEW}`, created_at: 1 },
      { content: `Follow-up to the REVIEW above, corrected Gate-SHA: ${SHA_MENTIONED}`, created_at: 2 },
    ]
    decisionsDiffBySha = {
      [SHA_REVIEW]: '+## decision for c1\n',
      [SHA_MENTIONED]: '+unrelated\n',
    }
    const v = await decisionsGuardVerdict('c1', 'waiting', false, 'fullstack')
    expect(v.blocked).toBe(false)
    expect(diffCalls.some((a) => a.includes(SHA_MENTIONED))).toBe(false)
  })

  it('does NOT block a plain normal-priority, untagged card -- only warns (separate test below)', async () => {
    card.priority = 'normal'
    comments = [{ content: `REVIEW: done\nGate-SHA: ${SHA}` }]
    decisionsDiff = '+unrelated\n'
    const v = await decisionsGuardVerdict('c1', 'waiting', false, 'fullstack')
    expect(v.blocked).toBe(false)
  })

  it('does not block a [SEC]-tagged card once the id is present, case-insensitively', async () => {
    card.title = '[SEC] trust boundary fix'
    comments = [{ content: `REVIEW: done\nGate-SHA: ${SHA}` }]
    decisionsDiff = '+decision about C1 here\n'
    const v = await decisionsGuardVerdict('c1', 'waiting', false, 'fullstack')
    expect(v.blocked).toBe(false)
  })

  it('a bare mention WITHOUT a leading "+" (context/removed line) does not satisfy it', async () => {
    card.priority = 'urgent'
    comments = [{ content: `REVIEW: done\nGate-SHA: ${SHA}` }]
    // ' context line' and '-removed line' both mention c1 but neither was ADDED by this diff.
    decisionsDiff = ' context mentions c1\n-removed c1 line\n'
    const v = await decisionsGuardVerdict('c1', 'waiting', false, 'fullstack')
    expect(v.blocked).toBe(true)
  })

  it('the `+++ b/DECISIONS.md` file header itself never satisfies the check', async () => {
    card.priority = 'urgent'
    comments = [{ content: `REVIEW: done\nGate-SHA: ${SHA}` }]
    decisionsDiff = '+++ b/DECISIONS.md -- card c1\n'
    const v = await decisionsGuardVerdict('c1', 'waiting', false, 'fullstack')
    expect(v.blocked).toBe(true)
  })

  it('allows (no claim to check) when the REVIEW names no Gate-SHA at all', async () => {
    card.priority = 'urgent'
    comments = [{ content: 'REVIEW: config-only, Gate-SHA: n/a (config-only)' }]
    const v = await decisionsGuardVerdict('c1', 'waiting', false, 'fullstack')
    expect(v.blocked).toBe(false)
    expect(diffCalls.length).toBe(0)
  })

  it('allows (unmapped project) when the card project has no repo mapping', async () => {
    card.priority = 'urgent'
    card.project = 'ingatlan'
    comments = [{ content: `REVIEW: done\nGate-SHA: ${SHA}` }]
    const v = await decisionsGuardVerdict('c1', 'waiting', false, 'fullstack')
    expect(v.blocked).toBe(false)
    expect(diffCalls.length).toBe(0)
  })

  it('force actor bypasses the block', async () => {
    card.priority = 'urgent'
    comments = [{ content: `REVIEW: done\nGate-SHA: ${SHA}` }]
    decisionsDiff = '+unrelated\n'
    const v = await decisionsGuardVerdict('c1', 'waiting', true, 'mikrob')
    expect(v.blocked).toBe(false)
  })

  it('a non-waiting target status is never in scope', async () => {
    card.priority = 'urgent'
    comments = [{ content: `REVIEW: done\nGate-SHA: ${SHA}` }]
    decisionsDiff = '+unrelated\n'
    const v = await decisionsGuardVerdict('c1', 'in_progress', false, 'fullstack')
    expect(v.blocked).toBe(false)
  })

  it('re-asserting an already-waiting status is not a fresh hand-off', async () => {
    card.priority = 'urgent'
    card.status = 'waiting'
    comments = [{ content: `REVIEW: done\nGate-SHA: ${SHA}` }]
    decisionsDiff = '+unrelated\n'
    const v = await decisionsGuardVerdict('c1', 'waiting', false, 'fullstack')
    expect(v.blocked).toBe(false)
  })

  it('fails open (allows) when git cannot resolve the diff at all', async () => {
    card.priority = 'urgent'
    comments = [{ content: `REVIEW: done\nGate-SHA: ${SHA}` }]
    diffShouldFail = true
    const v = await decisionsGuardVerdict('c1', 'waiting', false, 'fullstack')
    expect(v.blocked).toBe(false)
  })
})

describe('decisionsGuardCheck (warn-only side effect, trivial cards only)', () => {
  it('posts a warning comment for a plain card with a missing DECISIONS.md entry', async () => {
    card.priority = 'normal'
    comments = [{ content: `REVIEW: done\nGate-SHA: ${SHA}` }]
    decisionsDiff = '+unrelated\n'
    await decisionsGuardCheck('c1', 'in_progress', 'waiting', 'fullstack')
    expect(addedComments.length).toBe(1)
    expect(addedComments[0]!.content).toContain(SHA)
    expect(addedComments[0]!.content).toContain('WARN')
  })

  it('never posts when the entry is present', async () => {
    card.priority = 'normal'
    comments = [{ content: `REVIEW: done\nGate-SHA: ${SHA}` }]
    decisionsDiff = '+decision about c1\n'
    await decisionsGuardCheck('c1', 'in_progress', 'waiting', 'fullstack')
    expect(addedComments.length).toBe(0)
  })

  it('never posts twice for the same Gate-SHA', async () => {
    card.priority = 'normal'
    comments = [
      { author: 'fullstack', content: `REVIEW: done\nGate-SHA: ${SHA}` },
      { author: 'decisions-guard', content: `DECISIONS-ŐRSÉG WARN already said ${SHA}` },
    ]
    decisionsDiff = '+unrelated\n'
    await decisionsGuardCheck('c1', 'in_progress', 'waiting', 'fullstack')
    expect(addedComments.length).toBe(0)
  })

  it('skips a non-trivial card entirely -- that path is decisionsGuardVerdict\'s job', async () => {
    card.priority = 'high'
    comments = [{ content: `REVIEW: done\nGate-SHA: ${SHA}` }]
    decisionsDiff = '+unrelated\n'
    await decisionsGuardCheck('c1', 'in_progress', 'waiting', 'fullstack')
    expect(addedComments.length).toBe(0)
  })

  it('does nothing on a transition other than into waiting', async () => {
    card.priority = 'normal'
    comments = [{ content: `REVIEW: done\nGate-SHA: ${SHA}` }]
    decisionsDiff = '+unrelated\n'
    await decisionsGuardCheck('c1', 'planned', 'in_progress', 'fullstack')
    expect(addedComments.length).toBe(0)
  })

  it('DECISIONS_GUARD=off disables the side effect entirely', async () => {
    process.env['DECISIONS_GUARD'] = 'off'
    try {
      card.priority = 'normal'
      comments = [{ content: `REVIEW: done\nGate-SHA: ${SHA}` }]
      decisionsDiff = '+unrelated\n'
      await decisionsGuardCheck('c1', 'in_progress', 'waiting', 'fullstack')
      expect(addedComments.length).toBe(0)
    } finally {
      delete process.env['DECISIONS_GUARD']
    }
  })
})
