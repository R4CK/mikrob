// Card a8a83d48: POST /api/card-landings must independently verify a claimed landing (merge_sha
// is a real ancestor of origin's default branch) before writing the row -- MikroB rescope comment
// 27940 point 6. This exercises the real handler against a REAL local git repo (a bare "origin"
// plus a working clone), not a mocked git call, so the test can fail for the right reason: a sha
// that was never actually pushed must be rejected, a sha that was must be accepted.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tmpRoot: string
let originPath: string
let workPath: string

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8' }).trim()
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
  execFileSync('bash', ['-c', `echo one > "${join(workPath, 'f.txt')}"`])
  git(workPath, ['add', 'f.txt'])
  git(workPath, ['commit', '-q', '-m', 'init'])
  git(workPath, ['push', '-q', 'origin', 'develop'])
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function importFresh() {
  // Re-import per test so the module-scope env vars (MARVEEN_MAIN) are read fresh -- vi.resetModules
  // would also work, but a dynamic import with a fresh env is simpler here since the module has no
  // other state to reset.
  return await import('../card-landing-ancestry.js')
}

describe('verifyLandedOnDefaultBranch (real git, no mocks)', () => {
  it('a commit actually pushed to origin/develop verifies true', async () => {
    process.env.MARVEEN_MAIN = workPath
    const { verifyLandedOnDefaultBranch } = await importFresh()
    const sha = git(workPath, ['rev-parse', 'HEAD'])
    expect(await verifyLandedOnDefaultBranch('marveen', sha)).toBe(true)
  })

  it('a commit that exists locally but was NEVER pushed verifies false', async () => {
    process.env.MARVEEN_MAIN = workPath
    const { verifyLandedOnDefaultBranch } = await importFresh()
    execFileSync('bash', ['-c', `echo two > "${join(workPath, 'g.txt')}"`])
    git(workPath, ['add', 'g.txt'])
    git(workPath, ['commit', '-q', '-m', 'unpushed'])
    const unpushedSha = git(workPath, ['rev-parse', 'HEAD'])
    expect(await verifyLandedOnDefaultBranch('marveen', unpushedSha)).toBe(false)
  })

  it('a sha that is not a real commit at all verifies false, never throws', async () => {
    process.env.MARVEEN_MAIN = workPath
    const { verifyLandedOnDefaultBranch } = await importFresh()
    expect(await verifyLandedOnDefaultBranch('marveen', 'f'.repeat(40))).toBe(false)
  })

  it('an unknown repo name verifies false without touching any path', async () => {
    const { verifyLandedOnDefaultBranch } = await importFresh()
    expect(await verifyLandedOnDefaultBranch('not-a-real-repo', 'f'.repeat(40))).toBe(false)
  })

  it('fetches fresh: a sha pushed to origin AFTER this checkout last fetched still verifies true', async () => {
    // Simulates the real scenario: the land script's own worktree pushed the sha, but THIS
    // server process's checkout (workPath here) has not fetched since. The function must fetch
    // itself, not trust a stale local origin/develop ref.
    const otherClone = join(tmpRoot, 'other-clone')
    git(tmpRoot, ['clone', '-q', originPath, otherClone])
    git(otherClone, ['config', 'user.email', 'test@example.com'])
    git(otherClone, ['config', 'user.name', 'test'])
    git(otherClone, ['checkout', '-q', 'develop'])
    execFileSync('bash', ['-c', `echo three > "${join(otherClone, 'h.txt')}"`])
    git(otherClone, ['add', 'h.txt'])
    git(otherClone, ['commit', '-q', '-m', 'pushed from elsewhere'])
    git(otherClone, ['push', '-q', 'origin', 'develop'])
    const freshSha = git(otherClone, ['rev-parse', 'HEAD'])

    process.env.MARVEEN_MAIN = workPath // workPath has NOT fetched this new commit yet
    const { verifyLandedOnDefaultBranch } = await importFresh()
    expect(await verifyLandedOnDefaultBranch('marveen', freshSha)).toBe(true)
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

  it('writes the row (both shas) only after independently verifying merge_sha landed', async () => {
    process.env.MARVEEN_MAIN = workPath
    const { initDatabase, createKanbanCard } = await import('../db.js')
    initDatabase(':memory:')
    createKanbanCard({ id: 'c1', title: 'card one' })
    const { tryHandleCardLandings } = await import('../web/routes/card-landings.js')
    const mergeSha = git(workPath, ['rev-parse', 'HEAD'])
    const { ctx, out } = fakeCtx({ card_id: 'c1', work_sha: 'a'.repeat(40), merge_sha: mergeSha, repo: 'marveen', landed_by: 'backend3' })
    expect(await tryHandleCardLandings(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    const { listCardLandings } = await import('../db.js')
    const rows = listCardLandings('c1')
    expect(rows).toHaveLength(1)
    expect(rows[0].work_sha).toBe('a'.repeat(40))
    expect(rows[0].merge_sha).toBe(mergeSha)
  })

  it('422s and writes NOTHING for a merge_sha that was never pushed (push-failure shape)', async () => {
    process.env.MARVEEN_MAIN = workPath
    const { initDatabase, createKanbanCard, listCardLandings } = await import('../db.js')
    initDatabase(':memory:')
    createKanbanCard({ id: 'c1', title: 'card one' })
    const { tryHandleCardLandings } = await import('../web/routes/card-landings.js')
    execFileSync('bash', ['-c', `echo unpushed > "${join(workPath, 'z.txt')}"`])
    git(workPath, ['add', 'z.txt'])
    git(workPath, ['commit', '-q', '-m', 'local only'])
    const unpushedSha = git(workPath, ['rev-parse', 'HEAD'])
    const { ctx, out } = fakeCtx({ card_id: 'c1', work_sha: 'a'.repeat(40), merge_sha: unpushedSha, repo: 'marveen', landed_by: 'backend3' })
    expect(await tryHandleCardLandings(ctx)).toBe(true)
    expect(out.status).toBe(422)
    expect(listCardLandings('c1')).toHaveLength(0)
  })
})
