// fleet-test.sh's $ROOT refusal (card 5d365589 N1, text-pinned by the sibling
// fleet-test-refuses-test-tree-is-root.test.ts) still had a BEHAVIOR gap RedHat found on the
// landed fix (card e6df15da, comment 14371, C1 MEDIUM): the `-ef` check compares $TEST_TREE to
// $ROOT using the CALLER's cwd, but the destructive reset/clean/checkout trio runs AFTER
// `cd "$ROOT"`. A RELATIVE FLEET_TEST_TREE value (".", "./", "sub/..") is not yet $ROOT when the
// guard runs, so it passes -- then means $ROOT once the script has cd'd there, and the trio
// mutates the live install: uncommitted edits reverted, untracked files deleted, HEAD detached.
//
// The text-pin sibling test cannot see this: the `-ef` check IS present, paired with `die 2`, and
// IS before `reset --hard` in the source -- all textually true, while the relative-path bypass is
// still open. This test runs the REAL extracted guard + destructive blocks (between the
// ROOT_GUARD_BLOCK_START/END and DESTRUCTIVE_RESET_BLOCK_START/END markers in store/fleet-test.sh,
// not a hand-written stand-in) against a scratch git repo standing in for $ROOT, and asserts on
// the repo's actual on-disk state afterwards -- not just the script's exit code.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync as readFile, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(PROJECT_ROOT, 'store', 'fleet-test.sh')
// Deliberately NOT under /tmp: fleet-test.sh's own temp-dir refusal (the case statement right
// above the ROOT_GUARD_BLOCK markers) dies with the SAME exit code (2) as the $ROOT refusal this
// test targets for an UNRELATED reason, which would make every assertion below pass for the wrong
// reason. A scratch dir under $HOME avoids that collision entirely.
const SCRATCH_BASE = join(homedir(), '.fleet-test-c1-scratch')
mkdirSync(SCRATCH_BASE, { recursive: true })

function extractBlock(scriptText: string, startMarker: string, endMarker: string): string {
  const startAt = scriptText.indexOf(startMarker)
  const endAt = scriptText.indexOf(endMarker)
  if (startAt < 0 || endAt < 0 || endAt < startAt) {
    throw new Error(`could not find markers ${startMarker}/${endMarker} in fleet-test.sh`)
  }
  return scriptText.slice(startAt, endAt + endMarker.length)
}

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(SCRATCH_BASE, 'run-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function makeRootRepo(root: string): string {
  mkdirSync(root, { recursive: true })
  execFileSync('git', ['init', '-q', root])
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'checkout', '-q', '-b', 'main'])
  writeFileSync(join(root, 'tracked.txt'), 'original content\n')
  execFileSync('git', ['-C', root, 'add', 'tracked.txt'])
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'initial'])
  const headBefore = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
  return headBefore
}

// Runs the guard block then the destructive block exactly as fleet-test.sh does: the guard
// evaluates $TEST_TREE against the caller's $PWD, THEN the real script `cd`s to $ROOT before any
// `git -C "$TEST_TREE"` call -- reproduced here with the same single `cd`, not duplicated logic.
function run(
  guardBlock: string,
  destructiveBlock: string,
  root: string,
  fleetTestTree: string,
  cwd: string,
): { status: number | null; stderr: string } {
  const harness = `set -uo pipefail
cd ${JSON.stringify(cwd)}
FLEET_TEST_TREE=${JSON.stringify(fleetTestTree)}
die() { echo "die:$1:$2" >&2; exit "$1"; }
${guardBlock}
cd "$ROOT" || die 3 "cannot cd to ROOT"
TARGET="$(git rev-parse HEAD)"
${destructiveBlock}
`
  try {
    const stderr = execFileSync('bash', ['-c', harness, 'bash', root], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stderr }
  } catch (e) {
    const err = e as { status: number | null; stderr: Buffer | string }
    return { status: err.status, stderr: String(err.stderr) }
  }
}

describe('fleet-test.sh refuses a RELATIVE FLEET_TEST_TREE that resolves to $ROOT after cd (card e6df15da C1)', () => {
  const scriptText = readFileSync(SCRIPT, 'utf-8')
  const guardBlock = extractBlock(scriptText, '# >>> ROOT_GUARD_BLOCK_START', '# <<< ROOT_GUARD_BLOCK_END')
    // ROOT is a harness-provided constant via $1 below, not the literal live install path.
    .replace('ROOT="/home/neon/marveen"', 'ROOT="$1"')
  const destructiveBlock = extractBlock(scriptText, '# >>> DESTRUCTIVE_RESET_BLOCK_START', '# <<< DESTRUCTIVE_RESET_BLOCK_END')

  it('REAL CODE: FLEET_TEST_TREE="." run from a sibling directory leaves $ROOT untouched', () => {
    const root = join(scratch, 'ROOT')
    const headBefore = makeRootRepo(root)
    writeFileSync(join(root, 'tracked.txt'), 'UNCOMMITTED EDIT\n')
    writeFileSync(join(root, 'untracked.txt'), 'untracked content\n')
    const sibling = join(scratch, 'sibling')
    mkdirSync(sibling, { recursive: true })

    // Fixed behavior: "." consistently means the CALLER's cwd (sibling) throughout, so the
    // destructive block (if it runs at all) operates on `sibling`, never on $ROOT -- the point of
    // this test is $ROOT's integrity, not a specific exit code.
    run(guardBlock, destructiveBlock, root, '.', sibling)

    expect(readFile(join(root, 'tracked.txt'), 'utf-8')).toBe('UNCOMMITTED EDIT\n')
    expect(existsSync(join(root, 'untracked.txt'))).toBe(true)
    expect(execFileSync('git', ['-C', root, 'symbolic-ref', '-q', 'HEAD'], { encoding: 'utf-8' }).trim()).toBe('refs/heads/main')
    expect(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()).toBe(headBefore)
  })

  it.each(['.', './'])('REAL CODE: FLEET_TEST_TREE=%s from a sibling directory leaves $ROOT untouched', (relValue) => {
    const root = join(scratch, 'ROOT')
    makeRootRepo(root)
    writeFileSync(join(root, 'tracked.txt'), 'UNCOMMITTED EDIT\n')
    const sibling = join(scratch, 'sibling')
    mkdirSync(sibling, { recursive: true })

    run(guardBlock, destructiveBlock, root, relValue, sibling)

    expect(readFile(join(root, 'tracked.txt'), 'utf-8')).toBe('UNCOMMITTED EDIT\n')
  })

  it('REAL CODE: FLEET_TEST_TREE=$ROOT itself (cwd == $ROOT) is still refused with die 2, exactly as before', () => {
    const root = join(scratch, 'ROOT')
    const headBefore = makeRootRepo(root)
    writeFileSync(join(root, 'tracked.txt'), 'UNCOMMITTED EDIT\n')

    const result = run(guardBlock, destructiveBlock, root, '.', root)

    expect(result.status).toBe(2)
    expect(readFile(join(root, 'tracked.txt'), 'utf-8')).toBe('UNCOMMITTED EDIT\n')
    expect(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()).toBe(headBefore)
  })

  it('MUTATION: removing the $PWD-normalization fix lets FLEET_TEST_TREE="." wipe $ROOT (proves the test catches the C1 bypass)', () => {
    const root = join(scratch, 'ROOT')
    makeRootRepo(root)
    writeFileSync(join(root, 'tracked.txt'), 'UNCOMMITTED EDIT\n')
    writeFileSync(join(root, 'untracked.txt'), 'untracked content\n')
    const sibling = join(scratch, 'sibling')
    mkdirSync(sibling, { recursive: true })

    const mutatedGuard = guardBlock.replace(
      `case "$TEST_TREE" in
  /*) : ;;
  *) TEST_TREE="$PWD/$TEST_TREE" ;;
esac`,
      '',
    )
    expect(mutatedGuard, 'the mutation did not apply').not.toBe(guardBlock)

    const result = run(mutatedGuard, destructiveBlock, root, '.', sibling)

    // Without the fix, the guard does not die (status stays 0 from the destructive block itself,
    // which is exactly the defect: the refusal silently did not fire).
    expect(result.status).toBe(0)
    expect(readFile(join(root, 'tracked.txt'), 'utf-8')).toBe('original content\n')
    expect(existsSync(join(root, 'untracked.txt'))).toBe(false)
  })

  it('REAL CODE: an absolute FLEET_TEST_TREE pointed elsewhere does not trip the $ROOT refusal (no false positive)', () => {
    const root = join(scratch, 'ROOT')
    makeRootRepo(root)
    const testTree = join(scratch, 'TEST_TREE')
    mkdirSync(testTree, { recursive: true })

    // Guard only -- the destructive block is a separate concern (already covered by the sibling
    // fleet-test-npm-ci-live-node-modules-guard.test.ts for the symlink/npm-ci branch), and running
    // it here against a non-worktree $TEST_TREE would fail for an UNRELATED reason (no real
    // worktree to check out), which would make this assertion about the wrong thing.
    const harness = `set -uo pipefail
cd ${JSON.stringify(scratch)}
FLEET_TEST_TREE=${JSON.stringify(testTree)}
die() { echo "die:$1:$2" >&2; exit "$1"; }
${guardBlock.replace('ROOT="$1"', `ROOT=${JSON.stringify(root)}`)}
`
    const result = (() => {
      try {
        execFileSync('bash', ['-c', harness], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
        return { status: 0, stderr: '' }
      } catch (e) {
        const err = e as { status: number | null; stderr: Buffer | string }
        return { status: err.status, stderr: String(err.stderr) }
      }
    })()

    // The harness ends right at the guard block's last statement (the `-ef` test itself), whose
    // own exit code is just "false" (1) here -- that is a harness artifact, not a `die`. What
    // matters is that `die` (status 2, with its stderr message) never fired.
    expect(result.status).not.toBe(2)
    expect(result.stderr).not.toContain('die:2:')
  })
})
