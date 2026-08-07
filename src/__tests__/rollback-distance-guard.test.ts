// Rollback distance-guard (card 980454f7).
//
// Incident 2026-08-06 19:50: a stale rollback target in store/.update-history named a July-24 commit.
// The rollback machinery restored it faithfully -- 529 commits back, detached HEAD -- and then did it
// twice more, because the restored tree carries the old store/update-health-watchdog.sh which reads the
// same stale target. Three rollbacks, all logged as successes. Nothing errored; nobody was told.
//
// The guard's contract: a rollback target is accepted only if it is an ancestor of HEAD, at most 50
// commits back, and at or above the floor commit that removed the duplicate watchdog. Anything else is
// refused, recorded, and escalated -- a refused rollback leaves a visibly broken version someone fixes
// today, a wrong one leaves a plausible two-week-old version nobody notices.
//
// These tests are behavioural where it matters: they build throwaway git repos and run the real script,
// so "the guard refuses a 529-commit target" is proved by exit code and by the untouched HEAD, not by
// reading the source. The source-level assertions cover only the WIRING -- that each of the three
// rollback call sites still routes through the guard -- which cannot be observed without actually
// rolling an install back.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GUARD = join(REPO, 'store', 'rollback-guard.sh')

/** Run a bash snippet with the guard sourced. Returns exit status + merged output.
 *  `exec 2>&1` up front because the guard reports refusals and skipped checks on stderr, which
 *  execFileSync drops entirely on a zero exit. */
function runGuard(script: string, env: Record<string, string> = {}): { status: number; out: string } {
  try {
    const out = execFileSync('bash', ['-c', `exec 2>&1\n. "${GUARD}"\n${script}`], {
      encoding: 'utf-8',
      stdio: 'pipe',
      env: { ...process.env, ROLLBACK_GUARD_NOTIFY: '0', ...env },
    })
    return { status: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? -1, out: String(err.stdout ?? '') + String(err.stderr ?? '') }
  }
}

/** A throwaway repo with `n` linear commits. Returns the dir; caller cleans up. */
function makeRepo(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'rollback-guard-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'test@local')
  git('config', 'user.name', 'test')
  mkdirSync(join(dir, 'store'), { recursive: true })
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, 'f'), String(i))
    git('add', 'f')
    git('commit', '-q', '-m', `c${i}`)
  }
  return dir
}

const sha = (dir: string, rev: string) =>
  execFileSync('git', ['-C', dir, 'rev-parse', rev], { encoding: 'utf-8' }).trim()

describe('rollback-guard.sh (card 980454f7)', () => {
  let repo: string
  beforeAll(() => {
    repo = makeRepo(60)
  })
  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  it('passes its own selftest', () => {
    const r = runGuard(`bash "${GUARD}" --selftest`)
    expect(r.out).toContain('selftest OK')
    expect(r.status).toBe(0)
  })

  // The incident itself, reproduced: a target hundreds of commits back must not be actioned.
  it('refuses a stale far-back target and leaves HEAD untouched', () => {
    const head = sha(repo, 'HEAD')
    const stale = sha(repo, 'HEAD~55')
    const r = runGuard(`rollback_guard_check "${repo}" "${head}" "${stale}" "regression"`)
    expect(r.status).not.toBe(0) // refused
    expect(r.out).toContain('55 committal van hatra') // named the actual distance, not a generic error
    expect(sha(repo, 'HEAD')).toBe(head) // and did not move the tree
  })

  it('records the refusal in .update-history and rollback-guard.log', () => {
    const head = sha(repo, 'HEAD')
    const stale = sha(repo, 'HEAD~55')
    runGuard(`rollback_guard_check "${repo}" "${head}" "${stale}" "audit-trail"`)
    const hist = readFileSync(join(repo, 'store', '.update-history'), 'utf-8')
    expect(hist).toContain('rollback-refused')
    expect(hist).toContain('audit-trail')
    expect(hist).toContain(stale)
    expect(readFileSync(join(repo, 'store', 'rollback-guard.log'), 'utf-8')).toContain('REFUSED')
  })

  it('allows a normal one-commit-back rollback (the case updates actually need)', () => {
    const head = sha(repo, 'HEAD')
    const prev = sha(repo, 'HEAD~1')
    const r = runGuard(`rollback_guard_check "${repo}" "${head}" "${prev}" "normal"`)
    expect(r.status).toBe(0)
  })

  it('allows exactly at the distance limit and refuses one past it', () => {
    const head = sha(repo, 'HEAD')
    expect(runGuard(`rollback_guard_check "${repo}" "${head}" "${sha(repo, 'HEAD~50')}" "edge"`).status).toBe(0)
    expect(runGuard(`rollback_guard_check "${repo}" "${head}" "${sha(repo, 'HEAD~51')}" "edge"`).status).not.toBe(0)
  })

  it('refuses a target that is not an ancestor of HEAD', () => {
    const dir = makeRepo(5)
    try {
      const head = sha(dir, 'HEAD')
      execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', 'side', 'HEAD~2'], { stdio: 'pipe' })
      writeFileSync(join(dir, 'g'), 'side')
      execFileSync('git', ['-C', dir, 'add', 'g'], { stdio: 'pipe' })
      execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'side'], { stdio: 'pipe' })
      const side = sha(dir, 'HEAD')
      const r = runGuard(`rollback_guard_check "${dir}" "${head}" "${side}" "divergent"`)
      expect(r.status).not.toBe(0)
      expect(r.out).toContain('NEM ose')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a nonexistent or empty target instead of guessing', () => {
    const head = sha(repo, 'HEAD')
    expect(runGuard(`rollback_guard_check "${repo}" "${head}" "deadbeefdeadbeef" "x"`).status).not.toBe(0)
    expect(runGuard(`rollback_guard_check "${repo}" "${head}" "" "x"`).status).not.toBe(0)
  })

  // The floor is what breaks the LOOP: below it, the restored tree re-arms the duplicate watchdog.
  it('refuses a target below the floor commit even when the distance is fine', () => {
    const head = sha(repo, 'HEAD')
    const floor = sha(repo, 'HEAD~10')
    const belowFloor = sha(repo, 'HEAD~11')
    const above = runGuard(`rollback_guard_check "${repo}" "${head}" "${sha(repo, 'HEAD~9')}" "floor"`, {
      ROLLBACK_GUARD_MIN_SHA: floor,
    })
    expect(above.status).toBe(0)
    const below = runGuard(`rollback_guard_check "${repo}" "${head}" "${belowFloor}" "floor"`, {
      ROLLBACK_GUARD_MIN_SHA: floor,
    })
    expect(below.status).not.toBe(0)
    expect(below.out).toContain('padlo')
  })

  it('skips the floor check (rather than blocking every rollback) when the floor commit is absent', () => {
    const head = sha(repo, 'HEAD')
    const r = runGuard(`rollback_guard_check "${repo}" "${head}" "${sha(repo, 'HEAD~1')}" "fork"`, {
      ROLLBACK_GUARD_MIN_SHA: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
    expect(r.status).toBe(0)
    expect(r.out).toContain('padlo-ellenorzes kimarad')
  })

  it('quarantines a stray update-health-watchdog.sh instead of leaving it armed', () => {
    const dir = makeRepo(1)
    try {
      const stray = join(dir, 'store', 'update-health-watchdog.sh')
      writeFileSync(stray, '#!/bin/bash\necho loop\n')
      const r = runGuard(`bash "${GUARD}" --quarantine-stray "${dir}"`)
      expect(r.status).toBe(0)
      expect(existsSync(stray)).toBe(false) // no longer where the old update.sh would find it
      const quarantined = readdirSync(join(dir, 'store', 'quarantine'))
      expect(quarantined.some((f) => f.startsWith('update-health-watchdog.sh.'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a no-op when there is no stray file', () => {
    const dir = makeRepo(1)
    try {
      expect(runGuard(`bash "${GUARD}" --quarantine-stray "${dir}"`).status).toBe(0)
      expect(existsSync(join(dir, 'store', 'quarantine'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('rollback-guard wiring (card 980454f7)', () => {
  // Every automated `git reset --hard <old>` must sit behind the guard. Unwiring one of these
  // reintroduces the incident silently, so the wiring is asserted rather than trusted.
  it('gates the build-failure rollback in update.sh', () => {
    const src = readFileSync(join(REPO, 'update.sh'), 'utf-8')
    expect(src).toMatch(/rollback_guard_check "\$INSTALL_DIR".*"update-build-failure"/)
  })

  it('gates the health-check rollback in update-finalize.sh', () => {
    const src = readFileSync(join(REPO, 'store', 'update-finalize.sh'), 'utf-8')
    expect(src).toMatch(/rollback_guard_check "\$INSTALL_DIR".*"update-health-check"/)
    // the reset must be INSIDE the guarded branch, not merely somewhere in the file
    const guardAt = src.indexOf('rollback_guard_check')
    const resetAt = src.indexOf('git reset --hard "$OLD_FULL"')
    expect(guardAt).toBeGreaterThan(-1)
    expect(resetAt).toBeGreaterThan(guardAt)
  })

  it('gates recovery-prev-version.sh and keeps an operator override', () => {
    const src = readFileSync(join(REPO, 'recovery-prev-version.sh'), 'utf-8')
    expect(src).toContain('rollback_guard_check "$INSTALL_DIR" "$CUR_FULL" "$TARGET_FULL"')
    const guardAt = src.indexOf('rollback_guard_check "$INSTALL_DIR"')
    const checkoutAt = src.indexOf('git -c advice.detachedHead=false checkout "$TARGET_FULL"')
    expect(checkoutAt).toBeGreaterThan(guardAt)
    expect(src).toContain('--force') // deliberate deep recovery stays possible for a human
  })

  it('pins the floor to the commit that removed the duplicate watchdog', () => {
    // A drifting floor would quietly re-open the exact window the loop came through.
    expect(readFileSync(GUARD, 'utf-8')).toContain(
      'ROLLBACK_GUARD_DEFAULT_MIN_SHA="5bc09832367c530dbc9796c3efc90d29f54ae728"',
    )
  })

  // Cybersec NO-GO on 0006c5f: `[ "$distance" -gt "$MAX" ]` with a non-numeric MAX prints an integer
  // error to stderr and evaluates FALSE, so the refusal branch never runs and the guard fails OPEN --
  // a typo in a fork or test env silently disabled the only control against a deep rollback.
  it.each(['abc', '50x', ' ', '-5', '5.0'])(
    'falls back to the default limit instead of failing open on MAX_DISTANCE=%j',
    (bad) => {
      const dir = makeRepo(60)
      try {
        const head = sha(dir, 'HEAD')
        const far = sha(dir, 'HEAD~55') // well past the default 50
        const r = runGuard(`rollback_guard_check "${dir}" "${head}" "${far}" "badcfg"`, {
          ROLLBACK_GUARD_MAX_DISTANCE: bad,
        })
        expect(r.status, `MAX=${JSON.stringify(bad)} must still refuse`).not.toBe(0)
        expect(r.out).toContain('ervenytelen ROLLBACK_GUARD_MAX_DISTANCE')
        expect(r.out).toContain('55 committal van hatra')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  // Without this the validation could be "fixed" by ignoring the variable entirely.
  it('still honours a deliberate, valid permissive limit', () => {
    const dir = makeRepo(60)
    try {
      const head = sha(dir, 'HEAD')
      const r = runGuard(`rollback_guard_check "${dir}" "${head}" "${sha(dir, 'HEAD~55')}" "override"`, {
        ROLLBACK_GUARD_MAX_DISTANCE: '99999',
      })
      expect(r.status).toBe(0)
      expect(r.out).not.toContain('ervenytelen')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves a log trace whenever it runs with a weakened configuration', () => {
    const dir = makeRepo(6)
    try {
      const head = sha(dir, 'HEAD')
      const log = join(dir, 'store', 'rollback-guard.log')
      // permissive on both axes: huge limit AND floor disabled -> allowed, but recorded
      const r = runGuard(`rollback_guard_check "${dir}" "${head}" "${sha(dir, 'HEAD~5')}" "weak"`, {
        ROLLBACK_GUARD_MAX_DISTANCE: '99999',
        ROLLBACK_GUARD_MIN_SHA: '',
      })
      expect(r.status).toBe(0) // it did allow
      const written = readFileSync(log, 'utf-8')
      expect(written).toContain('NON-DEFAULT-CONFIG')
      expect(written).toContain('max-distance=99999')
      expect(written).toContain('floor=<kikapcsolva>')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes no config trace on a default run', () => {
    const dir = makeRepo(6)
    try {
      const head = sha(dir, 'HEAD')
      runGuard(`rollback_guard_check "${dir}" "${head}" "${sha(dir, 'HEAD~1')}" "plain"`)
      expect(existsSync(join(dir, 'store', 'rollback-guard.log'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps --dry-run side-effect-free (reason, not the escalating check)', () => {
    const src = readFileSync(join(REPO, 'recovery-prev-version.sh'), 'utf-8')
    const dry = src.slice(src.indexOf('if [ "$DRY_RUN" = "1" ]; then'))
    const body = dry.slice(0, dry.indexOf('elif'))
    expect(body).toContain('rollback_guard_reason') // no history write, no notification
    expect(body).not.toContain('rollback_guard_check')
  })

  it('quarantines the stray watchdog at boot', () => {
    expect(readFileSync(join(REPO, 'scripts', 'start.sh'), 'utf-8')).toContain('--quarantine-stray')
  })

  it('falls back to REFUSING when the guard file is missing, never to an unchecked rollback', () => {
    for (const f of ['update.sh', 'store/update-finalize.sh', 'recovery-prev-version.sh']) {
      const src = readFileSync(join(REPO, f), 'utf-8')
      const fallback = src.slice(src.indexOf('rollback_guard_check() {'))
      expect(fallback, `${f} fallback must return 1`).toMatch(/rollback_guard_check\(\) \{[\s\S]{0,400}?return 1/)
    }
  })

  // update.sh regenerates store/update-finalize.sh from a heredoc on every run, so an edit to only one
  // copy is silently reverted at the next update -- exactly the kind of drift that would un-gate the
  // health-check rollback again.
  it('keeps update.sh\'s embedded finalizer byte-identical to store/update-finalize.sh', () => {
    const src = readFileSync(join(REPO, 'update.sh'), 'utf-8')
    const start = src.indexOf("<<'FINALIZE_EOF'\n")
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start + "<<'FINALIZE_EOF'\n".length)
    const end = body.indexOf('\nFINALIZE_EOF\n')
    expect(end).toBeGreaterThan(-1)
    const embedded = body.slice(0, end + 1)
    expect(embedded).toBe(readFileSync(join(REPO, 'store', 'update-finalize.sh'), 'utf-8'))
  })
})
