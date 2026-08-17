// Card dc185b52 (MikroB plan-grilling komment 14270, Peti-approved force despite the weekly
// newDevStop): the marveen repo's own shared checkout let one agent's uncommitted stage get swept
// into another agent's commit (incident: backend2's staged files landed inside QA's commit e943fe7e
// without backend2's own gate). store/agent-branch.sh + store/agent-branch-land.sh are the fix -- a
// light per-agent-branch pattern instead of CleanCore's full worktree isolation (explicitly rejected
// as over-engineered for this repo's shape by the plan-grilling verdict).
//
// Every test below runs against a THROWAWAY bare-origin + clone pair under a real temp dir, never
// the live marveen checkout -- both scripts accept AGENT_BRANCH_REPO / AGENT_BRANCH_LAND_TEST
// overrides for exactly this reason (store/fleet-test.sh itself hardcodes the real repo as ROOT, so
// agent-branch-land.sh's verification step is a stub here, not the real suite).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BRANCH_SH = join(ROOT, 'store', 'agent-branch.sh')
const LAND_SH = join(ROOT, 'store', 'agent-branch-land.sh')
const execFileP = promisify(execFile)

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }).trim()
}
function gitOk(repo: string, ...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
}

let dir: string
let upstream: string
let work: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-branch-test-'))
  upstream = join(dir, 'origin.git')
  work = join(dir, 'work')
  execFileSync('git', ['init', '-q', '--bare', upstream])
  execFileSync('git', ['clone', '-q', upstream, work])
  gitOk(work, 'config', 'user.email', 't@t.local')
  gitOk(work, 'config', 'user.name', 't')
  gitOk(work, 'checkout', '-q', '-b', 'develop')
  writeFileSync(join(work, 'shared.txt'), 'aaa\nbbb\nccc\n')
  writeFileSync(join(work, 'f.txt'), 'hello\n')
  gitOk(work, 'add', 'shared.txt', 'f.txt')
  gitOk(work, 'commit', '-q', '-m', 'init')
  gitOk(work, 'push', '-q', '-u', 'origin', 'develop')
  gitOk(work, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function runBranch(agent: string, extraArgs: string[] = []): Promise<{ status: number; out: string }> {
  try {
    const { stdout, stderr } = await execFileP('bash', [BRANCH_SH, agent, ...extraArgs], {
      encoding: 'utf-8',
      env: { ...process.env, AGENT_BRANCH_REPO: work },
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

async function runLand(
  args: string[],
  testCmd: string,
): Promise<{ status: number; out: string }> {
  try {
    const { stdout, stderr } = await execFileP('bash', [LAND_SH, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, AGENT_BRANCH_REPO: work, AGENT_BRANCH_LAND_TEST: testCmd },
    })
    return { status: 0, out: stdout + stderr }
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string }
    return { status: err.code ?? -1, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

describe('agent-branch.sh (card dc185b52)', () => {
  it('creates agent/<agent>/work from the default branch', async () => {
    const r = await runBranch('backend')
    expect(r.status).toBe(0)
    expect(git(work, 'branch', '--show-current')).toBe('agent/backend/work')
    expect(git(work, 'rev-parse', 'agent/backend/work')).toBe(git(work, 'rev-parse', 'origin/develop'))
  })

  it('is idempotent: a second call on an already-clean branch is a no-op that stays on it', async () => {
    await runBranch('backend')
    const r = await runBranch('backend')
    expect(r.status).toBe(0)
    expect(r.out).toContain('already on agent/backend/work')
    expect(git(work, 'branch', '--show-current')).toBe('agent/backend/work')
  })

  it('MUTATION-PROOF: refuses to switch when the tree is dirty on a foreign branch, leaving the dirty file untouched', async () => {
    await runBranch('backend') // creates the branch once so it exists
    gitOk(work, 'checkout', '-q', 'develop')
    writeFileSync(join(work, 'f.txt'), 'someone elses uncommitted edit\n')

    const r = await runBranch('backend')
    expect(r.status).toBe(3)
    expect(r.out).toContain('dirty')
    // still on develop -- the script did NOT switch, and the foreign edit is still there untouched.
    expect(git(work, 'branch', '--show-current')).toBe('develop')
    expect(readFileSync(join(work, 'f.txt'), 'utf-8')).toBe('someone elses uncommitted edit\n')
  })

  it('rejects an agent name with disallowed characters', async () => {
    const r = await runBranch('Back_End!')
    expect(r.status).toBe(2)
  })

  it('--path prints repo:branch without any side effect', async () => {
    const r = await runBranch('backend', ['--path'])
    expect(r.status).toBe(0)
    expect(r.out.trim()).toBe(`${work}:agent/backend/work`)
    // no branch was actually created
    expect(() => git(work, 'rev-parse', '--verify', 'agent/backend/work')).toThrow()
  })
})

describe('agent-branch-land.sh (card dc185b52)', () => {
  it('lands a non-conflicting branch onto the default branch and pushes to origin', async () => {
    await runBranch('backend')
    writeFileSync(join(work, 'backend-new.txt'), 'from backend\n')
    gitOk(work, 'add', 'backend-new.txt')
    gitOk(work, 'commit', '-q', '-m', 'backend work')

    const r = await runLand(['backend'], writeStub(0))
    expect(r.status).toBe(0)
    expect(r.out).toContain('LANDED')

    gitOk(work, 'fetch', '-q', 'origin', 'develop')
    const files = git(work, 'ls-tree', '-r', '--name-only', 'origin/develop')
    expect(files.split('\n')).toContain('backend-new.txt')
  })

  it('MUTATION-PROOF: refuses a real content conflict and pushes nothing', async () => {
    await runBranch('backend')
    writeFileSync(join(work, 'shared.txt'), 'aaa\nbbb\nccc\nbackend-tail\n')
    gitOk(work, 'add', 'shared.txt')
    gitOk(work, 'commit', '-q', '-m', 'backend edits tail')

    gitOk(work, 'checkout', '-q', 'develop')
    writeFileSync(join(work, 'shared.txt'), 'aaa\nbbb\nccc\ndevelop-tail\n')
    gitOk(work, 'add', 'shared.txt')
    gitOk(work, 'commit', '-q', '-m', 'develop edits the same tail')
    gitOk(work, 'push', '-q', 'origin', 'develop')

    const before = git(work, 'rev-parse', 'origin/develop')
    const r = await runLand(['backend'], writeStub(0))
    expect(r.status).toBe(4)
    expect(r.out).toContain('CONFLICT')

    gitOk(work, 'fetch', '-q', 'origin', 'develop')
    expect(git(work, 'rev-parse', 'origin/develop')).toBe(before)
  })

  it('refuses when the verification command fails on the merge result, and pushes nothing', async () => {
    await runBranch('backend')
    writeFileSync(join(work, 'backend-new.txt'), 'x\n')
    gitOk(work, 'add', 'backend-new.txt')
    gitOk(work, 'commit', '-q', '-m', 'backend work')

    const before = git(work, 'rev-parse', 'origin/develop')
    const r = await runLand(['backend'], writeStub(1))
    expect(r.status).toBe(4)
    expect(r.out).toContain('REFUSED')

    gitOk(work, 'fetch', '-q', 'origin', 'develop')
    expect(git(work, 'rev-parse', 'origin/develop')).toBe(before)
  })

  it('a successful landing needs no explicit branch reset -- the agent self-heals on its next agent-branch.sh call', async () => {
    await runBranch('backend')
    writeFileSync(join(work, 'backend-new.txt'), 'x\n')
    gitOk(work, 'add', 'backend-new.txt')
    gitOk(work, 'commit', '-q', '-m', 'backend work')
    await runLand(['backend'], writeStub(0))

    gitOk(work, 'checkout', '-q', 'agent/backend/work') // simulate the agent's shared tree still on its own branch
    const r = await runBranch('backend')
    expect(r.status).toBe(0)
    expect(r.out).toContain('fast-forwarded')
    expect(git(work, 'rev-parse', 'agent/backend/work')).toBe(git(work, 'rev-parse', 'origin/develop'))
  })

  it('--all lands every agent/*/work branch with unmerged work in one sweep', async () => {
    await runBranch('backend')
    writeFileSync(join(work, 'backend-new.txt'), 'x\n')
    gitOk(work, 'add', 'backend-new.txt')
    gitOk(work, 'commit', '-q', '-m', 'backend work')

    gitOk(work, 'checkout', '-q', 'develop')
    gitOk(work, 'checkout', '-q', '-b', 'agent/fullstack/work')
    writeFileSync(join(work, 'fullstack-new.txt'), 'y\n')
    gitOk(work, 'add', 'fullstack-new.txt')
    gitOk(work, 'commit', '-q', '-m', 'fullstack work')

    const r = await runLand(['--all'], writeStub(0))
    expect(r.status).toBe(0)
    expect(r.out).toContain('backend: LANDED')
    expect(r.out).toContain('fullstack: LANDED')

    gitOk(work, 'fetch', '-q', 'origin', 'develop')
    const files = git(work, 'ls-tree', '-r', '--name-only', 'origin/develop')
    expect(files.split('\n')).toEqual(expect.arrayContaining(['backend-new.txt', 'fullstack-new.txt']))
  })

  it('landing again after a clean land is a no-op, not an error', async () => {
    await runBranch('backend')
    writeFileSync(join(work, 'backend-new.txt'), 'x\n')
    gitOk(work, 'add', 'backend-new.txt')
    gitOk(work, 'commit', '-q', '-m', 'backend work')
    await runLand(['backend'], writeStub(0))

    const r = await runLand(['backend'], writeStub(0))
    expect(r.status).toBe(0)
    expect(r.out).toContain('already fully landed')
  })
})
