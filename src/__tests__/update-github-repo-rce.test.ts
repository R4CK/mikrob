import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Card 3f576e55 -- Cybersec NO-GO cm#6148: the dashboard Update button ran `npm install --production`
// straight after `git pull --ff-only`, and npm executes the pulled package's own
// preinstall/install/postinstall lifecycle scripts. One click therefore ran ARBITRARY CODE from a
// fresh third-party commit.
//
// These are SOURCE-LEVEL assertions on purpose. The realistic regression is someone re-adding the
// install step for convenience ("the repo needs its deps"), and a behavioural test would need a real
// repo + a real npm to catch that. Asserting on the update function's own source catches the
// re-introduction directly and cannot be satisfied by a mock.

const SRC = readFileSync(
  join(process.cwd(), 'src', 'web', 'dashboard-settings.ts'),
  'utf8',
)

/** Strip comments so assertions are about EXECUTED CODE, not prose. Without this, the in-code note
 *  "NO npm install here" would itself trip the npm-install assertion -- caught while writing these. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** The EXECUTABLE body of updateGitHubRepo, comments removed. */
function updateFnSource(): string {
  const start = SRC.indexOf('export function updateGitHubRepo')
  expect(start, 'updateGitHubRepo must exist').toBeGreaterThan(-1)
  // The next `export ` at column 0 after it delimits the function.
  const rest = SRC.slice(start + 10)
  const end = rest.indexOf('\nexport ')
  return stripComments(end > -1 ? rest.slice(0, end) : rest)
}

describe('updateGitHubRepo -- one-click RCE closed (card 3f576e55)', () => {
  it('does NOT run npm install (or any package-manager install) on the update path', () => {
    const fn = updateFnSource()
    expect(fn).not.toMatch(/npm\s+install/)
    expect(fn).not.toMatch(/npm\s+ci/)
    expect(fn).not.toMatch(/pnpm\s+install/)
    expect(fn).not.toMatch(/yarn\s+install/)
  })

  it('runs NO lifecycle-capable child process at all beyond the git pull itself', () => {
    const fn = updateFnSource()
    const execCalls = fn.match(/exec(?:Sync|File|FileSync)?\(/g) ?? []
    // Exactly one child process: the pull.
    expect(execCalls).toHaveLength(1)
    expect(fn).toMatch(/git pull --ff-only/)
  })

  it('still performs the pull -- the fix removed the install, it did not disable updating', () => {
    expect(updateFnSource()).toMatch(/git pull --ff-only/)
  })

  it('reports depsChanged instead of silently installing, so the UI can surface it', () => {
    const fn = updateFnSource()
    expect(fn).toMatch(/depsChanged/)
  })

  it('honours the watcher review-before-update flag (no blind update of executable adoptions)', () => {
    const fn = updateFnSource()
    expect(fn).toMatch(/requiresReviewBeforeUpdate/)
    expect(fn).toMatch(/reviewRequired/)
  })

  it('the review check reads the SAME registry the watcher uses (one source of truth)', () => {
    expect(SRC).toMatch(/watched-repos\.json/)
    // and it keys the verdict off type=code, matching git-repo-watcher.sh's own classification
    expect(SRC).toMatch(/'code'/)
  })

  it('carries a comment explaining WHY the install is gone (so it is not "cleaned up" back in)', () => {
    expect(SRC).toMatch(/3f576e55/)
    expect(SRC).toMatch(/lifecycle/i)
  })
})
