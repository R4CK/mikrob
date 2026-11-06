// Card a8a83d48: POST /api/card-landings must independently verify a claimed landing before
// writing the row -- MikroB rescope comment 27940 point 6, hardened after Cybersec2 NO-GO (Gate-SHA
// 6cc529f3d, F1 HIGH) and again after Cybersec2 NO-GO round 2 (Gate-SHA 77e8a3751, F4 HIGH + F5
// MEDIUM).
//
// Round 1: the original check only proved "merge_sha is SOME ancestor of origin"; it never
// validated work_sha, never required work_sha to be an ancestor of merge_sha, and never bound
// card_id to the actual landed commits. Measured live: an unrelated already-landed sha recorded
// ANY card as landed, and a non-sha string ("origin/develop", a 7-char prefix) was accepted and
// stored verbatim.
//
// Round 2: the fix that closed round 1 bound card_id by scanning commit SUBJECTS with a RegExp
// built from the unvalidated card_id -- Cybersec2 measured this hanging the whole process for
// 30+ seconds on a crafted card_id ('(.*)*z'), and separately showed the subject scan itself could
// be defeated (a card merely MENTIONED in a subject, or named in scope form inside an UNRELATED
// commit, got bound as if it were that card's own landed work). Card ids on this board are always
// 8 lowercase hex chars (src/web/routes/kanban.ts: `randomUUID().slice(0, 8)`) -- every id used
// below follows that shape, which is itself part of the fix under test (a malformed id must be
// rejected before any RegExp or git call).
//
// Every case below runs against a REAL local git repo (a bare "origin" plus a working clone), not
// a mocked git call.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

let tmpRoot: string
let originPath: string
let workPath: string

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8' }).trim()
}

function commitFile(dir: string, file: string, content: string, message: string): string {
  execFileSync('bash', ['-c', `echo "${content}" > "${join(dir, file)}"`])
  git(dir, ['add', file])
  git(dir, ['commit', '-q', '-m', message])
  return git(dir, ['rev-parse', 'HEAD'])
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'card-landings-route-'))
  originPath = join(tmpRoot, 'origin.git')
  workPath = join(tmpRoot, 'work')
  git(tmpRoot, ['init', '-q', '--bare', '-b', 'develop', originPath])
  git(tmpRoot, ['clone', '-q', originPath, workPath])
  git(workPath, ['config', 'user.email', 'test@example.com'])
  git(workPath, ['config', 'user.name', 'test'])
  git(workPath, ['checkout', '-q', '-b', 'develop'])
  commitFile(workPath, 'f.txt', 'one', 'init')
  git(workPath, ['push', '-q', 'origin', 'develop'])
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

/** Build a realistic landing: a card-branch commit whose subject names `cardId` (the convention
 *  this fleet's own commits follow: "fix(<id>): ..."), merged with --no-ff into develop and
 *  pushed. Returns the two shas the real land scripts would send -- workSha is the branch tip,
 *  which by construction IS the resulting merge commit's second parent. */
function buildAndPushLanding(cardId: string, file: string): { workSha: string; mergeSha: string } {
  git(workPath, ['checkout', '-q', '-b', `card/${cardId}`])
  const workSha = commitFile(workPath, file, 'card content', `fix(${cardId}): do the thing`)
  git(workPath, ['checkout', '-q', 'develop'])
  git(workPath, ['merge', '-q', '--no-ff', `card/${cardId}`, '-m', `merge: card/${cardId}`])
  const mergeSha = git(workPath, ['rev-parse', 'HEAD'])
  git(workPath, ['push', '-q', 'origin', 'develop'])
  return { workSha, mergeSha }
}

async function importFresh() {
  return await import('../card-landing-ancestry.js')
}

describe('verifyCardLanding (real git, no mocks)', () => {
  it('a real work_sha + merge_sha pair, pushed, for the right card -> ok', async () => {
    process.env.MARVEEN_MAIN = workPath
    const { verifyCardLanding } = await importFresh()
    const { workSha, mergeSha } = buildAndPushLanding('c1111111', 'a.txt')
    const verdict = await verifyCardLanding('marveen', 'c1111111', workSha, mergeSha)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.workSha.toLowerCase()).toBe(workSha.toLowerCase())
      expect(verdict.mergeSha.toLowerCase()).toBe(mergeSha.toLowerCase())
    }
  })

  it('merge_sha never pushed -> not ok, no ancestry claim honored', async () => {
    process.env.MARVEEN_MAIN = workPath
    const { verifyCardLanding } = await importFresh()
    git(workPath, ['checkout', '-q', '-b', 'card/c1111111'])
    const workSha = commitFile(workPath, 'a.txt', 'x', 'fix(c1111111): do the thing')
    git(workPath, ['checkout', '-q', 'develop'])
    git(workPath, ['merge', '-q', '--no-ff', 'card/c1111111', '-m', 'merge: card/c1111111'])
    const mergeSha = git(workPath, ['rev-parse', 'HEAD'])
    // deliberately never pushed
    const verdict = await verifyCardLanding('marveen', 'c1111111', workSha, mergeSha)
    expect(verdict.ok).toBe(false)
  })

  it('CYBERSEC2 F1 repro 1: an UNRELATED already-landed sha cannot land a different card', async () => {
    process.env.MARVEEN_MAIN = workPath
    const { verifyCardLanding } = await importFresh()
    const { mergeSha: unrelatedLandedSha } = buildAndPushLanding('aaaaaaaa', 'b.txt')
    const verdict = await verifyCardLanding('marveen', 'eeeeeeee', 'b'.repeat(40), unrelatedLandedSha)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toMatch(/not a real full-sha commit object/)
  })

  it('CYBERSEC2 F1 repro 2: merge_sha as a ref name ("origin/develop") is rejected, not stored', async () => {
    process.env.MARVEEN_MAIN = workPath
    const { verifyCardLanding } = await importFresh()
    const verdict = await verifyCardLanding('marveen', 'c1111111', 'a'.repeat(40), 'origin/develop')
    expect(verdict.ok).toBe(false)
  })

  it('CYBERSEC2 F1 repro 3: a 7-char sha prefix is rejected, not stored verbatim', async () => {
    process.env.MARVEEN_MAIN = workPath
    const { verifyCardLanding } = await importFresh()
    const { mergeSha } = buildAndPushLanding('c1111111', 'a.txt')
    const verdict = await verifyCardLanding('marveen', 'c1111111', 'a'.repeat(40), mergeSha.slice(0, 7))
    expect(verdict.ok).toBe(false)
  })

  it('work_sha real + pushed but NOT an ancestor of merge_sha -> not ok (binding, not just existence)', async () => {
    process.env.MARVEEN_MAIN = workPath
    const { verifyCardLanding } = await importFresh()
    // A real, pushed, unrelated commit on its own branch (never merged into the merge_sha we test).
    git(workPath, ['checkout', '-q', '-b', 'card/bbbbbbbb'])
    const unrelatedWorkSha = commitFile(workPath, 'other.txt', 'y', 'fix(bbbbbbbb): unrelated')
    git(workPath, ['push', '-q', 'origin', 'card/bbbbbbbb'])
    git(workPath, ['checkout', '-q', 'develop'])
    const { mergeSha } = buildAndPushLanding('c1111111', 'a.txt')
    const verdict = await verifyCardLanding('marveen', 'c1111111', unrelatedWorkSha, mergeSha)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toMatch(/not an ancestor of merge_sha/)
  })

  it('a sha that is not a real commit at all -> not ok, never throws', async () => {
    process.env.MARVEEN_MAIN = workPath
    const { verifyCardLanding } = await importFresh()
    const verdict = await verifyCardLanding('marveen', 'c1111111', 'f'.repeat(40), 'e'.repeat(40))
    expect(verdict.ok).toBe(false)
  })

  it('an unknown repo name -> not ok without touching any path', async () => {
    const { verifyCardLanding } = await importFresh()
    const verdict = await verifyCardLanding('not-a-real-repo', 'c1111111', 'f'.repeat(40), 'e'.repeat(40))
    expect(verdict.ok).toBe(false)
  })

  it('CYBERSEC2 F2 pin: a hung remote returns bounded, not hung forever', async () => {
    // A TCP listener that accepts and never answers -- simulates a hung remote (the card text's
    // own example: a GitHub SSH flap). GIT_TIMEOUT_MS is overridden small so the test does not
    // wait out the real 20s default.
    const srv = net.createServer(() => { /* accept, never write, never close */ })
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const port = (srv.address() as net.AddressInfo).port
    git(workPath, ['remote', 'set-url', 'origin', `git://127.0.0.1:${port}/nope`])

    process.env.MARVEEN_MAIN = workPath
    process.env.CARD_LANDING_GIT_TIMEOUT_MS = '500'
    const { verifyCardLanding } = await importFresh()
    const start = Date.now()
    const verdict = await verifyCardLanding('marveen', 'c1111111', 'a'.repeat(40), 'b'.repeat(40))
    const elapsed = Date.now() - start
    srv.close()
    delete process.env.CARD_LANDING_GIT_TIMEOUT_MS

    expect(verdict.ok).toBe(false)
    expect(elapsed).toBeLessThan(5000) // bounded by the 500ms override, not hung
  })

  it('fetches fresh: a landing pushed from elsewhere after this checkout last fetched still verifies', async () => {
    const otherClone = join(tmpRoot, 'other-clone')
    git(tmpRoot, ['clone', '-q', originPath, otherClone])
    git(otherClone, ['config', 'user.email', 'test@example.com'])
    git(otherClone, ['config', 'user.name', 'test'])
    git(otherClone, ['checkout', '-q', 'develop'])
    git(otherClone, ['checkout', '-q', '-b', 'card/c1111111'])
    const workSha = commitFile(otherClone, 'c.txt', 'z', 'fix(c1111111): elsewhere')
    git(otherClone, ['checkout', '-q', 'develop'])
    git(otherClone, ['merge', '-q', '--no-ff', 'card/c1111111', '-m', 'merge: card/c1111111'])
    const mergeSha = git(otherClone, ['rev-parse', 'HEAD'])
    git(otherClone, ['push', '-q', 'origin', 'develop'])

    process.env.MARVEEN_MAIN = workPath // workPath has NOT fetched this new commit yet
    const { verifyCardLanding } = await importFresh()
    const verdict = await verifyCardLanding('marveen', 'c1111111', workSha, mergeSha)
    expect(verdict.ok).toBe(true)
  })

  // --- Cybersec2 NO-GO round 2 (Gate-SHA 77e8a3751) ---------------------------------------------

  it('CYBERSEC2 F4 pin: a ReDoS-shaped card_id is rejected synchronously, before any git call', async () => {
    process.env.MARVEEN_MAIN = workPath
    const { verifyCardLanding } = await importFresh()
    const { workSha, mergeSha } = buildAndPushLanding('c1111111', 'a.txt')
    const start = Date.now()
    const verdict = await verifyCardLanding('marveen', '(.*)*z', workSha, mergeSha)
    const elapsed = Date.now() - start
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toMatch(/8-character lowercase hex/)
    expect(elapsed).toBeLessThan(50)
  })

  it('CYBERSEC2 F4 pin: a second catastrophic-backtracking pattern is also rejected fast', async () => {
    process.env.MARVEEN_MAIN = workPath
    const { verifyCardLanding } = await importFresh()
    const start = Date.now()
    const verdict = await verifyCardLanding('marveen', '([a-z ]+)+9', 'a'.repeat(40), 'b'.repeat(40))
    const elapsed = Date.now() - start
    expect(verdict.ok).toBe(false)
    expect(elapsed).toBeLessThan(50)
  })

  it('a card_id with the right length but non-hex characters is rejected (not just length-checked)', async () => {
    const { verifyCardLanding } = await importFresh()
    const verdict = await verifyCardLanding('marveen', 'NOTHEX12', 'a'.repeat(40), 'b'.repeat(40))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toMatch(/8-character lowercase hex/)
  })

  it('CYBERSEC2 F5 repro 1: a card merely MENTIONED in a commit subject is not bound by that mention alone', async () => {
    // Card c3333333's branch carries two commits: one naming c3333333 itself, one whose subject
    // mentions a DIFFERENT card (eeeeeeee) in prose -- exactly Cybersec2's "follow-up to card
    // bbbbbbbb" repro shape. eeeeeeee never did any work of its own.
    process.env.MARVEEN_MAIN = workPath
    const { verifyCardLanding } = await importFresh()
    git(workPath, ['checkout', '-q', '-b', 'card/c3333333'])
    commitFile(workPath, 'a.txt', 'one', 'feat(c3333333): work C, follow-up to card eeeeeeee')
    const workSha = commitFile(workPath, 'b.txt', 'two', 'fix(c3333333): finish up')
    git(workPath, ['checkout', '-q', 'develop'])
    git(workPath, ['merge', '-q', '--no-ff', 'card/c3333333', '-m', 'merge: card/c3333333'])
    const mergeSha = git(workPath, ['rev-parse', 'HEAD'])
    git(workPath, ['push', '-q', 'origin', 'develop'])

    // eeeeeeee is only named in prose, inside a DIFFERENT commit than the branch tip (workSha).
    // The old subject-scan bound it anyway (F5 round 1 repro). The new structural check does not:
    // eeeeeeee's own work_sha was never captured -- the ONLY work_sha usable here is c3333333's
    // own tip, and posting eeeeeeee with an UNRELATED work_sha (never the second parent of this
    // merge) must fail.
    const verdict = await verifyCardLanding('marveen', 'eeeeeeee', 'd'.repeat(40), mergeSha)
    expect(verdict.ok).toBe(false)
    // Sanity: the real card (c3333333, with its real tip) still verifies.
    const realVerdict = await verifyCardLanding('marveen', 'c3333333', workSha, mergeSha)
    expect(realVerdict.ok).toBe(true)
  })

  it('CYBERSEC2 F5 repro 2: scope-form mention of another card in a non-tip commit does not bind it either', async () => {
    // Mirrors the exact repro: card C's SECOND commit uses scope form naming a different card
    // ("fix(eeeeeeee): sneaky scope-form id for another card"), so the branch tip IS that subject,
    // but eeeeeeee did no real work -- what matters structurally is work_sha, which the caller
    // must supply, not infer from the subject.
    process.env.MARVEEN_MAIN = workPath
    const { verifyCardLanding } = await importFresh()
    git(workPath, ['checkout', '-q', '-b', 'card/c3333333'])
    const firstCommit = commitFile(workPath, 'a.txt', 'one', 'feat(c3333333): work C, follow-up to card eeeeeeee')
    commitFile(workPath, 'b.txt', 'two', 'fix(eeeeeeee): sneaky scope-form id for another card')
    git(workPath, ['checkout', '-q', 'develop'])
    git(workPath, ['merge', '-q', '--no-ff', 'card/c3333333', '-m', 'merge: card/c3333333'])
    const mergeSha = git(workPath, ['rev-parse', 'HEAD'])
    git(workPath, ['push', '-q', 'origin', 'develop'])

    // A caller claiming eeeeeeee's work_sha is the FIRST commit of C's branch (not the tip, not
    // the merge's second parent) must fail -- that commit is a real, pushed, reachable commit,
    // but it is not what the merge's second-parent pointer names.
    const verdict = await verifyCardLanding('marveen', 'eeeeeeee', firstCommit, mergeSha)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toMatch(/second parent/)
  })

  it('CYBERSEC2 F5 repro 3: a caller-chosen wide range (another card\'s tip + this card\'s merge) is rejected', async () => {
    // "card C posted with work_sha = ANOTHER card's tip and C's merge" -- under the old scheme the
    // caller-chosen range let this pass because BOTH landings' subjects were in range. The new
    // check has no range at all: only merge_sha's own, single, structural second parent counts.
    process.env.MARVEEN_MAIN = workPath
    const { verifyCardLanding } = await importFresh()
    const { workSha: otherTip } = buildAndPushLanding('aaaaaaaa', 'x.txt')
    const { mergeSha: cMerge } = buildAndPushLanding('c1111111', 'y.txt')
    const verdict = await verifyCardLanding('marveen', 'c1111111', otherTip, cMerge)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toMatch(/second parent/)
  })

  it('a merge_sha with only one parent (fast-forward, not a real merge) has no second parent -> not ok', async () => {
    process.env.MARVEEN_MAIN = workPath
    const { verifyCardLanding } = await importFresh()
    const workSha = commitFile(workPath, 'a.txt', 'x', 'fix(c1111111): ff commit')
    git(workPath, ['push', '-q', 'origin', 'develop'])
    const verdict = await verifyCardLanding('marveen', 'c1111111', workSha, workSha)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toMatch(/no second parent/)
  })
})

describe('POST /api/card-landings (route-level, real git)', () => {
  function fakeCtx(bodyObj: unknown): { ctx: any; out: { status: number; body: any } } {
    const out = { status: 0, body: null as any }
    const res: any = {
      writeHead(status: number) { out.status = status; return res },
      end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    }
    const req = new EventEmitter() as any
    req.destroy = () => {}
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(bodyObj)))
      req.emit('end')
    })
    return { ctx: { req, res, path: '/api/card-landings', method: 'POST', url: new URL('http://localhost/api/card-landings') }, out }
  }

  it('writes the row (both shas, resolved) only after independently verifying the full binding', async () => {
    process.env.MARVEEN_MAIN = workPath
    const { initDatabase, createKanbanCard, listCardLandings } = await import('../db.js')
    initDatabase(':memory:')
    createKanbanCard({ id: 'c1111111', title: 'card one' })
    const { tryHandleCardLandings } = await import('../web/routes/card-landings.js')
    const { workSha, mergeSha } = buildAndPushLanding('c1111111', 'a.txt')
    const { ctx, out } = fakeCtx({ card_id: 'c1111111', work_sha: workSha, merge_sha: mergeSha, repo: 'marveen', landed_by: 'backend3' })
    expect(await tryHandleCardLandings(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    const rows = listCardLandings('c1111111')
    expect(rows).toHaveLength(1)
    expect(rows[0].work_sha.toLowerCase()).toBe(workSha.toLowerCase())
    expect(rows[0].merge_sha.toLowerCase()).toBe(mergeSha.toLowerCase())
  })

  it('422s and writes NOTHING for a merge_sha that was never pushed (push-failure shape)', async () => {
    process.env.MARVEEN_MAIN = workPath
    const { initDatabase, createKanbanCard, listCardLandings } = await import('../db.js')
    initDatabase(':memory:')
    createKanbanCard({ id: 'c1111111', title: 'card one' })
    const { tryHandleCardLandings } = await import('../web/routes/card-landings.js')
    git(workPath, ['checkout', '-q', '-b', 'card/c1111111'])
    const workSha = commitFile(workPath, 'a.txt', 'x', 'fix(c1111111): do the thing')
    git(workPath, ['checkout', '-q', 'develop'])
    git(workPath, ['merge', '-q', '--no-ff', 'card/c1111111', '-m', 'merge: card/c1111111'])
    const unpushedMergeSha = git(workPath, ['rev-parse', 'HEAD'])
    const { ctx, out } = fakeCtx({ card_id: 'c1111111', work_sha: workSha, merge_sha: unpushedMergeSha, repo: 'marveen', landed_by: 'backend3' })
    expect(await tryHandleCardLandings(ctx)).toBe(true)
    expect(out.status).toBe(422)
    expect(listCardLandings('c1111111')).toHaveLength(0)
  })

  it('CYBERSEC2 F1 pin: an unrelated landed sha posted for a different card is 422, not a fabricated landing', async () => {
    process.env.MARVEEN_MAIN = workPath
    const { initDatabase, createKanbanCard, listCardLandings } = await import('../db.js')
    initDatabase(':memory:')
    createKanbanCard({ id: 'eeeeeeee', title: 'never actually touched' })
    const { tryHandleCardLandings } = await import('../web/routes/card-landings.js')
    const { mergeSha: unrelatedLandedSha } = buildAndPushLanding('aaaaaaaa', 'b.txt')
    const { ctx, out } = fakeCtx({
      card_id: 'eeeeeeee',
      work_sha: 'b'.repeat(40),
      merge_sha: unrelatedLandedSha,
      repo: 'marveen',
      landed_by: 'mikrob',
    })
    expect(await tryHandleCardLandings(ctx)).toBe(true)
    expect(out.status).toBe(422)
    expect(listCardLandings('eeeeeeee')).toHaveLength(0)
  })

  it('CYBERSEC2 F4 pin (route level): a ReDoS-shaped card_id is 400 in well under a second, no git call made', async () => {
    process.env.MARVEEN_MAIN = workPath
    const { initDatabase } = await import('../db.js')
    initDatabase(':memory:')
    const { tryHandleCardLandings } = await import('../web/routes/card-landings.js')
    const start = Date.now()
    const { ctx, out } = fakeCtx({
      card_id: '(.*)*z',
      work_sha: 'a'.repeat(40),
      merge_sha: 'b'.repeat(40),
      repo: 'marveen',
      landed_by: 'backend3',
    })
    expect(await tryHandleCardLandings(ctx)).toBe(true)
    const elapsed = Date.now() - start
    expect(out.status).toBe(400)
    expect(elapsed).toBeLessThan(50)
  })

  it('CYBERSEC2 F5 pin (route level): work_sha that is not merge_sha\'s second parent is 422', async () => {
    process.env.MARVEEN_MAIN = workPath
    const { initDatabase, createKanbanCard, listCardLandings } = await import('../db.js')
    initDatabase(':memory:')
    createKanbanCard({ id: 'c1111111', title: 'card one' })
    const { tryHandleCardLandings } = await import('../web/routes/card-landings.js')
    const { workSha: otherTip } = buildAndPushLanding('aaaaaaaa', 'x.txt')
    const { mergeSha: cMerge } = buildAndPushLanding('c1111111', 'y.txt')
    const { ctx, out } = fakeCtx({ card_id: 'c1111111', work_sha: otherTip, merge_sha: cMerge, repo: 'marveen', landed_by: 'backend3' })
    expect(await tryHandleCardLandings(ctx)).toBe(true)
    expect(out.status).toBe(422)
    expect(listCardLandings('c1111111')).toHaveLength(0)
  })
})
