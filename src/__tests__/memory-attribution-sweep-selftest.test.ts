// store/memory-attribution-sweep.selftest.py exists but nothing ran it in CI -- same gap
// graph-tooling-selftests.test.ts and lockfile-sync-check-selftest.test.ts already document: a
// selftest that only runs when someone types its name is documentation, not a gate (card 0c335d59).
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'store', 'memory-attribution-sweep.py')
const SELFTEST = join(REPO_ROOT, 'store', 'memory-attribution-sweep.selftest.py')

describe('memory-attribution-sweep.py selftest', () => {
  it('both files exist', () => {
    expect(existsSync(SCRIPT)).toBe(true)
    expect(existsSync(SELFTEST)).toBe(true)
  })

  it('its selftest runs entirely against throwaway tmp directories, never the real pool', () => {
    // The load-bearing safety property for a script wired into a scheduled-task that runs
    // repeatedly (card 0c335d59): the selftest must never touch the real shared memory pool.
    const src = execFileSync('cat', [SELFTEST], { encoding: 'utf-8' })
    expect(src).toContain('tempfile.mkdtemp')
    // The real pool path is only mentioned in the file's own doc-comment (explaining what it must
    // NOT touch) -- never called. default_pool_dir()/default_projects_root() would be the call.
    expect(src).not.toContain('default_pool_dir()')
    expect(src).not.toContain('default_projects_root()')
  })

  it('its selftest passes, in the shape store-selftests-all-run.test.ts recognises (card 711a7e57/2003e04b)', () => {
    const out = execFileSync('python3', [SELFTEST], { encoding: 'utf-8' })
    expect(out).toMatch(/selftest: [1-9]\d* case\(s\), PASS/)
  })

  it('runs at least 15 checks -- deleting cases is a failure, not a cleanup', () => {
    const out = execFileSync('python3', [SELFTEST], { encoding: 'utf-8' })
    const okCount = (out.match(/^ {2}ok {3}/gm) ?? []).length
    expect(okCount).toBeGreaterThanOrEqual(15)
  })

  // The properties that make it SAFE to schedule repeatedly against a live, concurrently-written
  // pool (card 0c335d59, msg_id:25228): it never guesses (only writes what a transcript directory
  // proves) and it never re-writes a file it already labelled.
  it('never resolves a sessionId to more than one project-key directory', () => {
    const src = execFileSync('cat', [SCRIPT], { encoding: 'utf-8' })
    expect(src).toContain('if len(matches) != 1:')
    expect(src).toContain('return None')
  })

  it('skips any file that already carries an agent field, unconditionally', () => {
    const src = execFileSync('cat', [SCRIPT], { encoding: 'utf-8' })
    const fn = src.slice(src.indexOf('def sweep('))
    expect(fn).toContain('if already_has_agent(fm):')
  })

  it('never touches MEMORY.md as an attributable file (index-of-indexes, no content of its own)', () => {
    const src = execFileSync('cat', [SCRIPT], { encoding: 'utf-8' })
    expect(src).toContain("f != 'MEMORY.md'")
  })
})
