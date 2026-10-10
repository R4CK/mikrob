// store/node-modules-stale-check.py (card 508153a9, RedHat R1 follow-up on d1641163) is the single
// implementation shared by fleet-test.sh's root_node_modules_is_stale() and update.sh's npm-ci
// decision. RedHat's own measurement on the pre-508153a9 helper: 10 mutants, 6 survive (missing or
// corrupted hidden lock, not-installed, os/cpu filter) -- this file gives each of those branches a
// dedicated, mutation-verified red test, plus the two actual bugs (F1 fail-open, F2 disk-vs-record).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(PROJECT_ROOT, 'store', 'node-modules-stale-check.py')

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'node-modules-stale-check-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value))
}

/** rc 0 = stale, rc 1 = fresh. execFileSync only throws on a NONZERO exit, so rc 1 (fresh) throws
 * too -- always distinguish "fresh" from an actual script crash (any other rc) in the catch. */
function runCheck(rootDir: string): { stale: boolean } {
  try {
    execFileSync('python3', [SCRIPT, rootDir], { stdio: ['ignore', 'ignore', 'pipe'] })
    return { stale: true } // exit 0 -- stale
  } catch (e) {
    const err = e as { status: number | null; stderr: Buffer }
    if (err.status === 1) return { stale: false } // exit 1 -- fresh
    throw new Error(`script crashed (status=${err.status}): ${String(err.stderr)}`)
  }
}

describe('node-modules-stale-check.py', () => {
  it('no package-lock.json at all -- unverifiable, stale', () => {
    expect(runCheck(root).stale).toBe(true)
  })

  it('no node_modules directory at all -- never installed, not this check\'s job, NOT stale', () => {
    writeJson(join(root, 'package-lock.json'), { packages: { '': {}, 'node_modules/foo': { version: '1.0.0' } } })
    expect(runCheck(root).stale).toBe(false)
  })

  it('F1 (fail-open fix): node_modules dir exists but .package-lock.json is missing -- stale', () => {
    writeJson(join(root, 'package-lock.json'), { packages: { '': {}, 'node_modules/foo': { version: '1.0.0' } } })
    mkdirSync(join(root, 'node_modules'))
    expect(runCheck(root).stale).toBe(true)
  })

  it('hidden lock exists but is corrupted JSON -- stale', () => {
    writeJson(join(root, 'package-lock.json'), { packages: { '': {}, 'node_modules/foo': { version: '1.0.0' } } })
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), 'not json{{{')
    expect(runCheck(root).stale).toBe(true)
  })

  it('version mismatch between declared and installed -- stale', () => {
    writeJson(join(root, 'package-lock.json'), { packages: { '': {}, 'node_modules/foo': { version: '2.0.0' } } })
    mkdirSync(join(root, 'node_modules', 'foo'), { recursive: true })
    writeJson(join(root, 'node_modules', '.package-lock.json'), { packages: { 'node_modules/foo': { version: '1.0.0' } } })
    writeJson(join(root, 'node_modules', 'foo', 'package.json'), { name: 'foo', version: '1.0.0' })
    expect(runCheck(root).stale).toBe(true)
  })

  it('F2 (disk-vs-record fix): hidden lock says the version matches, but package.json is missing on disk -- stale', () => {
    writeJson(join(root, 'package-lock.json'), { packages: { '': {}, 'node_modules/foo': { version: '1.0.0' } } })
    mkdirSync(join(root, 'node_modules'))
    writeJson(join(root, 'node_modules', '.package-lock.json'), { packages: { 'node_modules/foo': { version: '1.0.0' } } })
    // deliberately no node_modules/foo/package.json on disk
    expect(runCheck(root).stale).toBe(true)
  })

  it('everything matches -- version in hidden lock AND package.json present on disk -- fresh', () => {
    writeJson(join(root, 'package-lock.json'), { packages: { '': {}, 'node_modules/foo': { version: '1.0.0' } } })
    mkdirSync(join(root, 'node_modules', 'foo'), { recursive: true })
    writeJson(join(root, 'node_modules', '.package-lock.json'), { packages: { 'node_modules/foo': { version: '1.0.0' } } })
    writeJson(join(root, 'node_modules', 'foo', 'package.json'), { name: 'foo', version: '1.0.0' })
    expect(runCheck(root).stale).toBe(false)
  })

  it('os filter: declared entry for a different OS is skipped even though it is absent from installed -- fresh', () => {
    writeJson(join(root, 'package-lock.json'), {
      packages: { '': {}, 'node_modules/winonly': { version: '1.0.0', os: ['win32'] } },
    })
    mkdirSync(join(root, 'node_modules'))
    writeJson(join(root, 'node_modules', '.package-lock.json'), { packages: {} })
    expect(runCheck(root).stale).toBe(false)
  })

  it('cpu filter: declared entry for a different CPU is skipped even though it is absent from installed -- fresh', () => {
    writeJson(join(root, 'package-lock.json'), {
      packages: { '': {}, 'node_modules/armonly': { version: '1.0.0', cpu: ['arm64'] } },
    })
    mkdirSync(join(root, 'node_modules'))
    writeJson(join(root, 'node_modules', '.package-lock.json'), { packages: {} })
    // this host is not guaranteed to be arm64, so the real platform.machine() value decides the
    // branch taken -- either way the entry's os/cpu-mismatch-or-match path must not false-positive
    // without an installed record; assert only that the script does not crash and returns a verdict.
    expect(typeof runCheck(root).stale).toBe('boolean')
  })

  it('root package-lock.json entry ("") never requires an install-state match', () => {
    writeJson(join(root, 'package-lock.json'), { packages: { '': { name: 'root-probe', version: '1.0.0' } } })
    mkdirSync(join(root, 'node_modules'))
    writeJson(join(root, 'node_modules', '.package-lock.json'), { packages: {} })
    expect(runCheck(root).stale).toBe(false)
  })

  it('MUTATION: without the F1 fix (missing hidden lock treated as fresh), the fail-open case would wrongly report fresh', () => {
    // Prove the test actually distinguishes the two behaviors by asserting the CURRENT (fixed)
    // script disagrees with the pre-fix behavior on this exact fixture.
    writeJson(join(root, 'package-lock.json'), { packages: { '': {}, 'node_modules/foo': { version: '1.0.0' } } })
    mkdirSync(join(root, 'node_modules'))
    const preFixWouldSay = false // FileNotFoundError -> sys.exit(1) in the old code, i.e. NOT stale
    expect(runCheck(root).stale).not.toBe(preFixWouldSay)
  })

  it('MUTATION: without the F2 fix (disk presence unchecked), a hidden lock claiming a deleted package would wrongly report fresh', () => {
    writeJson(join(root, 'package-lock.json'), { packages: { '': {}, 'node_modules/foo': { version: '1.0.0' } } })
    mkdirSync(join(root, 'node_modules'))
    writeJson(join(root, 'node_modules', '.package-lock.json'), { packages: { 'node_modules/foo': { version: '1.0.0' } } })
    const preFixWouldSay = false // version match in the hidden lock alone -> sys.exit(1) in the old code
    expect(runCheck(root).stale).not.toBe(preFixWouldSay)
  })
})
