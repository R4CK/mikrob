// Card 329bda2d: any test file that imports tryHandleFederation and exercises it can reach
// ensureFederationClaudeMdSection() through federation.ts's own production wiring (the mutating
// routes -- PUT/POST/PATCH/DELETE on peers/enabled/routing-mode/remove -- all call it after their
// write). That function writes the REAL repo root's CLAUDE.md (and every sub-agent's CLAUDE.md)
// unless the test isolates it, because it reads PROJECT_ROOT from the unmocked '../config.js'.
//
// THE DEFECT, measured live. credential-issuance-federation-operator.test.ts (new on card 51c68eeb,
// absent from develop) called setEnabled(false)/putDoc/DELETE through the real tryHandleFederation,
// isolating only the federation CONFIG store (_setFederationStoreDirForTest) -- not onboarding. On
// a fresh checkout the federation store starts disabled, so the call's remove branch
// (ensureBlockInFile(CLAUDE.md, null, ...)) stripped the already-committed MARVEEN-FEDERATION
// block. Three separate 51c68eeb land attempts saw this as "M CLAUDE.md" and the before/after
// dirty-tree guard (card 99a4a2d4, store-selftests-all-run.test.ts) blamed whichever unrelated
// selftest happened to be running at that instant in ANOTHER vitest worker on the SAME shared
// tree -- the guard only sees WHEN the tree changed, never WHO, so a cross-worker write is
// misattributed to a same-process bystander. federation-lifecycle.test.ts already isolates this
// correctly (card a5b71f29); this guard makes that isolation a checked invariant instead of a
// precedent the next new federation test can silently miss.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** A file is exempt only when it provably never reaches a CLAUDE.md-touching route -- not by
 *  assumption, but because its own calls are read-only or target the non-mutating /apply route
 *  (manual restart, gated+mocked, no ensureFederationClaudeMdSection call in that branch).
 *  Reason is mandatory so a future exemption cannot be added without saying why. */
const EXCLUDED: Record<string, string> = {
  'federation-apply-gate.test.ts':
    'only calls POST /api/federation/apply (manual restart gate); that branch never calls ' +
    'ensureFederationClaudeMdSection (checked: federation.ts lines 481-493)',
  'federation-directory.test.ts': 'only exercises read-only directory/catalog routes',
  'federation-inbox.test.ts': 'only exercises POST /api/federation/inbox (message receipt), not a peers/enabled/routing-mode/remove mutation',
}

const ISOLATION_RX = /vi\.mock\(\s*['"]\.\.\/web\/federation\/onboarding\.js['"]|vi\.mock\(\s*['"]\.\.\/config\.js['"]/

function importsTryHandleFederation(src: string): boolean {
  // Named-import form only (`import { tryHandleFederation, ... } from '../web/routes/federation.js'`)
  // -- a file that merely mentions the string in a comment is not a caller.
  return /import\s*\{[^}]*\btryHandleFederation\b[^}]*\}\s*from\s*['"]\.\.\/web\/routes\/federation\.js['"]/.test(src)
}

const TESTS_DIR = import.meta.dirname
const FILES = readdirSync(TESTS_DIR).filter(
  (f) => f.endsWith('.test.ts') && f !== 'federation-onboarding-isolation-guard.test.ts',
)
const IMPORTERS = FILES.filter((f) => importsTryHandleFederation(readFileSync(join(TESTS_DIR, f), 'utf-8')))

describe('every tryHandleFederation importer isolates ensureFederationClaudeMdSection (card 329bda2d)', () => {
  it('the measure is not vacuous -- importers of tryHandleFederation are found', () => {
    expect(IMPORTERS.length).toBeGreaterThanOrEqual(2)
  })

  it.each(IMPORTERS)('%s', (name) => {
    if (name in EXCLUDED) return // documented, reviewed exemption -- see EXCLUDED above
    const src = readFileSync(join(TESTS_DIR, name), 'utf-8')
    expect(
      ISOLATION_RX.test(src),
      `${name} imports tryHandleFederation but does not vi.mock('../web/federation/onboarding.js') ` +
        `or vi.mock('../config.js') -- a mutating call can write the REAL repo root's CLAUDE.md ` +
        `(card 329bda2d). Either isolate it the way federation-lifecycle.test.ts does, or add a ` +
        `documented EXCLUDED entry here proving this file never reaches a mutating route.`,
    ).toBe(true)
  })

  it('every excluded entry still exists, so a stale exemption cannot sit here unnoticed', () => {
    for (const name of Object.keys(EXCLUDED)) {
      expect(FILES.includes(name), `${name} is excluded but no longer exists`).toBe(true)
    }
  })
})
