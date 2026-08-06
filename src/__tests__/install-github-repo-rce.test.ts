import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Card f1806370 -- Cybersec re-verify cm#6159 on the 3f576e55 fix: the dashboard's Add-repo form
// (installGitHubRepo) ran `npm install --production` on a just-cloned tree whenever it had a
// package.json. npm executes the package's own preinstall/install/postinstall lifecycle scripts, so
// pasting ANY GitHub URL into the box and clicking once ran arbitrary code from that repo -- broader
// than the update-path RCE this mirrors, because the URL is attacker-supplied at request time rather
// than limited to an already-adopted repo, and there is no review-before-update registry to consult
// since nothing has been adopted yet at this point.
//
// These are SOURCE-LEVEL assertions on purpose, same rationale as update-github-repo-rce.test.ts: the
// realistic regression is someone re-adding the install step for convenience, and a behavioural test
// would need a real repo + a real npm to catch that. Asserting on the install function's own source
// catches the re-introduction directly and cannot be satisfied by a mock.

const SRC = readFileSync(
  join(process.cwd(), 'src', 'web', 'dashboard-settings.ts'),
  'utf8',
)

/** Strip comments so assertions are about EXECUTED CODE, not prose. Without this, the in-code note
 *  "NO npm install here" would itself trip the npm-install assertion. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** The EXECUTABLE body of installGitHubRepo, comments removed. */
function installFnSource(): string {
  const start = SRC.indexOf('export async function installGitHubRepo')
  expect(start, 'installGitHubRepo must exist').toBeGreaterThan(-1)
  // The next `export ` at column 0 after it delimits the function.
  const rest = SRC.slice(start + 10)
  const end = rest.indexOf('\nexport ')
  return stripComments(end > -1 ? rest.slice(0, end) : rest)
}

describe('installGitHubRepo -- mirror one-click RCE closed (card f1806370)', () => {
  it('does NOT run npm install (or any package-manager install) on the add-repo path', () => {
    const fn = installFnSource()
    expect(fn).not.toMatch(/npm\s+install/)
    expect(fn).not.toMatch(/npm\s+ci/)
    expect(fn).not.toMatch(/pnpm\s+install/)
    expect(fn).not.toMatch(/yarn\s+install/)
  })

  it('runs NO lifecycle-capable child process at all beyond the git clone itself', () => {
    const fn = installFnSource()
    const execCalls = fn.match(/exec(?:Sync|File|FileSync)?\(/g) ?? []
    // Exactly one child process: the clone.
    expect(execCalls).toHaveLength(1)
    expect(fn).toMatch(/git clone/)
  })

  it('still performs the clone -- the fix removed the install, it did not disable adoption', () => {
    expect(installFnSource()).toMatch(/git clone/)
  })

  it('reports depsChanged instead of silently installing, so the UI can surface it', () => {
    const fn = installFnSource()
    expect(fn).toMatch(/depsChanged/)
  })

  it('still detects required env vars for the adopted repo (unrelated to the install fix)', () => {
    const fn = installFnSource()
    expect(fn).toMatch(/detectRequiredEnvVars/)
  })

  it('carries a comment explaining WHY the install is gone (so it is not "cleaned up" back in)', () => {
    expect(SRC).toMatch(/f1806370/)
    expect(SRC).toMatch(/lifecycle/i)
  })
})
