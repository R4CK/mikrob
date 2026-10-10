// fleet-test.sh's npm-ci-vs-symlink block (card 466decff/5d365589) only ever compared $TEST_TREE's
// package-lock.json against $ROOT's -- two lockfiles being byte-identical says nothing about whether
// $ROOT/node_modules itself still matches what $ROOT's OWN lockfile declares (card e6df15da RedHat
// N3, root-caused here as card d1641163). sync_live_install() (store/marveen-land.sh) fast-forwards
// $ROOT's SOURCE on every landing but deliberately never runs npm ci there -- so right after a
// dependency-bump lands, $ROOT/package-lock.json has moved while $ROOT/node_modules is still on the
// old packages until someone runs `npm ci` there by hand. Measured live on this exact gap: lock
// declared vitest ^5.0.3, $ROOT/node_modules had 2.1.9 installed -- and the old "lockfiles agree"
// branch would symlink that stale tree into $TEST_TREE without noticing, because $TEST_TREE's own
// lockfile (freshly checked out from the same landed commit) DOES match $ROOT's lockfile text.
//
// This test runs the REAL extracted block (between the NPM_CI_SYMLINK_BLOCK_START/END markers,
// including the root_node_modules_is_stale() helper defined earlier in the file) against scratch
// ROOT/TEST_TREE directories with a crafted node_modules/.package-lock.json, not a hand-written
// stand-in for the check.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, lstatSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(PROJECT_ROOT, 'store', 'fleet-test.sh')
const HELPER_START = 'root_node_modules_is_stale() {'
const BLOCK_START = '# >>> NPM_CI_SYMLINK_BLOCK_START'
const BLOCK_END = '# <<< NPM_CI_SYMLINK_BLOCK_END'

function extractHarnessScript(scriptText: string): string {
  const helperAt = scriptText.indexOf(HELPER_START)
  const blockStartAt = scriptText.indexOf(BLOCK_START)
  const blockEndAt = scriptText.indexOf(BLOCK_END)
  if (helperAt < 0 || blockStartAt < 0 || blockEndAt < 0 || blockEndAt < blockStartAt) {
    throw new Error('could not find root_node_modules_is_stale() or the NPM_CI_SYMLINK_BLOCK markers in fleet-test.sh')
  }
  // the helper function definition ends at the first line-start "}" after it starts
  const helperEndAt = scriptText.indexOf('\n}\n', helperAt) + 3
  return scriptText.slice(helperAt, helperEndAt) + '\n' + scriptText.slice(blockStartAt, blockEndAt + BLOCK_END.length)
}

let scratchRoot: string

beforeEach(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), 'fleet-test-stale-root-guard-'))
})

afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true })
})

// declaredVersion is what package-lock.json says; installedVersion is what node_modules/.package-lock.json
// says was actually installed. When they differ, $ROOT's own node_modules is stale relative to its own lock.
// node-modules-stale-check.py's F2 fix (card 508153a9) also requires the package to actually be
// present on disk when installedVersion matches declaredVersion -- so the "fresh" fixture (card
// d1641163's own test below) creates node_modules/some-dep/package.json too, matching a real install.
function makeRoot(root: string, declaredVersion: string, installedVersion: string | null): void {
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'LIVE_MARKER_FILE'), 'LIVE_MARKER_CONTENT\n')
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'root-probe', version: '1.0.0' },
      'node_modules/some-dep': { version: declaredVersion },
    },
  }
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root-probe', version: '1.0.0' }))
  if (installedVersion !== null) {
    const installed = { lockfileVersion: 3, packages: { 'node_modules/some-dep': { version: installedVersion } } }
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), JSON.stringify(installed))
    if (installedVersion === declaredVersion) {
      mkdirSync(join(root, 'node_modules', 'some-dep'), { recursive: true })
      writeFileSync(join(root, 'node_modules', 'some-dep', 'package.json'), JSON.stringify({ name: 'some-dep', version: installedVersion }))
    }
  }
}

function makeMatchingWorktree(root: string, testTree: string): void {
  mkdirSync(testTree, { recursive: true })
  writeFileSync(join(testTree, 'package.json'), readFileSync(join(root, 'package.json')))
  writeFileSync(join(testTree, 'package-lock.json'), readFileSync(join(root, 'package-lock.json')))
  // a linked worktree's .git is a FILE (card 5d365589 F3 guard relies on this)
  writeFileSync(join(testTree, '.git'), 'gitdir: /nonexistent/for/this/test\n')
}

function rootNodeModulesSurvived(root: string): boolean {
  const marker = join(root, 'node_modules', 'LIVE_MARKER_FILE')
  return existsSync(marker) && readFileSync(marker, 'utf-8').includes('LIVE_MARKER_CONTENT')
}

// The harness runs via `bash -c`, where ${BASH_SOURCE[0]} is empty -- root_node_modules_is_stale()
// falls back to NODE_MODULES_STALE_CHECK_PY (card 508153a9) for exactly this reason, so the
// extracted snippet still finds the real, non-extracted node-modules-stale-check.py.
const STALE_CHECK_PY = join(PROJECT_ROOT, 'store', 'node-modules-stale-check.py')

function runHarness(harnessScript: string, root: string, testTree: string): { status: number | null; stderr: string } {
  const harness = `set -uo pipefail\nROOT="${root}"\nTEST_TREE="${testTree}"\nNODE_MODULES_STALE_CHECK_PY="${STALE_CHECK_PY}"\ndie() { echo "die: $2" >&2; exit "$1"; }\n${harnessScript}\n`
  try {
    const stderr = execFileSync('bash', ['-c', harness], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stderr }
  } catch (e) {
    const err = e as { status: number | null; stderr: Buffer | string }
    return { status: err.status, stderr: String(err.stderr) }
  }
}

describe('fleet-test.sh refuses to symlink $ROOT/node_modules when it is stale relative to its own lock (card d1641163)', () => {
  const harnessScript = extractHarnessScript(readFileSync(SCRIPT, 'utf-8'))

  it('REAL CODE: lockfiles match but $ROOT/node_modules is stale -- routes to the npm-ci branch, never the symlink, $ROOT survives untouched', () => {
    const root = join(scratchRoot, 'ROOT')
    const testTree = join(scratchRoot, 'TEST_TREE')
    mkdirSync(root, { recursive: true })
    makeRoot(root, '5.0.3', '2.1.9') // declared 5.0.3, actually installed 2.1.9 -- stale
    makeMatchingWorktree(root, testTree)

    const result = runHarness(harnessScript, root, testTree)

    // The fixture's package-lock.json declares a dependency that does not actually resolve (no real
    // registry/local package behind it), so `npm ci` itself can fail here -- that is fine and not
    // what this test is about. The npm-ci branch's own correctness (symlink removed first, $ROOT
    // never written to, a real failure dies loudly) is already covered by
    // fleet-test-npm-ci-live-node-modules-guard.test.ts for the pre-existing lockfile-diff case; this
    // test only has to prove the STALE check routes into that SAME already-safe branch instead of
    // trusting the symlink.
    expect(result.stderr).toContain('live install dependency state stale')
    expect(rootNodeModulesSurvived(root)).toBe(true)
    if (existsSync(join(testTree, 'node_modules'))) {
      expect(lstatSync(join(testTree, 'node_modules')).isSymbolicLink()).toBe(false)
    }
  })

  it('REAL CODE: lockfiles match and $ROOT/node_modules matches its own lock -- symlinks as before', () => {
    const root = join(scratchRoot, 'ROOT')
    const testTree = join(scratchRoot, 'TEST_TREE')
    mkdirSync(root, { recursive: true })
    makeRoot(root, '5.0.3', '5.0.3') // declared and installed agree -- fresh
    makeMatchingWorktree(root, testTree)

    const result = runHarness(harnessScript, root, testTree)

    expect(result.status).toBe(0)
    expect(lstatSync(join(testTree, 'node_modules')).isSymbolicLink()).toBe(true)
    expect(rootNodeModulesSurvived(root)).toBe(true)
  })

  it('MUTATION: removing the root_node_modules_is_stale() check lets a stale $ROOT get symlinked in (proves the test catches the N3 bypass)', () => {
    const root = join(scratchRoot, 'ROOT')
    const testTree = join(scratchRoot, 'TEST_TREE')
    mkdirSync(root, { recursive: true })
    makeRoot(root, '5.0.3', '2.1.9') // stale, same fixture as the first test
    makeMatchingWorktree(root, testTree)

    const mutated = harnessScript.replace(
      `  elif root_node_modules_is_stale; then
    echo "fleet-test.sh: $ROOT/node_modules does not match $ROOT/package-lock.json (live install dependency state stale, card d1641163) -- running npm ci --include=dev in $TEST_TREE instead of symlinking" >&2
    NEEDS_REAL_INSTALL=1
  else`,
      '  else',
    )
    expect(mutated, 'the mutation did not apply').not.toBe(harnessScript)

    const result = runHarness(mutated, root, testTree)

    expect(result.status).toBe(0)
    // Without the check, the stale $ROOT/node_modules gets symlinked straight into $TEST_TREE --
    // exactly the bypass this card exists to close.
    expect(lstatSync(join(testTree, 'node_modules')).isSymbolicLink()).toBe(true)
  })
})
