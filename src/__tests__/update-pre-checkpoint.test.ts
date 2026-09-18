// Card ae071239 (Peti request, 2026-09-13, Telegram): a checkpoint of the local version must
// exist BEFORE update.sh proceeds, guaranteed by ORDER, not just an after-the-fact log line.
//
// Before this fix, update.sh only wrote a rollback point (FROM/TO) to store/.update-history
// AFTER `git pull` had already succeeded -- a crash mid-pull (network cut, disk full) left
// nothing to roll back to. recovery-prev-version.sh's non-destructive `checkpoint` action
// already existed; the gap was that update.sh's own normal run never called it.
//
// These tests run the REAL update.sh source (a literal slice from Guard 1 through the pull's
// history write, the same extraction technique update-unit-maintenance-order.test.ts uses for
// its own ordering claim) against a throwaway git repo with a real origin, so the order and the
// fail-closed behaviour are proved by what actually happened on disk, not by reading the code.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const UPDATE = readFileSync(join(REPO, 'update.sh'), 'utf-8')
const RECOVERY = readFileSync(join(REPO, 'recovery-prev-version.sh'), 'utf-8')

const START = '# Guard 1: derive the release branch from the current checkout and refuse'
const END = 'BUILT_COMMIT_FILE="$INSTALL_DIR/dist/.built-commit"'

function sliceRange(src: string, startAnchor: string, endAnchorExclusive: string): string {
  const start = src.indexOf(startAnchor)
  if (start < 0) throw new Error(`start anchor not found: ${startAnchor}`)
  const end = src.indexOf(endAnchorExclusive, start)
  if (end < 0) throw new Error(`end anchor not found: ${endAnchorExclusive}`)
  return src.slice(start, end)
}

const PULL_SLICE = sliceRange(UPDATE, START, END)

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', stdio: 'pipe' })
}

/** A local repo + bare "origin" one commit ahead, the shape update.sh pulls against. */
function makeRepoWithOrigin(): { local: string; origin: string } {
  const origin = mkdtempSync(join(tmpdir(), 'ckpt-origin-'))
  git(origin, 'init', '-q', '--bare')

  const seed = mkdtempSync(join(tmpdir(), 'ckpt-seed-'))
  git(seed, 'init', '-q', '-b', 'main')
  git(seed, 'config', 'user.email', 'test@local')
  git(seed, 'config', 'user.name', 'test')
  writeFileSync(join(seed, 'f'), '0')
  git(seed, 'add', 'f')
  git(seed, 'commit', '-q', '-m', 'c0')
  git(seed, 'remote', 'add', 'origin', origin)
  git(seed, 'push', '-q', 'origin', 'main')

  const local = mkdtempSync(join(tmpdir(), 'ckpt-local-'))
  git(local, 'clone', '-q', origin, local)
  execFileSync('git', ['-C', local, 'checkout', '-q', 'main'], { stdio: 'pipe' })
  git(local, 'config', 'user.email', 'test@local')
  git(local, 'config', 'user.name', 'test')
  mkdirSync(join(local, 'store'), { recursive: true })
  writeFileSync(join(local, 'install-lang.sh'), '')
  writeFileSync(join(local, 'recovery-prev-version.sh'), RECOVERY)
  chmodSync(join(local, 'recovery-prev-version.sh'), 0o755)

  // A new commit lands on origin only -- what update.sh's pull will bring in.
  writeFileSync(join(seed, 'f'), '1')
  git(seed, 'add', 'f')
  git(seed, 'commit', '-q', '-m', 'c1')
  git(seed, 'push', '-q', 'origin', 'main')

  rmSync(seed, { recursive: true, force: true })
  return { local, origin }
}

/** Run the extracted Guard1..pull slice as a real script rooted at `dir`. */
function runSlice(dir: string, extraEnv: Record<string, string> = {}): { code: number; out: string } {
  const probe = join(dir, 'probe.sh')
  const body = [
    '#!/bin/bash',
    'set -e',
    'RED="" GREEN="" ORANGE="" DIM="" NC="" BOLD=""',
    'MARVEEN_LANG="hu"',
    'INSTALL_DIR="' + dir + '"',
    'cd "$INSTALL_DIR"',
    'POST_MERGE_MODE="${POST_MERGE_MODE:-0}"',
    'POST_MERGE_OLD_SHA="${POST_MERGE_OLD_SHA:-}"',
    'RESULT_PHASE="init"',
    'retry() {',
    '  local tries="$1" pause="$2"; shift 2',
    '  local i=1',
    '  while true; do',
    '    if "$@"; then return 0; fi',
    '    if [ "$i" -ge "$tries" ]; then return 1; fi',
    '    sleep "$pause"; pause=$(( pause * 2 )); i=$(( i + 1 ))',
    '  done',
    '}',
    PULL_SLICE,
    'echo "PROBE_OK old=$OLD_VERSION_FULL new=$NEW_VERSION_FULL"',
  ].join('\n')
  writeFileSync(probe, body)
  try {
    const out = execFileSync('bash', [probe], {
      encoding: 'utf-8',
      stdio: 'pipe',
      cwd: dir,
      env: { ...process.env, ...extraEnv },
    })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, out: String(err.stdout ?? '') + String(err.stderr ?? '') }
  }
}

describe('update.sh source order (card ae071239)', () => {
  it('the checkpoint call precedes both the dirty-tree guard and the pull, in file order', () => {
    const checkpointCall = UPDATE.indexOf('"$INSTALL_DIR/recovery-prev-version.sh" checkpoint')
    const guard2 = UPDATE.indexOf('# Guard 2: refuse to run with a dirty tracked working tree.')
    const pullCall = UPDATE.indexOf('retry 3 3 git pull --ff-only origin')
    expect(checkpointCall).toBeGreaterThan(-1)
    expect(checkpointCall).toBeLessThan(guard2)
    expect(checkpointCall).toBeLessThan(pullCall)
  })

  it('is a direct call, not merely mentioned in a comment', () => {
    // A comment claiming the wiring exists is not the wiring (root CLAUDE.md quality principle
    // 8: "a labelled check that never ran is worse than no check").
    const line = UPDATE.split('\n').find((l) => l.trim().startsWith('"$INSTALL_DIR/recovery-prev-version.sh" checkpoint'))
    expect(line).toBeDefined()
    expect(line).not.toMatch(/^\s*#/)
  })

  it('is skipped under POST_MERGE_MODE (the caller already recorded its own rollback point)', () => {
    const start = UPDATE.indexOf('if [ "$POST_MERGE_MODE" != "1" ]; then')
    const closingFi = UPDATE.indexOf('\nfi\n', start)
    expect(start).toBeGreaterThan(-1)
    expect(closingFi).toBeGreaterThan(start)
    const guardedBlock = UPDATE.slice(start, closingFi)
    expect(guardedBlock).toContain('recovery-prev-version.sh" checkpoint')
  })
})

describe('update.sh checkpoints before it changes anything (card ae071239, real run)', () => {
  let local: string
  let origin: string
  beforeAll(() => {
    ;({ local, origin } = makeRepoWithOrigin())
  })
  afterAll(() => {
    if (local) rmSync(local, { recursive: true, force: true })
    if (origin) rmSync(origin, { recursive: true, force: true })
  })

  it('writes a checkpoint row for the PRE-pull HEAD before the pull moves it', () => {
    const preSha = git(local, 'rev-parse', 'HEAD').trim()
    const r = runSlice(local)
    expect(r.code, r.out).toBe(0)

    const hist = readFileSync(join(local, 'store', '.update-history'), 'utf-8').trim().split('\n')
    // append-only: the checkpoint row must be the FIRST row, the update row after it.
    expect(hist.length).toBeGreaterThanOrEqual(2)
    const [checkpointRow, updateRow] = hist
    expect(checkpointRow!.split('\t')[1]).toBe('checkpoint')
    expect(checkpointRow!.split('\t')[3]).toBe(preSha) // recorded the OLD sha, not the pulled-to one
    expect(updateRow!.split('\t')[1]).toBe('update')

    const postSha = git(local, 'rev-parse', 'HEAD').trim()
    expect(postSha).not.toBe(preSha) // the pull actually ran, so the ordering claim is not vacuous
    expect(updateRow!.split('\t')[4]).toBe(postSha)
  })

  it('fails closed: a broken checkpoint mechanism stops the run before the pull', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ckpt-failclosed-'))
    try {
      git(dir, 'clone', '-q', origin, dir)
      execFileSync('git', ['-C', dir, 'checkout', '-q', 'main'], { stdio: 'pipe' })
      git(dir, 'config', 'user.email', 'test@local')
      git(dir, 'config', 'user.name', 'test')
      mkdirSync(join(dir, 'store'), { recursive: true })
      writeFileSync(join(dir, 'install-lang.sh'), '')
      // A recovery-prev-version.sh that always fails -- disk-full / permission-denied stand-in.
      writeFileSync(join(dir, 'recovery-prev-version.sh'), '#!/bin/bash\nexit 7\n')
      chmodSync(join(dir, 'recovery-prev-version.sh'), 0o755)

      const preSha = git(dir, 'rev-parse', 'HEAD').trim()
      const r = runSlice(dir)
      expect(r.code).not.toBe(0)
      expect(existsSync(join(dir, 'store', '.update-history'))).toBe(false)
      expect(git(dir, 'rev-parse', 'HEAD').trim(), 'HEAD must not move when the checkpoint fails').toBe(preSha)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips the checkpoint call under POST_MERGE_MODE, and still pulls nothing (HEAD already moved by the caller)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ckpt-postmerge-'))
    try {
      git(dir, 'clone', '-q', origin, dir)
      execFileSync('git', ['-C', dir, 'checkout', '-q', 'main'], { stdio: 'pipe' })
      git(dir, 'config', 'user.email', 'test@local')
      git(dir, 'config', 'user.name', 'test')
      mkdirSync(join(dir, 'store'), { recursive: true })
      writeFileSync(join(dir, 'install-lang.sh'), '')
      // Always fails -- if the slice called it under POST_MERGE_MODE, the run would abort here.
      writeFileSync(join(dir, 'recovery-prev-version.sh'), '#!/bin/bash\nexit 7\n')
      chmodSync(join(dir, 'recovery-prev-version.sh'), 0o755)

      const preSha = git(dir, 'rev-parse', 'HEAD').trim()
      const r = runSlice(dir, { POST_MERGE_MODE: '1', POST_MERGE_OLD_SHA: preSha })
      expect(r.code, r.out).toBe(0)
      expect(existsSync(join(dir, 'store', '.update-history'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
