// fleet-test.sh must kill ORPHANED vitest worker processes from a prior killed/crashed run before
// starting a new one (card fc1bb414).
//
// THE FAILURE, measured in the SAME session this card was opened in. A run killed by a
// host-level segfault (fleet-test.sh's own "INCOMPLETE RUN" branch fired) was followed minutes
// later by two DIFFERENT selftests (rea-bwrap-sandbox, then post-review) each blamed once for
// "left the shared tracked tree dirty: M CLAUDE.md" -- the same "different selftest each time,
// both green standalone" shape e5c13c0e's own REVIEW described. Neither this script's own EXIT
// trap nor a TERM/KILL/SEGV hitting the PARENT `npx vitest run` process kills its forked vitest
// workers (vitest/dist/workers/forks.js): a sibling process dying does not take its siblings down
// with it, and bash forwards no signal to a foreground pipeline's children by default. An orphan
// from a dead run can still be mid-write to a tracked file while the NEXT run's own
// store-selftests-all-run.test.ts takes its before/after snapshot, misattributing the dirt to
// whichever selftest happens to be running in ITS loop at that instant.
//
// This test runs the REAL extracted cleanup block (between the ORPHAN_CLEANUP_BLOCK_START/END
// markers in store/fleet-test.sh, not a hand-written stand-in) against REAL background processes
// with controlled `cwd`s, and asserts on their actual survival via `kill -0`.
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(PROJECT_ROOT, 'store', 'fleet-test.sh')

function extractBlock(scriptText: string, startMarker: string, endMarker: string): string {
  const startAt = scriptText.indexOf(startMarker)
  const endAt = scriptText.indexOf(endMarker)
  if (startAt < 0 || endAt < 0 || endAt < startAt) {
    throw new Error(`could not find markers ${startMarker}/${endMarker} in fleet-test.sh`)
  }
  return scriptText.slice(startAt, endAt + endMarker.length)
}

const scriptText = readFileSync(SCRIPT, 'utf-8')
const CLEANUP_BLOCK = extractBlock(scriptText, '# >>> ORPHAN_CLEANUP_BLOCK_START', '# <<< ORPHAN_CLEANUP_BLOCK_END')

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// A real process whose cmdline contains the exact worker-script path the block's
// `pgrep -f 'vitest/dist/workers/forks\.js'` matches, and whose cwd is fully controllable,
// standing in for an orphaned vitest fork worker. Deliberately NOT a bare "vitest" substring:
// measured live while building this fix, `pgrep -f 'vitest'` matched this very test harness's
// OWN wrapping shell process (whose argv happened to quote the word "vitest" in a comment/string),
// nothing to do with any real vitest process -- the narrower path match is what the real script
// now uses, and the fixture must exercise that same narrow pattern, not a looser stand-in.
function spawnFakeVitestWorker(cwd: string): ChildProcess {
  return spawn('bash', ['-c', "exec -a '/fake/vitest/dist/workers/forks.js' sleep 100"], { cwd, stdio: 'ignore' })
}

const spawned: ChildProcess[] = []
afterEach(() => {
  for (const p of spawned) {
    if (p.pid && isAlive(p.pid)) process.kill(p.pid, 'SIGKILL')
  }
  spawned.length = 0
})

function runCleanup(testTree: string): string {
  const harness = `set -uo pipefail
TEST_TREE=${JSON.stringify(testTree)}
${CLEANUP_BLOCK}
echo done
`
  return execFileSync('bash', ['-c', harness], { encoding: 'utf-8' })
}

describe('fleet-test.sh kills orphaned vitest workers from a dead prior run before starting a new one (card fc1bb414)', () => {
  it('kills a stray vitest process whose cwd is the test tree', async () => {
    const testTree = mkdtempSync(join(tmpdir(), 'orphan-cleanup-tree-'))
    try {
      const orphan = spawnFakeVitestWorker(testTree)
      spawned.push(orphan)
      await new Promise((r) => setTimeout(r, 300)) // let bash exec and cwd settle
      expect(orphan.pid, 'orphan did not start').toBeTruthy()
      expect(isAlive(orphan.pid!), 'orphan should be alive before cleanup runs').toBe(true)

      runCleanup(testTree)
      await new Promise((r) => setTimeout(r, 300)) // SIGKILL delivery

      expect(isAlive(orphan.pid!), 'the orphaned worker should have been killed').toBe(false)
    } finally {
      rmSync(testTree, { recursive: true, force: true })
    }
  })

  it('does NOT kill a vitest-named process whose cwd is a DIFFERENT directory (scoped by cwd, not name)', async () => {
    const testTree = mkdtempSync(join(tmpdir(), 'orphan-cleanup-tree-'))
    const unrelated = mkdtempSync(join(tmpdir(), 'orphan-cleanup-unrelated-'))
    try {
      const bystander = spawnFakeVitestWorker(unrelated)
      spawned.push(bystander)
      await new Promise((r) => setTimeout(r, 300))
      expect(bystander.pid, 'bystander did not start').toBeTruthy()

      runCleanup(testTree)
      await new Promise((r) => setTimeout(r, 300))

      expect(isAlive(bystander.pid!), 'a vitest process in an unrelated directory must survive').toBe(true)
    } finally {
      rmSync(testTree, { recursive: true, force: true })
      rmSync(unrelated, { recursive: true, force: true })
    }
  })

  it('MUTATION-PROOF (static): dropping the cwd check would kill everything pgrep finds, not just orphans', () => {
    // Pins the SPECIFIC thing that must not regress: matching is by cwd, not by name/cmdline
    // substring alone (the fleet's own "pkill -f must scope to the worktree path" lesson).
    // Deliberately NOT executed system-wide (unlike the other tests here): the mutated form kills
    // EVERY process anywhere on the host whose cmdline matches 'vitest/dist/workers/forks.js' --
    // including the real vitest worker running this very test, measured by hand while building
    // this fix (the worker running this test file was SIGKILLed mid-run). A static check on the
    // guard's text is what proves the property without re-detonating that exact mistake.
    const guardedKill = /if \[ -n "\$_orphan_cwd" \] && \[ "\$_orphan_cwd" = "\$TEST_TREE" \]; then\n\s*echo[^\n]*\n\s*kill -9 "\$_orphan_pid"/
    expect(CLEANUP_BLOCK).toMatch(guardedKill)

    const mutated = CLEANUP_BLOCK.replace(
      /if \[ -n "\$_orphan_cwd" \] && \[ "\$_orphan_cwd" = "\$TEST_TREE" \]; then/,
      'if true; then',
    )
    expect(mutated, 'the mutation did not apply').not.toBe(CLEANUP_BLOCK)
    expect(mutated).not.toMatch(guardedKill)
  })

  it('runs after the exclusive tree lock is acquired, before the destructive reset block', () => {
    const lockAcquired = scriptText.indexOf('TREE_LOCK_ACQUIRED_AT=')
    const cleanupStart = scriptText.indexOf('>>> ORPHAN_CLEANUP_BLOCK_START')
    const resetStart = scriptText.indexOf('>>> DESTRUCTIVE_RESET_BLOCK_START')
    expect(lockAcquired).toBeGreaterThan(-1)
    expect(cleanupStart).toBeGreaterThan(lockAcquired)
    expect(resetStart).toBeGreaterThan(cleanupStart)
  })
})
