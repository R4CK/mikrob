// Regression coverage for BRANCH_HEAL_COMMAND (card d87adb90, QA F1 MEDIUM, comment 7115).
//
// The adopted fix replaced `git checkout main && bash update.sh` with
// `git switch main || git switch -c main --track origin/main && bash update.sh`
// because plain checkout/switch fails with exit 128 in a repo that has more
// than one remote carrying a `main` branch: git's DWIM lookup refuses to guess
// which remote you meant. The explicit `--track origin/main` fallback names
// the remote directly, so it is never ambiguous. QA verified this by hand
// (three live scenarios in a scratch repo) but nothing pinned it as a test, so
// a future "simplification" back to plain checkout would silently reintroduce
// the exit-128 failure. This file extracts the REAL shipped string (not a
// retyped copy) and runs it for real, so a regression in either the value or
// the shell precedence fails here.
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MODULE = readFileSync(join(__dirname, '../../web/app-updates.js'), 'utf-8')

// Declaration-keyword-anchored, not a bare-name substring match (kódminőségi
// elv 12): this only matches the actual `const BRANCH_HEAL_COMMAND = '...'`
// assignment, so a rename or a comment mentioning the name can't fake a match.
const DECL = /^const BRANCH_HEAL_COMMAND = '([^']*)'/m
const match = MODULE.match(DECL)

describe('BRANCH_HEAL_COMMAND pin (card d87adb90)', () => {
  it('is declared with the exact fail-closed fallback string', () => {
    expect(match, 'const BRANCH_HEAL_COMMAND = \'...\' declaration not found in web/app-updates.js').not.toBeNull()
    expect(match![1]).toBe('git switch main || git switch -c main --track origin/main && bash update.sh')
  })

  it('never regresses to the plain checkout that fails on two-remote repos', () => {
    // The whole point of the card: `git checkout main` alone is exit-128 on a
    // repo with 2+ remotes each carrying `main` (no explicit target to pick).
    expect(match![1]).not.toContain('checkout main')
  })
})

const command = match ? match[1] : ''

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

function initTrunkRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'trunk'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'test'])
  writeFileSync(join(dir, 'f'), 'x', 'utf-8')
  git(dir, ['add', 'f'])
  git(dir, ['commit', '-q', '-m', 'init'])
}

function initBareRepo(dir: string, defaultBranch: string): void {
  execFileSync('git', ['init', '-q', '-b', defaultBranch, '--bare', dir], { stdio: 'pipe' })
}

function currentBranch(dir: string): string {
  return execFileSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf-8' }).trim()
}

/** Runs the real, extracted command in `dir`. `update.sh` is a marker-file stub. */
function runHeal(dir: string): { status: number; ranUpdate: boolean } {
  writeFileSync(join(dir, 'update.sh'), '#!/usr/bin/env bash\ntouch update-ran\n', 'utf-8')
  let status = 0
  try {
    execFileSync('bash', ['-c', command], { cwd: dir, stdio: 'pipe' })
  } catch (err) {
    status = typeof (err as { status?: number }).status === 'number' ? (err as { status: number }).status : 1
  }
  return { status, ranUpdate: existsSync(join(dir, 'update-ran')) }
}

const scratchDirs: string[] = []
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  while (scratchDirs.length) {
    const dir = scratchDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('BRANCH_HEAL_COMMAND behaviour, all three live scenarios (card d87adb90)', () => {
  it.skipIf(!match)('switches directly and runs update.sh when a local main branch already exists', () => {
    const dir = scratch('branch-heal-local-')
    initTrunkRepo(dir)
    git(dir, ['branch', 'main'])

    const { status, ranUpdate } = runHeal(dir)

    expect(status).toBe(0)
    expect(ranUpdate).toBe(true)
    expect(currentBranch(dir)).toBe('main')
  })

  it.skipIf(!match)('falls back to the explicit --track origin/main switch when plain switch is ambiguous across two remotes, and still runs update.sh', () => {
    const dir = scratch('branch-heal-tworemote-')
    initTrunkRepo(dir)
    const origin = scratch('branch-heal-tworemote-origin-')
    const upstream = scratch('branch-heal-tworemote-upstream-')
    initBareRepo(origin, 'main')
    initBareRepo(upstream, 'main')
    git(dir, ['push', '-q', origin, 'trunk:main'])
    git(dir, ['push', '-q', upstream, 'trunk:main'])
    git(dir, ['remote', 'add', 'origin', origin])
    git(dir, ['remote', 'add', 'upstream', upstream])
    git(dir, ['fetch', '-q', 'origin'])
    git(dir, ['fetch', '-q', 'upstream'])
    // Confirms the ambiguity is real in this environment, not assumed: plain
    // `git switch main` alone must fail here, or the fallback branch of the
    // fix would never actually be exercised below.
    expect(() => git(dir, ['switch', 'main'])).toThrow()
    git(dir, ['switch', 'trunk'])

    const { status, ranUpdate } = runHeal(dir)

    expect(status).toBe(0)
    expect(ranUpdate).toBe(true)
    expect(currentBranch(dir)).toBe('main')
  })

  it.skipIf(!match)('stays fail-closed -- update.sh does NOT run when neither switch can succeed', () => {
    const dir = scratch('branch-heal-failclosed-')
    initTrunkRepo(dir)
    const origin = scratch('branch-heal-failclosed-origin-')
    // origin exists but never had a `main` branch: both `switch main` and the
    // `--track origin/main` fallback have nothing to resolve to.
    initBareRepo(origin, 'trunk')
    git(dir, ['remote', 'add', 'origin', origin])
    git(dir, ['fetch', '-q', 'origin'])

    const { status, ranUpdate } = runHeal(dir)

    expect(status).not.toBe(0)
    expect(ranUpdate).toBe(false)
    expect(currentBranch(dir)).toBe('trunk')
  })
})
