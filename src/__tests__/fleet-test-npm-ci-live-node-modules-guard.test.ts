// fleet-test.sh's npm-ci-vs-symlink block (card 466decff) has a real-world failure mode its own
// prior test never caught, because that test only asserted on TEXT (`includes(...)`), not on
// BEHAVIOR: WhiteHat found (card 5d365589, source: 466decff Gate-SHA 90ebf0f7) that
//
//   F1 (MEDIUM): deleting the `[ -L "$TEST_TREE/node_modules" ] && rm -f ...` line still leaves
//       the text-based test green, even though WITHOUT it, running `npm ci` while
//       $TEST_TREE/node_modules is still a symlink to $ROOT/node_modules does not just replace the
//       symlink -- it resolves the link and empties $ROOT/node_modules' OWN CONTENTS in place
//       (measured below with a real `npm ci`), i.e. it wipes the LIVE install's node_modules that
//       every other concurrently-running agent shares.
//   F2 (LOW): turning that same line into a comment is equally invisible to a text-only check.
//   F3 (LOW): if FLEET_TEST_TREE is ever pointed at $ROOT itself, $TEST_TREE/node_modules IS
//       $ROOT/node_modules (a real directory, not a symlink) -- the "lockfiles agree" branch's own
//       cleanup (`rm -rf ... when not a symlink`) would then delete the live install's
//       node_modules outright.
//
// This test runs the REAL extracted block (between the NPM_CI_SYMLINK_BLOCK_START/END markers in
// store/fleet-test.sh, not a hand-written stand-in for it) against scratch ROOT/TEST_TREE
// directories, with a REAL `npm ci`, and checks that $ROOT/node_modules' actual file content
// survives -- not just that the script exits 0.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, lstatSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(PROJECT_ROOT, 'store', 'fleet-test.sh')
const START = '# >>> NPM_CI_SYMLINK_BLOCK_START'
const END = '# <<< NPM_CI_SYMLINK_BLOCK_END'

function extractBlock(scriptText: string): string {
  const startAt = scriptText.indexOf(START)
  const endAt = scriptText.indexOf(END)
  if (startAt < 0 || endAt < 0 || endAt < startAt) {
    throw new Error('could not find the NPM_CI_SYMLINK_BLOCK_START/END markers in fleet-test.sh')
  }
  return scriptText.slice(startAt, endAt + END.length)
}

let scratchRoot: string

beforeEach(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), 'fleet-test-npm-ci-guard-'))
})

afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true })
})

function makeRoot(root: string): void {
  mkdirSync(join(root, 'node_modules', 'some-dep'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'LIVE_MARKER_FILE'), 'LIVE_MARKER_CONTENT\n')
  writeFileSync(join(root, 'node_modules', 'some-dep', 'index.js'), 'dep content\n')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root-probe', version: '1.0.0' }))
  execFileSync('npm', ['install', '--package-lock-only'], { cwd: root })
}

function makeDivergedWorktree(root: string, testTree: string): void {
  mkdirSync(testTree, { recursive: true })
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
  pkg.version = '1.0.1'
  writeFileSync(join(testTree, 'package.json'), JSON.stringify(pkg))
  const lock = readFileSync(join(root, 'package-lock.json'), 'utf-8').replace(/1\.0\.0/g, '1.0.1')
  writeFileSync(join(testTree, 'package-lock.json'), lock)
  // a linked worktree's .git is a FILE (card 5d365589 F3 guard relies on this)
  writeFileSync(join(testTree, '.git'), 'gitdir: /nonexistent/for/this/test\n')
}

function rootNodeModulesSurvived(root: string): boolean {
  const nm = join(root, 'node_modules')
  if (!existsSync(nm)) return false
  const entries = readdirSync(nm)
  if (!entries.includes('LIVE_MARKER_FILE') || !entries.includes('some-dep')) return false
  return readFileSync(join(nm, 'LIVE_MARKER_FILE'), 'utf-8').includes('LIVE_MARKER_CONTENT')
}

function runBlock(block: string, root: string, testTree: string): { status: number | null; stderr: string } {
  const harness = `set -uo pipefail\nROOT="${root}"\nTEST_TREE="${testTree}"\ndie() { echo "die: $2" >&2; exit "$1"; }\n${block}\n`
  try {
    const stderr = execFileSync('bash', ['-c', harness], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stderr }
  } catch (e) {
    const err = e as { status: number | null; stderr: Buffer | string }
    return { status: err.status, stderr: String(err.stderr) }
  }
}

describe('fleet-test.sh npm-ci-vs-symlink block protects the live $ROOT/node_modules (card 5d365589)', () => {
  const realBlock = extractBlock(readFileSync(SCRIPT, 'utf-8'))

  it('REAL CODE, diverged lockfiles: npm ci runs in $TEST_TREE and $ROOT/node_modules survives untouched', () => {
    const root = join(scratchRoot, 'ROOT')
    const testTree = join(scratchRoot, 'TEST_TREE')
    mkdirSync(root, { recursive: true })
    makeRoot(root)
    makeDivergedWorktree(root, testTree)
    execFileSync('ln', ['-s', join(root, 'node_modules'), join(testTree, 'node_modules')])

    const result = runBlock(realBlock, root, testTree)

    expect(result.status).toBe(0)
    expect(rootNodeModulesSurvived(root)).toBe(true)
    // A fixture package with zero real dependencies legitimately leaves npm ci with nothing to
    // write, so $TEST_TREE/node_modules may not exist at all afterwards -- the only thing this
    // test cares about is that it is NEVER a symlink into $ROOT/node_modules.
    if (existsSync(join(testTree, 'node_modules'))) {
      expect(lstatSync(join(testTree, 'node_modules')).isSymbolicLink()).toBe(false)
    }
  })

  it('REAL CODE, matching lockfiles: $TEST_TREE/node_modules stays (or becomes) a symlink, $ROOT untouched', () => {
    const root = join(scratchRoot, 'ROOT')
    const testTree = join(scratchRoot, 'TEST_TREE')
    mkdirSync(root, { recursive: true })
    makeRoot(root)
    mkdirSync(testTree, { recursive: true })
    writeFileSync(join(testTree, 'package.json'), readFileSync(join(root, 'package.json')))
    writeFileSync(join(testTree, 'package-lock.json'), readFileSync(join(root, 'package-lock.json')))
    writeFileSync(join(testTree, '.git'), 'gitdir: /nonexistent/for/this/test\n')

    const result = runBlock(realBlock, root, testTree)

    expect(result.status).toBe(0)
    expect(lstatSync(join(testTree, 'node_modules')).isSymbolicLink()).toBe(true)
    expect(rootNodeModulesSurvived(root)).toBe(true)
  })

  it('MUTATION (F1): deleting the symlink-removal line lets a diverged npm ci wipe $ROOT/node_modules', () => {
    const root = join(scratchRoot, 'ROOT')
    const testTree = join(scratchRoot, 'TEST_TREE')
    mkdirSync(root, { recursive: true })
    makeRoot(root)
    makeDivergedWorktree(root, testTree)
    execFileSync('ln', ['-s', join(root, 'node_modules'), join(testTree, 'node_modules')])

    const mutated = realBlock.replace('[ -L "$TEST_TREE/node_modules" ] && rm -f "$TEST_TREE/node_modules"', 'true # removed')
    expect(mutated, 'the mutation did not apply').not.toBe(realBlock)

    runBlock(mutated, root, testTree)

    expect(rootNodeModulesSurvived(root)).toBe(false)
  })

  it('MUTATION (F2): turning the symlink-removal line into a comment is the same defect as F1', () => {
    const root = join(scratchRoot, 'ROOT')
    const testTree = join(scratchRoot, 'TEST_TREE')
    mkdirSync(root, { recursive: true })
    makeRoot(root)
    makeDivergedWorktree(root, testTree)
    execFileSync('ln', ['-s', join(root, 'node_modules'), join(testTree, 'node_modules')])

    const mutated = realBlock.replace(
      '[ -L "$TEST_TREE/node_modules" ] && rm -f "$TEST_TREE/node_modules"',
      '# [ -L "$TEST_TREE/node_modules" ] && rm -f "$TEST_TREE/node_modules"',
    )
    expect(mutated, 'the mutation did not apply').not.toBe(realBlock)

    runBlock(mutated, root, testTree)

    expect(rootNodeModulesSurvived(root)).toBe(false)
  })

  it('REAL CODE (F3): FLEET_TEST_TREE=ROOT (TEST_TREE IS ROOT) is a no-op, never deletes node_modules', () => {
    const root = join(scratchRoot, 'ROOT')
    mkdirSync(root, { recursive: true })
    makeRoot(root)
    // $ROOT's own .git is a DIRECTORY (primary clone), never a file -- this is what the guard reads.
    mkdirSync(join(root, '.git'), { recursive: true })

    const result = runBlock(realBlock, root, root)

    expect(result.status).toBe(0)
    expect(rootNodeModulesSurvived(root)).toBe(true)
  })

  it('MUTATION (F3): removing the .git-is-a-file guard lets FLEET_TEST_TREE=ROOT delete node_modules', () => {
    const root = join(scratchRoot, 'ROOT')
    mkdirSync(root, { recursive: true })
    makeRoot(root)
    mkdirSync(join(root, '.git'), { recursive: true })

    const mutated = realBlock
      .replace('if [ -f "$TEST_TREE/.git" ]; then', 'if true; then')
      .replace(
        /else\n  echo "fleet-test\.sh: TEST_TREE is not a linked worktree[\s\S]*?\nfi\n# <<< NPM_CI_SYMLINK_BLOCK_END/,
        'fi\n# <<< NPM_CI_SYMLINK_BLOCK_END',
      )
    expect(mutated, 'the mutation did not apply').not.toBe(realBlock)

    runBlock(mutated, root, root)

    expect(rootNodeModulesSurvived(root)).toBe(false)
  })
})
