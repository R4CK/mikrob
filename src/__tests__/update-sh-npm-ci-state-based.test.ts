// Card 508153a9 (RedHat R1 follow-up on d1641163): update.sh's npm-ci decision used to be
// git-diff-only (OLD_VERSION..NEW_VERSION for package(-lock).json). That diff is empty right after
// sync_live_install() (marveen-land.sh) fast-forwards the live install's source OUTSIDE this script
// -- $INSTALL_DIR/package-lock.json can move while node_modules stays on the old packages, and the
// "already on latest version" early-exit (reached when OLD_VERSION==NEW_VERSION) used to return
// success WITHOUT ever reaching the npm-ci decision at all. This file runs the REAL extracted block
// (between NPM_CI_STATE_DECISION_BLOCK_START/END, same verbatim-extraction convention as
// fleet-test-stale-root-node-modules-guard.test.ts) against scratch fixtures, stubbing only git/npm
// and the few helper functions/vars the block references but this file doesn't define.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(PROJECT_ROOT, 'update.sh')
const STALE_CHECK_PY = join(PROJECT_ROOT, 'store', 'node-modules-stale-check.py')
const BLOCK_START = '# >>> NPM_CI_STATE_DECISION_BLOCK_START'
const BLOCK_END = '# <<< NPM_CI_STATE_DECISION_BLOCK_END'

function extractBlock(scriptText: string): string {
  const startAt = scriptText.indexOf(BLOCK_START)
  const endAt = scriptText.indexOf(BLOCK_END)
  if (startAt < 0 || endAt < 0 || endAt < startAt) {
    throw new Error('could not find NPM_CI_STATE_DECISION_BLOCK markers in update.sh')
  }
  return scriptText.slice(startAt, endAt + BLOCK_END.length)
}

let installDir: string

beforeEach(() => {
  installDir = mkdtempSync(join(tmpdir(), 'update-sh-npm-ci-'))
})

afterEach(() => {
  rmSync(installDir, { recursive: true, force: true })
})

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value))
}

/** A root whose node_modules genuinely matches its own lock (fresh). */
function makeFreshInstall(root: string): void {
  writeJson(join(root, 'package-lock.json'), { packages: { '': {}, 'node_modules/some-dep': { version: '1.0.0' } } })
  mkdirSync(join(root, 'node_modules', 'some-dep'), { recursive: true })
  writeJson(join(root, 'node_modules', '.package-lock.json'), { packages: { 'node_modules/some-dep': { version: '1.0.0' } } })
  writeJson(join(root, 'node_modules', 'some-dep', 'package.json'), { name: 'some-dep', version: '1.0.0' })
}

/** A root whose node_modules is stale relative to its own lock (version mismatch). */
function makeStaleInstall(root: string): void {
  writeJson(join(root, 'package-lock.json'), { packages: { '': {}, 'node_modules/some-dep': { version: '2.0.0' } } })
  mkdirSync(join(root, 'node_modules', 'some-dep'), { recursive: true })
  writeJson(join(root, 'node_modules', '.package-lock.json'), { packages: { 'node_modules/some-dep': { version: '1.0.0' } } })
  writeJson(join(root, 'node_modules', 'some-dep', 'package.json'), { name: 'some-dep', version: '1.0.0' })
}

interface HarnessOpts {
  oldVersion: string
  newVersion: string
  gitDiffOutput: string // what `git diff OLD NEW --name-only` should print
  distFresh?: boolean // default true -- BUILT_COMMIT matches NEW_VERSION_FULL
}

function runHarness(block: string, root: string, opts: HarnessOpts): { stdout: string; status: number | null } {
  const distFresh = opts.distFresh ?? true
  const builtCommitFile = join(root, '.built-commit')
  if (distFresh) {
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(builtCommitFile, `${opts.newVersion}-full\n`)
  }
  const harness = `
set -uo pipefail
INSTALL_DIR="${root}"
NODE_MODULES_STALE_CHECK_PY="${STALE_CHECK_PY}"
OLD_VERSION="${opts.oldVersion}"
NEW_VERSION="${opts.newVersion}"
NEW_VERSION_FULL="${opts.newVersion}-full"
BUILT_COMMIT_FILE="${builtCommitFile}"
FORCE_REBUILD=0
RESEED_FLEET=0
REGEN_CLAUDEMD=0
MARVEEN_LANG=hu
BOLD='' GREEN='' RED='' ORANGE='' DIM='' NC=''
RESULT_STATUS="" RESULT_PHASE="" RESULT_MSG=""
restore_stash_before_exit() { :; }
git() { if [ "\${1:-}" = "diff" ]; then printf '%s\\n' "${opts.gitDiffOutput}"; fi; }
NPM_CI_CALLED=0
npm() { if [ "\${1:-}" = "ci" ]; then NPM_CI_CALLED=1; echo "FAKE_NPM_CI_CALLED"; fi; return 0; }
retry() { shift 2; "$@"; }
${block}
echo "REACHED_END_OF_BLOCK npm_ci_called=\${NPM_CI_CALLED}"
`
  try {
    const stdout = execFileSync('bash', ['-c', harness], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { stdout, status: 0 }
  } catch (e) {
    const err = e as { status: number | null; stdout: Buffer | string }
    return { stdout: String(err.stdout), status: err.status }
  }
}

describe('update.sh: the npm-ci decision is state-based, not git-diff-only (card 508153a9)', () => {
  const block = extractBlock(readFileSync(SCRIPT, 'utf-8'))

  it('REAL CODE: OLD==NEW, dist fresh, node_modules fresh, no reseed flags -- exits early, npm ci never runs', () => {
    makeFreshInstall(installDir)
    const result = runHarness(block, installDir, { oldVersion: 'abc', newVersion: 'abc', gitDiffOutput: '' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('legfrissebb verzi')
    expect(result.stdout).not.toContain('FAKE_NPM_CI_CALLED')
    expect(result.stdout).not.toContain('REACHED_END_OF_BLOCK') // exit 0 inside the block
  })

  it('REAL CODE: OLD==NEW (lander already fast-forwarded), dist fresh, but node_modules is STALE -- falls through and runs npm ci (the R1 gap this card closes)', () => {
    makeStaleInstall(installDir)
    const result = runHarness(block, installDir, { oldVersion: 'abc', newVersion: 'abc', gitDiffOutput: '' })
    expect(result.stdout).toContain('node_modules elavult')
    expect(result.stdout).toContain('FAKE_NPM_CI_CALLED')
  })

  it('REAL CODE: OLD!=NEW, git diff shows package-lock.json changed -- npm ci runs (pre-existing behavior, unchanged)', () => {
    makeFreshInstall(installDir)
    const result = runHarness(block, installDir, { oldVersion: 'old', newVersion: 'new', gitDiffOutput: 'package-lock.json' })
    expect(result.stdout).toContain('FAKE_NPM_CI_CALLED')
  })

  it('REAL CODE: OLD!=NEW, git diff shows nothing relevant, node_modules fresh -- npm ci does not run (no regression)', () => {
    makeFreshInstall(installDir)
    const result = runHarness(block, installDir, { oldVersion: 'old', newVersion: 'new', gitDiffOutput: 'README.md' })
    expect(result.stdout).not.toContain('FAKE_NPM_CI_CALLED')
  })

  it('REAL CODE: OLD!=NEW, git diff shows nothing relevant, but node_modules is STALE -- npm ci still runs', () => {
    makeStaleInstall(installDir)
    const result = runHarness(block, installDir, { oldVersion: 'old', newVersion: 'new', gitDiffOutput: 'README.md' })
    expect(result.stdout).toContain('FAKE_NPM_CI_CALLED')
  })

  it('MUTATION: removing the DEPS_STALE OR-condition from the npm-ci trigger lets a stale install through git-diff-empty undetected (proves the test catches the R1 bypass)', () => {
    makeStaleInstall(installDir)
    const mutated = block.replace(
      `if git diff "$OLD_VERSION" "$NEW_VERSION" --name-only | grep -qE "^package(-lock)?\\.json$" \\
  || python3 "$NODE_MODULES_STALE_CHECK_PY" "$INSTALL_DIR"; then`,
      `if git diff "$OLD_VERSION" "$NEW_VERSION" --name-only | grep -qE "^package(-lock)?\\.json$"; then`,
    )
    expect(mutated, 'the mutation did not apply').not.toBe(block)
    const result = runHarness(mutated, installDir, { oldVersion: 'old', newVersion: 'new', gitDiffOutput: 'README.md' })
    expect(result.stdout).not.toContain('FAKE_NPM_CI_CALLED')
  })

  it('MUTATION: removing the DEPS_STALE check from the early-exit branch lets OLD==NEW skip past silently (proves the test catches the early-exit bypass)', () => {
    makeStaleInstall(installDir)
    const mutated = block.replace(
      `if [ "$FORCE_REBUILD" = "1" ] || [ "$DIST_STALE" = "1" ] || [ "$DEPS_STALE" = "1" ]; then`,
      `if [ "$FORCE_REBUILD" = "1" ] || [ "$DIST_STALE" = "1" ]; then`,
    )
    expect(mutated, 'the mutation did not apply').not.toBe(block)
    const result = runHarness(mutated, installDir, { oldVersion: 'abc', newVersion: 'abc', gitDiffOutput: '' })
    // Without DEPS_STALE in the early-exit guard, the "already up to date" branch takes the exit-0
    // path even though node_modules is stale -- npm ci never gets a chance to run.
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('FAKE_NPM_CI_CALLED')
  })
})
