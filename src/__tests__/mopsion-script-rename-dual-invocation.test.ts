// Card 647ea02a (rebrand step 2): cleancore-*.sh + cc-gate-worktree*.sh were renamed to
// mopsion-*.sh, with a symlink kept at the OLD name so a dispatch message, a cached agent
// prompt, or another script still calling the old path keeps working. "The symlink exists"
// is NOT proof of that -- a symlink can point at a moved/deleted/renamed-wrong target and
// still pass an existence check. This asserts the STRONGER claim the card asks for: BOTH the
// old name and the new name can actually be STARTED and RUN, and produce the SAME result
// (because they resolve to the exact same file).
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const STORE_DIR = join(ROOT, 'store')

interface Case {
  readonly oldName: string
  readonly newName: string
  /** Args that make the script do REAL work deterministically without side effects (a
   *  built-in --selftest/--status mode, or a deliberately-incomplete invocation that hits
   *  the script's own usage/validation path) -- never a flag that would touch the shared
   *  CPU semaphore, land a branch, or write fleet state. */
  readonly args: readonly string[]
  /** Substring that must appear in the combined stdout+stderr, proving the invocation
   *  reached real logic (not "command not found" / "permission denied" / a bare crash). */
   readonly expectSubstring: string
  readonly expectStatus: number
}

const CASES: readonly Case[] = [
  {
    oldName: 'cleancore-branch-drift-monitor.sh',
    newName: 'mopsion-branch-drift-monitor.sh',
    args: ['--status'],
    expectSubstring: '{',
    expectStatus: 0,
  },
  {
    oldName: 'cleancore-main-suite-guard.sh',
    newName: 'mopsion-main-suite-guard.sh',
    args: ['--status'],
    expectSubstring: '{',
    expectStatus: 0,
  },
  {
    // bundle-check.sh itself is a pure function-library meant to be SOURCED (no direct-run
    // output to assert on) -- its own .selftest.sh sibling is the real "does this work"
    // entry point, so that is what proves both names actually run the logic.
    oldName: 'cleancore-bundle-check.selftest.sh',
    newName: 'mopsion-bundle-check.selftest.sh',
    args: [],
    expectSubstring: 'selftest:',
    expectStatus: 0,
  },
  {
    oldName: 'cleancore-land.sh',
    newName: 'mopsion-land.sh',
    args: ['--selftest'],
    expectSubstring: 'selftest:',
    expectStatus: 0,
  },
  {
    oldName: 'cleancore-pregate.sh',
    newName: 'mopsion-pregate.sh',
    args: ['--selftest'],
    expectSubstring: 'selftest:',
    expectStatus: 0,
  },
  {
    oldName: 'cleancore-tsc-lib.sh',
    newName: 'mopsion-tsc-lib.sh',
    args: ['--selftest'],
    expectSubstring: 'mopsion-tsc-lib selftest:',
    expectStatus: 0,
  },
  {
    oldName: 'cleancore-seam-sweep.sh',
    newName: 'mopsion-seam-sweep.sh',
    args: [],
    expectSubstring: 'usage: mopsion-seam-sweep.sh',
    expectStatus: 2,
  },
  {
    oldName: 'cc-gate-worktree.sh',
    newName: 'mopsion-gate-worktree.sh',
    args: [],
    expectSubstring: 'mopsion-gate-worktree.sh:',
    expectStatus: 2,
  },
  {
    oldName: 'cleancore-suite-run.sh',
    newName: 'mopsion-suite-run.sh',
    args: [],
    expectSubstring: 'usage: mopsion-suite-run.sh',
    expectStatus: 2,
  },
]

function run(scriptPath: string, args: readonly string[]) {
  const r = spawnSync('bash', [scriptPath, ...args], { encoding: 'utf-8', timeout: 30_000 })
  return { status: r.status, output: `${r.stdout}${r.stderr}` }
}

describe.each(CASES)('$oldName -> $newName', ({ oldName, newName, args, expectSubstring, expectStatus }) => {
  const oldPath = join(STORE_DIR, oldName)
  const newPath = join(STORE_DIR, newName)

  it('the old name is a SYMLINK (not a copy) pointing at the new file', () => {
    const st = lstatSync(oldPath)
    expect(st.isSymbolicLink(), `${oldName} must be a symlink, not a real file`).toBe(true)
    expect(realpathSync(oldPath)).toBe(realpathSync(newPath))
  })

  it('the OLD name actually starts and runs (not just "the symlink exists")', () => {
    const { status, output } = run(oldPath, args)
    expect(status, output).toBe(expectStatus)
    expect(output).toContain(expectSubstring)
  })

  it('the NEW name actually starts and runs, identically', () => {
    const { status, output } = run(newPath, args)
    expect(status, output).toBe(expectStatus)
    expect(output).toContain(expectSubstring)
  })

  it('old-name and new-name invocations produce the IDENTICAL result (same file via symlink)', () => {
    const viaOld = run(oldPath, args)
    const viaNew = run(newPath, args)
    expect(viaOld.status).toBe(viaNew.status)
    expect(viaOld.output).toBe(viaNew.output)
  })
})

// Negative control (rule 12 / karpathycoder discipline): if the symlink or the rename were
// silently broken, EVERY case above could still pass for the wrong reason if the test itself
// were vacuous (e.g. spawnSync swallowing an error into status=null and an empty string
// happening to satisfy a loose assertion). Prove the harness actually distinguishes
// success from failure by running a path that does NOT exist and confirming it does NOT
// silently report status 0.
describe('dual-invocation harness sanity (negative control)', () => {
  it('a nonexistent script path is NOT reported as a clean exit -- the harness can fail', () => {
    const { status } = run(join(STORE_DIR, 'mopsion-does-not-exist.sh'), [])
    expect(status).not.toBe(0)
  })
})
