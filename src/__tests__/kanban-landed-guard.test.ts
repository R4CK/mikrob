// Card 9cc72f2c point 2: catch an unlanded close BEFORE it happens, not in a sweep afterwards.
//
// The sweep found 39 cards standing on commits that never reached origin/main -- after they were
// closed. The trap was already documented and already had a tool; what was missing is that nothing
// ran at the moment of closing. These tests hold the guard to being narrow: it must block the one
// case it claims, and stay out of the way everywhere else, because a close-path guard that fires on
// anything else is one someone will disable.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const card = { id: 'c1', project: 'cleancore', status: 'waiting' as string | undefined }
// `author` is part of the record the guard reads: a machine-generated comment is not a landing claim
// (card b428f3da). A fixture without it could not tell the two apart, so it defaults here only.
let comments: Array<{ author?: string; content: string }> = []

vi.mock('../db.js', () => ({
  getKanbanCard: () => card,
  getKanbanComments: () => comments.map((c) => ({ author: c.author ?? 'backend2', content: c.content })),
}))
/** Every allow-without-checking line, so "it was logged" is asserted and not assumed. */
export let infoLogs: Array<Record<string, unknown>> = []
vi.mock('../logger.js', () => ({
  logger: { warn: () => {}, info: (o: Record<string, unknown>) => infoLogs.push(o) },
}))

/** git stub: `known` are commits that exist, `onMain` are also reachable from origin/main. */
let known = new Set<string>()
let onMain = new Set<string>()
/** Refs that exist in the repo under test. marveen genuinely has no origin/main. */
let knownRefs = new Set<string>()
/** sha -> its own commit message, what `git log --grep` reads to attribute a commit to a card. */
let messages: Record<string, string> = {}
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
      const grep = a.find((s) => s.startsWith('--grep='))
      if (a.includes('log') && grep !== undefined) {
        // `git log --no-walk --grep=<cardId> <sha>...` prints only the revs whose OWN message
        // matches. An unknown sha simply has no message and so never matches.
        const needle = grep.slice('--grep='.length).toLowerCase()
        const revs = a.slice(a.indexOf('--fixed-strings') + 2)
        cb(null, revs.filter((r) => (messages[r] ?? '').toLowerCase().includes(needle)).join('\n'))
        return
      }
      if (a.includes('--is-ancestor')) {
        const i = a.indexOf('--is-ancestor')
        const sha = a[i + 1]!
        const ref = a[i + 2]!
        // The ref is checked, not ignored. The previous stub answered from a sha set alone, which
        // made the REF NAME invisible -- so the guard asking for a ref that does not exist in this
        // repo (origin/main in marveen) passed every test and would have blocked every marveen card.
        // A stub that discards an argument cannot fail on that argument being wrong.
        if (!knownRefs.has(ref)) {
          cb(new Error(`bad revision ${ref}`), '')
          return
        }
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
  infoLogs = []
  card.project = 'cleancore'
  comments = []
  known = new Set([SHA_A, SHA_B])
  onMain = new Set()
  knownRefs = new Set(['origin/main', 'origin/develop'])
  messages = {}
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

describe('a machine-generated comment is not a landing claim (cards a7b7fe43, f91fcd7e)', () => {
  // The live failure, twice: a `local-llm` 7B draft answered a generic offload sub-task with INVENTED
  // example text that quoted two real CleanCore commits (fcc535b3, 11a366eb). The guard read them as
  // the card's own, found them on main, and let a7b7fe43 close while both of its real commits sat on
  // a branch. A sweep of all 304 done cards found f91fcd7e freed by the very same two hashes.
  it('does NOT let a commit quoted by a local-llm draft free the card', async () => {
    comments = [
      { author: 'fron-ted', content: `REVIEW: kesz, commit ${SHA_A} (local main).` },
      { author: 'local-llm', content: `[LOCAL-LLM DRAFT] pelda: "javitva a ${SHA_B} commitban"` },
    ]
    onMain = new Set([SHA_B]) // the quoted foreign commit really is on main -- that was the trap
    const v = await landedGuardVerdict('c1', 'done', false, 'backend2')
    expect(v.blocked).toBe(true)
    expect(v.message).toContain(SHA_A.slice(0, 8))
    // and the foreign hash is not reported as this card's claim either
    expect(v.message).not.toContain(SHA_B.slice(0, 8))
  })

  it('does NOT let a commit quoted by gate-pretriage free the card', async () => {
    comments = [
      { author: 'backend', content: `REVIEW: kesz, ${SHA_A}` },
      { author: 'gate-pretriage', content: `GATE PRE-TRIAGE (mechanikus, verdict:null) @ ${SHA_B}` },
    ]
    onMain = new Set([SHA_B])
    expect((await landedGuardVerdict('c1', 'done', false, 'backend2')).blocked).toBe(true)
  })

  it('still lets a landed commit named by ANY human/agent comment free the card', async () => {
    // The exclusion is by author, not by phrasing. MikroB's "Landolva: <sha> mergelve main-re" and a
    // gate's "QA PASS -- commit <sha>" are both real landing evidence, and 13 done cards are freed by
    // exactly such a line -- narrowing to the last REVIEW comment would have false-blocked them.
    comments = [
      { author: 'fron-ted', content: `REVIEW: kesz, ${SHA_A}` },
      { author: 'mikrob', content: `Landolva: ${SHA_A} mergelve main-re (${SHA_B}).` },
    ]
    onMain = new Set([SHA_B])
    expect((await landedGuardVerdict('c1', 'done', false, 'backend2')).blocked).toBe(false)
  })

  it('a card whose ONLY sha is in a generated comment becomes an unverified close, not a block', async () => {
    // Skipping the author must not invent a finding: with nothing left to check the guard has no
    // claim to falsify. It says so in the log instead of blocking.
    comments = [{ author: 'local-llm', content: `[LOCAL-LLM DRAFT] pelda commit ${SHA_A}` }]
    onMain = new Set()
    expect((await landedGuardVerdict('c1', 'done', false, 'backend2')).blocked).toBe(false)
    expect(infoLogs[0]).toMatchObject({ reason: 'no-commit-named', skippedGeneratedComments: 1 })
  })
})

describe("a commit is only this card's if its own message says so (QA FAIL 9689 on 9cc72f2c)", () => {
  // QA's scenario, verbatim: the card's own work (SHA_A) never landed, and a comment mentions an
  // unrelated commit (SHA_B) for context -- "same pattern as", "see also". SHA_B is on main, so the
  // old rule closed the card on someone else's work. It is not a rare shape: it freed 3 of the 51
  // cards MikroB had confirmed unlanded, and 4 open done cards are standing on it right now.
  it('does not let a commit belonging to ANOTHER card free this one', async () => {
    comments = [
      { content: `REVIEW -- done @ ${SHA_A}` },
      { content: `for context, the same pattern as ${SHA_B}` },
    ]
    messages = { [SHA_A]: 'fix(x): the thing (card c1)', [SHA_B]: 'feat(y): unrelated (card zz99)' }
    onMain = new Set([SHA_B])
    const v = await landedGuardVerdict('c1', 'done', false, 'backend2')
    expect(v.blocked).toBe(true)
    // and the block names the card's OWN commit, not the foreign one it just discarded
    expect(v.message).toContain(SHA_A.slice(0, 8))
    expect(v.message).not.toContain(SHA_B.slice(0, 8))
  })

  it('allows once the card OWN commit lands, even with the foreign one still quoted', async () => {
    comments = [
      { content: `REVIEW -- done @ ${SHA_A}` },
      { content: `for context, the same pattern as ${SHA_B}` },
    ]
    messages = { [SHA_A]: 'fix(x): the thing (card c1)', [SHA_B]: 'feat(y): unrelated (card zz99)' }
    onMain = new Set([SHA_A, SHA_B])
    expect((await landedGuardVerdict('c1', 'done', false, 'backend2')).blocked).toBe(false)
  })

  it('keeps EVERY candidate when no commit message names the card -- the rebase/cherry-pick case', async () => {
    // The breadth QA explicitly asked us not to destroy: the same work can land under a different sha
    // after a rebase or a conflict-resolved cherry-pick, and plenty of commits carry no card id at
    // all. Narrowing only happens when it has a better answer than the fallback.
    comments = [{ content: `REVIEW -- done @ ${SHA_A}` }, { content: `landed as ${SHA_B}` }]
    messages = { [SHA_A]: 'fix(x): the thing', [SHA_B]: 'fix(x): the thing, rebased' }
    onMain = new Set([SHA_B])
    expect((await landedGuardVerdict('c1', 'done', false, 'backend2')).blocked).toBe(false)
    // It allowed because it CHECKED and found a landing -- not because the narrowing emptied the
    // set and left nothing to check. Without this line, dropping the fallback still passes.
    expect(infoLogs).toHaveLength(0)
  })

  it('falls back to every candidate when the attribution query itself fails', async () => {
    // A checker that cannot answer must not manufacture a block. `messages` empty = git returned
    // nothing, which is indistinguishable from "no commit names this card".
    comments = [{ content: `REVIEW ${SHA_A}` }, { content: `see also ${SHA_B}` }]
    onMain = new Set([SHA_B])
    expect((await landedGuardVerdict('c1', 'done', false, 'backend2')).blocked).toBe(false)
    expect(infoLogs).toHaveLength(0)
  })

  it('does not spend a spawn on attribution when there is only one candidate', async () => {
    comments = [{ content: `REVIEW -- done @ ${SHA_A}` }]
    onMain = new Set([SHA_A])
    await landedGuardVerdict('c1', 'done', false, 'backend2')
    expect(spawns.some((s) => s.some((x) => x.startsWith('--grep=')))).toBe(false)
  })
})

describe('an unverified close is recorded apart from a verified one (card b428f3da)', () => {
  // Both allow. Until they were logged apart, a card the guard never checked was indistinguishable
  // from one it checked and found landed -- 52 of the 304 done cards close this way.
  it('logs a card that names no commit at all', async () => {
    comments = [{ content: 'REVIEW -- 6 user stories verified, no code artefact' }]
    await landedGuardVerdict('c1', 'done', false, 'backend2')
    expect(infoLogs).toHaveLength(1)
    expect(infoLogs[0]).toMatchObject({ cardId: 'c1', reason: 'no-commit-named', namedTokens: 0 })
  })

  it('logs the project-label-vs-real-repo case with its OWN reason (94727c79)', async () => {
    // The card names commit-shaped tokens; none of them exists in the repo its project label maps to,
    // because the work is in the other repo. Same allow, different cause, different line.
    comments = [{ content: 'REVIEW -- kesz, commit ccccccc' }]
    await landedGuardVerdict('c1', 'done', false, 'backend2')
    expect(infoLogs[0]).toMatchObject({ reason: 'named-commits-absent-from-mapped-repo', namedTokens: 1 })
  })

  it('logs an unmapped project instead of waving it through in silence', async () => {
    card.project = 'some-other-product'
    comments = [{ content: `REVIEW -- ${SHA_A}` }]
    await landedGuardVerdict('c1', 'done', false, 'backend2')
    expect(infoLogs[0]).toMatchObject({ reason: 'no-repo-mapping', project: 'some-other-product' })
  })

  it('logs NOTHING when it actually verified the landing -- the line must mean something', async () => {
    comments = [{ content: `REVIEW -- ${SHA_A}` }]
    onMain = new Set([SHA_A])
    expect((await landedGuardVerdict('c1', 'done', false, 'backend2')).blocked).toBe(false)
    expect(infoLogs).toHaveLength(0)
  })

  it('logs nothing on a block, and nothing for a status other than done', async () => {
    comments = [{ content: `REVIEW -- ${SHA_A}` }]
    expect((await landedGuardVerdict('c1', 'done', false, 'backend2')).blocked).toBe(true)
    await landedGuardVerdict('c1', 'waiting', false, 'backend2')
    expect(infoLogs).toHaveLength(0)
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

describe('a declared Gate-SHA cannot be crowded out of the cap by earlier noise (card b7c68890)', () => {
  // Live bug: a heavily-commented card blocked on a stale early branch tip (SHA_A, quoted in an
  // early comment) even though its actual Gate-SHA (SHA_B, in a LATER comment's QA verdict) HAD
  // landed on origin/main -- because 39 earlier, noisier comments each contributed a hex-looking
  // token and filled MAX_CANDIDATES before the loop ever reached the comment naming SHA_B.
  it('still finds a later comment\'s declared Gate-SHA even after 39 earlier comments exhaust the cap', async () => {
    const noisyComments = Array.from({ length: 39 }, (_, i) => ({
      content: `see also card ${i.toString(16).padStart(7, '0')} and commit deadbe${i.toString(16).padStart(2, '0')}`,
    }))
    comments = [
      { content: `first attempt, branch tip ${SHA_A}` },
      ...noisyComments,
      { author: 'qa', content: `QA PASS\nGate-SHA: ${SHA_B}` },
    ]
    onMain = new Set([SHA_B]) // SHA_A never landed; only the declared Gate-SHA did.
    const v = await landedGuardVerdict('c1', 'done', false, 'backend2')
    expect(v.blocked).toBe(false)
  })

  it('collects MULTIPLE comma-separated shas off one Gate-SHA line', async () => {
    comments = [{ author: 'qa', content: `QA PASS\nGate-SHA: ${SHA_A}, ${SHA_B}` }]
    onMain = new Set([SHA_B])
    expect((await landedGuardVerdict('c1', 'done', false, 'backend2')).blocked).toBe(false)
  })

  it('does not treat a Gate-SHA mentioned mid-sentence (not at line start) as declared -- still caught by the generic sweep', async () => {
    // Per root CLAUDE.md 4b: only a line STARTING with "Gate-SHA:" counts as declared. Mid-sentence
    // mentions are not a false negative here though -- the generic sweep still finds the token, this
    // just is not the priority path being tested.
    comments = [{ content: `the Gate-SHA: ${SHA_A} line was quoted mid-sentence` }]
    onMain = new Set([SHA_A])
    expect((await landedGuardVerdict('c1', 'done', false, 'backend2')).blocked).toBe(false)
  })
})

describe('marveen own cards are covered too, on ITS ref (cards 84091afd + Cybersec NO-GO)', () => {
  // marveen integrates on develop and has NO origin/main. Every assertion here runs with only
  // origin/develop existing, so asking for the wrong ref fails instead of passing quietly.
  beforeEach(() => {
    knownRefs = new Set(['origin/develop'])
  })

  it.each(['marveen', 'mikrob-infra', 'fleet-infra', 'mikrob'])(
    'project %s blocks an unlanded commit',
    async (project) => {
      card.project = project
      comments = [{ content: `REVIEW -- ${SHA_A}` }]
      onMain = new Set()
      expect((await landedGuardVerdict('c1', 'done', false, 'backend2')).blocked).toBe(true)
    },
  )

  it.each(['marveen', 'mikrob-infra', 'fleet-infra', 'mikrob'])(
    'project %s ALLOWS a commit that landed on develop -- the regression Cybersec caught',
    async (project) => {
      // This is the one that mattered: with origin/main hardcoded, a correctly landed marveen card
      // was blocked because the ref itself does not resolve. Every close would have failed.
      card.project = project
      comments = [{ content: `REVIEW -- ${SHA_A}` }]
      onMain = new Set([SHA_A])
      expect((await landedGuardVerdict('c1', 'done', false, 'backend2')).blocked).toBe(false)
    },
  )

  it('asks for origin/develop, never origin/main, in a marveen repo', async () => {
    card.project = 'marveen'
    comments = [{ content: `REVIEW -- ${SHA_A}` }]
    onMain = new Set([SHA_A])
    await landedGuardVerdict('c1', 'done', false, 'backend2')
    const refs = spawns.filter((s) => s.includes('--is-ancestor')).map((s) => s[s.indexOf('--is-ancestor') + 2])
    expect(refs.length).toBeGreaterThan(0)
    expect(refs.every((r) => r === 'origin/develop')).toBe(true)
  })

  it('the FETCH names the same branch as the ref, not a hardcoded main', async () => {
    // Found by mutation: asserting only the --is-ancestor ref left the fetch free to pull
    // `origin main`, which does not exist here. It would fail silently and the re-check would then
    // run against a possibly-stale origin/develop -- the same false-block class, one step narrower.
    card.project = 'marveen'
    comments = [{ content: `REVIEW -- ${SHA_A}` }]
    onMain = new Set()
    await landedGuardVerdict('c1', 'done', false, 'backend2')
    const fetches = spawns.filter((s) => s.includes('fetch'))
    expect(fetches.length).toBe(1)
    expect(fetches[0]).toContain('develop')
    expect(fetches[0]).not.toContain('main')
  })

  it('CleanCore still asks for origin/main', async () => {
    card.project = 'cleancore'
    knownRefs = new Set(['origin/main'])
    comments = [{ content: `REVIEW -- ${SHA_A}` }]
    onMain = new Set([SHA_A])
    await landedGuardVerdict('c1', 'done', false, 'backend2')
    const refs = spawns.filter((s) => s.includes('--is-ancestor')).map((s) => s[s.indexOf('--is-ancestor') + 2])
    expect(refs.every((r) => r === 'origin/main')).toBe(true)
  })
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
