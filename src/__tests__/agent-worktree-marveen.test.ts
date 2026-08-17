// Card dc185b52: MikroB's REVERSED decision (komment 14285) after Cybersec's NO-GO (komment 14284)
// on the earlier branch-only attempt (store/agent-branch.sh, now RETIRED along with
// store/agent-branch-land.sh and this file's predecessor, src/__tests__/agent-branch.test.ts).
// Cybersec live-reproduced a TOCTOU race: agent-branch.sh's `git checkout` on the ONE shared working
// directory could swap file content out from under a DIFFERENT agent's ordinary Read-then-Write
// sequence (which never calls agent-branch.sh at all), silently losing that agent's already-
// committed work with no git error. Full per-agent worktree isolation -- the ALREADY-PROVEN
// CleanCore pattern (store/agent-worktree.sh) -- closes this STRUCTURALLY: nothing here ever runs
// `git checkout` against a path any other agent's tools might be reading or writing.
//
// Every test runs against a THROWAWAY bare-origin + main-clone pair under a real temp dir, never the
// live marveen checkout -- both scripts accept MARVEEN_MAIN / MARVEEN_WORKTREES / MARVEEN_LAND_TEST
// overrides for exactly this reason (store/fleet-test.sh itself hardcodes the real repo as ROOT, so
// marveen-land.sh's verification step is a stub here, not the real suite).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORKTREE_SH = join(ROOT, 'store', 'agent-worktree-marveen.sh')
const LAND_SH = join(ROOT, 'store', 'marveen-land.sh')
const execFileP = promisify(execFile)

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }).trim()
}
function gitOk(repo: string, ...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
}

let dir: string
let upstream: string
let main: string
let worktrees: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'marveen-worktree-test-'))
  upstream = join(dir, 'origin.git')
  main = join(dir, 'main')
  worktrees = join(dir, 'worktrees')
  execFileSync('git', ['init', '-q', '--bare', upstream])
  execFileSync('git', ['clone', '-q', upstream, main])
  gitOk(main, 'config', 'user.email', 't@t.local')
  gitOk(main, 'config', 'user.name', 't')
  gitOk(main, 'checkout', '-q', '-b', 'develop')
  writeFileSync(join(main, 'shared.txt'), 'aaa\nbbb\nccc\n')
  writeFileSync(join(main, 'f.txt'), 'hello\n')
  mkdirSync(join(main, 'node_modules'))
  writeFileSync(join(main, 'node_modules', 'marker.txt'), 'x\n')
  gitOk(main, 'add', 'f.txt', 'shared.txt')
  gitOk(main, 'commit', '-q', '-m', 'init')
  gitOk(main, 'push', '-q', '-u', 'origin', 'develop')
  gitOk(main, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function runWorktree(agent: string, extraArgs: string[] = []): Promise<{ status: number; out: string }> {
  try {
    const { stdout, stderr } = await execFileP('bash', [WORKTREE_SH, agent, ...extraArgs], {
      encoding: 'utf-8',
      env: { ...process.env, MARVEEN_MAIN: main, MARVEEN_WORKTREES: worktrees },
    })
    return { status: 0, out: stdout + stderr }
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string }
    return { status: err.code ?? -1, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

function writeStub(exitCode: number): string {
  const p = join(dir, `stub-${exitCode}.sh`)
  writeFileSync(p, `#!/usr/bin/env bash\nexit ${exitCode}\n`)
  chmodSync(p, 0o755)
  return p
}

async function runLand(args: string[], testCmd: string): Promise<{ status: number; out: string }> {
  try {
    const { stdout, stderr } = await execFileP('bash', [LAND_SH, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, MARVEEN_MAIN: main, MARVEEN_LAND_TEST: testCmd },
    })
    return { status: 0, out: stdout + stderr }
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string }
    return { status: err.code ?? -1, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

describe('agent-worktree-marveen.sh (card dc185b52)', () => {
  it('creates a worktree on agent/<agent>/work off the default branch', async () => {
    const r = await runWorktree('backend')
    expect(r.status).toBe(0)
    const tree = join(worktrees, 'backend')
    expect(git(tree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent/backend/work')
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(git(main, 'rev-parse', 'origin/develop'))
  })

  it('links node_modules from main', async () => {
    await runWorktree('backend')
    const link = readlinkSync(join(worktrees, 'backend', 'node_modules'))
    expect(link).toBe(join(main, 'node_modules'))
  })

  it('is idempotent: a second call tops up without recreating', async () => {
    await runWorktree('backend')
    const r = await runWorktree('backend')
    expect(r.status).toBe(0)
    expect(r.out).toContain('worktree already present')
  })

  it('MUTATION-PROOF: edits made in one agent worktree never appear in main or another agent worktree (structural isolation, not discipline)', async () => {
    await runWorktree('backend')
    await runWorktree('fullstack')
    writeFileSync(join(worktrees, 'backend', 'shared.txt'), 'backend edited this\n')

    // main's own working tree is untouched
    expect(git(main, 'status', '--porcelain', '--', 'shared.txt')).toBe('')
    // a sibling agent's worktree is untouched -- each has its own checked-out files
    const fullstackContent = execFileSync('cat', [join(worktrees, 'fullstack', 'shared.txt')], {
      encoding: 'utf-8',
    })
    expect(fullstackContent).toBe('aaa\nbbb\nccc\n')
  })

  it('rejects an agent name with disallowed characters', async () => {
    const r = await runWorktree('Back_End!')
    expect(r.status).toBe(2)
  })

  it('--path prints the path without creating anything', async () => {
    const r = await runWorktree('backend', ['--path'])
    expect(r.status).toBe(0)
    expect(r.out.trim()).toBe(join(worktrees, 'backend'))
    expect(() => git(join(worktrees, 'backend'), 'rev-parse', 'HEAD')).toThrow()
  })
})

describe('marveen-land.sh (card dc185b52)', () => {
  async function commitInWorktree(agent: string, files: Record<string, string>): Promise<void> {
    await runWorktree(agent)
    const tree = join(worktrees, agent)
    gitOk(tree, 'config', 'user.email', `${agent}@t.local`)
    gitOk(tree, 'config', 'user.name', agent)
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(tree, name), content)
    }
    gitOk(tree, 'add', ...Object.keys(files))
    gitOk(tree, 'commit', '-q', '-m', `${agent} work`)
  }

  it('lands a worktree branch onto the default branch and pushes to origin', async () => {
    await commitInWorktree('backend', { 'backend-new.txt': 'from backend\n' })

    const r = await runLand(['backend'], writeStub(0))
    expect(r.status).toBe(0)
    expect(r.out).toContain('LANDED')

    gitOk(main, 'fetch', '-q', 'origin', 'develop')
    const files = git(main, 'ls-tree', '-r', '--name-only', 'origin/develop')
    expect(files.split('\n')).toContain('backend-new.txt')
  })

  it('MUTATION-PROOF: refuses a real content conflict and pushes nothing', async () => {
    await commitInWorktree('backend', { 'shared.txt': 'aaa\nbbb\nccc\nbackend-tail\n' })
    writeFileSync(join(main, 'shared.txt'), 'aaa\nbbb\nccc\ndevelop-tail\n')
    gitOk(main, 'add', 'shared.txt')
    gitOk(main, 'commit', '-q', '-m', 'develop edits the same tail')
    gitOk(main, 'push', '-q', 'origin', 'develop')

    const before = git(main, 'rev-parse', 'origin/develop')
    const r = await runLand(['backend'], writeStub(0))
    expect(r.status).toBe(4)
    expect(r.out).toContain('CONFLICT')

    gitOk(main, 'fetch', '-q', 'origin', 'develop')
    expect(git(main, 'rev-parse', 'origin/develop')).toBe(before)
  })

  it('refuses when the verification command fails on the merge result, and pushes nothing', async () => {
    await commitInWorktree('backend', { 'backend-new.txt': 'x\n' })

    const before = git(main, 'rev-parse', 'origin/develop')
    const r = await runLand(['backend'], writeStub(1))
    expect(r.status).toBe(4)
    expect(r.out).toContain('REFUSED')

    gitOk(main, 'fetch', '-q', 'origin', 'develop')
    expect(git(main, 'rev-parse', 'origin/develop')).toBe(before)
  })

  it('a successful landing leaves the agent worktree untouched, but its branch is an ancestor of origin/develop', async () => {
    await commitInWorktree('backend', { 'backend-new.txt': 'x\n' })
    const preLandTip = git(join(worktrees, 'backend'), 'rev-parse', 'HEAD')

    await runLand(['backend'], writeStub(0))

    // the agent's own worktree is not auto-reset -- same precedent as CleanCore's landing script
    expect(git(join(worktrees, 'backend'), 'rev-parse', 'HEAD')).toBe(preLandTip)
    gitOk(main, 'fetch', '-q', 'origin', 'develop')
    expect(() => git(main, 'merge-base', '--is-ancestor', preLandTip, 'origin/develop')).not.toThrow()
  })

  it('--all lands every agent/*/work branch with unmerged work in one sweep', async () => {
    await commitInWorktree('backend', { 'backend-new.txt': 'x\n' })
    await commitInWorktree('fullstack', { 'fullstack-new.txt': 'y\n' })

    const r = await runLand(['--all'], writeStub(0))
    expect(r.status).toBe(0)
    expect(r.out).toContain('backend: LANDED')
    expect(r.out).toContain('fullstack: LANDED')

    gitOk(main, 'fetch', '-q', 'origin', 'develop')
    const files = git(main, 'ls-tree', '-r', '--name-only', 'origin/develop')
    expect(files.split('\n')).toEqual(expect.arrayContaining(['backend-new.txt', 'fullstack-new.txt']))
  })

  it('landing again after a clean land is a no-op, not an error', async () => {
    await commitInWorktree('backend', { 'backend-new.txt': 'x\n' })
    await runLand(['backend'], writeStub(0))

    const r = await runLand(['backend'], writeStub(0))
    expect(r.status).toBe(0)
    expect(r.out).toContain('already fully landed')
  })
})
