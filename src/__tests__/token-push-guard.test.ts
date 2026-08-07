// Card 755e576b: a pre-push hook that refuses to publish the live dashboard token.
//
// WHY THIS IS A HOOK AND NOT A PLAIN ASSERTION IN THIS SUITE. The rule needs the ACTUAL secret to
// search for, and store/.dashboard-token is gitignored -- it does not exist in a worktree, and the
// suite runs in worktrees. A test that read it here would take its "no token, nothing to check"
// path and stay green forever: vacuous in the only environment where it runs (measured on card
// 9511f4e3, which is why that card closed as a no-op). So the guard lives at push time, on the live
// install, and THIS file tests the guard by building a throwaway repo that has its own token.
//
// Every case runs against a real git repository with real commits: the thing under test is how the
// hook reads a push range, and a stubbed range would prove nothing about that.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INSTALLER = join(REPO_ROOT, 'scripts', 'install-token-push-guard-hook.sh')

const FAKE_TOKEN = 'f'.repeat(16) + 'deadbeefcafe1234567890abcdef0000'

let tmp: string
let repo: string
let hook: string

/** Run a command in the fixture repo; returns exit code and stderr instead of throwing. */
function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): { code: number; err: string } {
  try {
    execFileSync(cmd, args, { cwd, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, ...env } })
    return { code: 0, err: '' }
  } catch (e) {
    const x = e as { status?: number; stderr?: string }
    return { code: x.status ?? 1, err: x.stderr ?? '' }
  }
}

/** Feed the hook a pre-push ref line, exactly as git would.
 *
 * spawnSync, not execFileSync: the override case EXITS ZERO and still must print its warning, and
 * execFileSync only surfaces stderr on failure -- so the success path would have been asserted
 * against an empty string. (It was, and the test caught it.) */
function pushAttempt(remoteSha: string, localSha: string, env: NodeJS.ProcessEnv = {}): { code: number; err: string } {
  const r = spawnSync('bash', [hook, 'origin', 'file:///dev/null'], {
    cwd: repo,
    input: `refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  })
  return { code: r.status ?? 1, err: r.stderr ?? '' }
}

function commit(file: string, body: string, msg: string): string {
  writeFileSync(join(repo, file), body)
  run('git', ['add', file], repo)
  run('git', ['commit', '-m', msg], repo)
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'token-push-guard-'))
  repo = join(tmp, 'install')
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(join(repo, 'store'), { recursive: true })
  copyFileSync(INSTALLER, join(repo, 'scripts', 'install-token-push-guard-hook.sh'))
  // The fixture install has its OWN token, so nothing here touches the real one.
  writeFileSync(join(repo, 'store', '.dashboard-token'), FAKE_TOKEN + '\n')

  run('git', ['init', '-q', '-b', 'main'], repo)
  run('git', ['config', 'user.email', 'test@example.com'], repo)
  run('git', ['config', 'user.name', 'Test'], repo)
  run('git', ['config', 'commit.gpgsign', 'false'], repo)

  const res = run('bash', [join(repo, 'scripts', 'install-token-push-guard-hook.sh')], repo)
  expect(res.code, `installer failed: ${res.err}`).toBe(0)
  hook = join(repo, '.git', 'hooks', 'pre-push.d', '20-no-dashboard-token-in-push')
})

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('the installer', () => {
  it('writes an executable guard and a dispatcher', () => {
    expect(existsSync(hook)).toBe(true)
    expect(statSync(hook).mode & 0o111).toBeGreaterThan(0)
    const dispatch = join(repo, '.git', 'hooks', 'pre-push')
    expect(existsSync(dispatch)).toBe(true)
    expect(statSync(dispatch).mode & 0o111).toBeGreaterThan(0)
  })

  it('is idempotent -- a second run leaves one guard, still executable', () => {
    const res = run('bash', [join(repo, 'scripts', 'install-token-push-guard-hook.sh')], repo)
    expect(res.code).toBe(0)
    expect(statSync(hook).mode & 0o111).toBeGreaterThan(0)
  })
})

// The installer's other branch: what it does to a pre-push hook that is ALREADY there. Getting
// this wrong silently deletes someone else's hook, and nothing else in this file would notice.
describe('the installer does not destroy an existing pre-push hook', () => {
  function freshInstall(prepare: (hookDir: string) => void): { dir: string; hookDir: string } {
    const dir = mkdtempSync(join(tmp, 'reinstall-'))
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    mkdirSync(join(dir, 'store'), { recursive: true })
    copyFileSync(INSTALLER, join(dir, 'scripts', 'install-token-push-guard-hook.sh'))
    writeFileSync(join(dir, 'store', '.dashboard-token'), FAKE_TOKEN + '\n')
    run('git', ['init', '-q', '-b', 'main'], dir)
    const hookDir = join(dir, '.git', 'hooks')
    mkdirSync(hookDir, { recursive: true })
    prepare(hookDir)
    const res = run('bash', [join(dir, 'scripts', 'install-token-push-guard-hook.sh')], dir)
    expect(res.code, res.err).toBe(0)
    return { dir, hookDir }
  }

  it('preserves a FOREIGN pre-push hook by demoting it into pre-push.d', () => {
    const { hookDir } = freshInstall((hd) => {
      writeFileSync(join(hd, 'pre-push'), '#!/usr/bin/env bash\necho "someone elses hook"\nexit 0\n', { mode: 0o755 })
    })
    const legacy = join(hookDir, 'pre-push.d', '00-legacy-pre-push')
    expect(existsSync(legacy)).toBe(true)
    expect(execFileSync('cat', [legacy], { encoding: 'utf-8' })).toContain('someone elses hook')
    expect(statSync(legacy).mode & 0o111).toBeGreaterThan(0)
    expect(existsSync(join(hookDir, 'pre-push.d', '20-no-dashboard-token-in-push'))).toBe(true)
  })

  it('leaves an existing marveen dispatcher in place', () => {
    const marker = '# marveen-pre-push-dispatcher : custom local edit\n'
    const { hookDir } = freshInstall((hd) => {
      writeFileSync(join(hd, 'pre-push'), '#!/usr/bin/env bash\n' + marker + 'exit 0\n', { mode: 0o755 })
    })
    expect(execFileSync('cat', [join(hookDir, 'pre-push')], { encoding: 'utf-8' })).toContain('custom local edit')
    expect(existsSync(join(hookDir, 'pre-push.d', '00-legacy-pre-push'))).toBe(false)
  })
})

describe('a push carrying the live token is refused', () => {
  it('blocks when a commit ADDS the token', () => {
    const base = commit('a.txt', 'clean content\n', 'base')
    const bad = commit('leak.sh', `curl -H "Authorization: Bearer ${FAKE_TOKEN}"\n`, 'oops')
    const r = pushAttempt(base, bad)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('LIVE dashboard token')
    // The guard must never echo the secret it is protecting.
    expect(r.err).not.toContain(FAKE_TOKEN)
  })

  it('blocks a NEW branch too (no remote ancestor to diff against)', () => {
    const bad = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()
    const r = pushAttempt('0'.repeat(40), bad)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('LIVE dashboard token')
  })

  it('names a way to find it without printing it', () => {
    const bad = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()
    const r = pushAttempt('0'.repeat(40), bad)
    expect(r.err).toContain('ROTATE')
    expect(r.err).toContain('git log -p')
  })

  it('the explicit override lets it through, loudly', () => {
    const bad = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()
    const r = pushAttempt('0'.repeat(40), bad, { ALLOW_TOKEN_IN_PUSH: '1' })
    expect(r.code).toBe(0)
    expect(r.err).toContain('ALLOW_TOKEN_IN_PUSH=1')
  })
})

describe('ordinary pushes are not disturbed', () => {
  it('allows a clean range', () => {
    // Start a branch that never saw the leaking commit.
    run('git', ['checkout', '-q', '-b', 'clean-branch', 'HEAD~2'], repo)
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()
    const tip = commit('b.txt', 'nothing secret here\n', 'clean work')
    const r = pushAttempt(base, tip)
    expect(r.code, r.err).toBe(0)
  })

  it('allows a branch DELETION (nothing is being published)', () => {
    const r = pushAttempt('abc123'.padEnd(40, '0'), '0'.repeat(40))
    expect(r.code).toBe(0)
  })

  it('allows everything when the install has no token at all', () => {
    const tokenPath = join(repo, 'store', '.dashboard-token')
    const saved = execFileSync('cat', [tokenPath], { encoding: 'utf-8' })
    rmSync(tokenPath)
    try {
      const tip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()
      expect(pushAttempt('0'.repeat(40), tip).code).toBe(0)
    } finally {
      writeFileSync(tokenPath, saved)
    }
  })
})

describe('the guard fails CLOSED when it cannot see what is being pushed', () => {
  it('blocks on an unreadable commit range instead of assuming it is clean', () => {
    const r = pushAttempt('0'.repeat(39) + '1', 'deadbeef' + '0'.repeat(32))
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('could not be checked')
  })
})
