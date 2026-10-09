import { describe, it, expect, beforeAll } from 'vitest'
import { createRequire } from 'node:module'
import { configDefaults } from 'vitest/config'

// picomatch is what vite/vitest match globs with, so it is the faithful matcher
// here -- but it ships no type declarations, and a plain `import` fails tsc with
// TS7016. Pulled in through createRequire so the build stays clean without adding
// a @types dependency for one test.
const picomatch = createRequire(import.meta.url)('picomatch') as (glob: string) => (p: string) => boolean

// `npm run build` compiles every src/__tests__/*.test.ts into dist/__tests__/*.test.js.
// If the suite collects those copies too, every test runs twice and the compiled
// halves are unloadable -- measured 2026-09-16: 888 files / 10723 tests instead of
// 444 / 5633, 67 files RED with not one real failure among them.
//
// These assertions read the REAL config object, then apply the same glob matching
// the runner does. Asserting that the string 'dist/**' appears in a list would only
// restate the config; what matters is whether the patterns actually match the path.

// The config is loaded through a COMPUTED specifier on purpose. A static
// `import '../../vitest.config.js'` type-checks fine but breaks `npm run build`:
// tsc has rootDir=src, and the config sits above it (TS6059). That failure only
// showed up because this change was measured end-to-end -- a broken build would
// otherwise have surfaced during the upgrade, which is the worst moment for it.
let exclude: string[] = []

beforeAll(async () => {
  const mod = (await import(new URL('../../vitest.config.ts', import.meta.url).href)) as {
    default?: { test?: { exclude?: string[] } }
  }
  exclude = mod.default?.test?.exclude ?? []
})

function excluded(path: string): boolean {
  return exclude.some((p) => picomatch(p)(path))
}

describe('the suite does not collect its own build output', () => {
  it('the config carries a non-empty exclude list at all', () => {
    // Positive control for the helper: if `config.test.exclude` were undefined or
    // read from the wrong key, every assertion below would pass vacuously.
    expect(exclude.length).toBeGreaterThan(0)
  })

  it('excludes a compiled test copy under dist/', () => {
    expect(excluded('dist/__tests__/memory-embedding-staleness.test.js')).toBe(true)
  })

  it('excludes nested build output too, not just the one directory', () => {
    expect(excluded('dist/web/routes/__tests__/kanban.test.js')).toBe(true)
  })

  it('still collects the real sources -- the exclusion is not too wide', () => {
    // The other direction. A pattern like '**/*.js' or 'src/**' would make the
    // assertion above pass while quietly emptying the suite.
    expect(excluded('src/__tests__/memory-embedding-staleness.test.ts')).toBe(false)
    expect(excluded('src/db.ts')).toBe(false)
  })

  it('keeps the exclusions that were already there', () => {
    expect(excluded('tests/smoke/login.spec.ts')).toBe(true)
    expect(excluded('tests/browser/front.spec.ts')).toBe(true)
    expect(excluded('vendor/gmail/test/send.test.js')).toBe(true)
    expect(excluded('node_modules/vitest/dist/x.test.js')).toBe(true)
  })

  it("vitest's own defaults no longer cover dist on this fork's installed version (vitest ^5.0.3)", () => {
    // UPSTREAM-SYNC BATCH 4 (card 0b550d89) flipped this to `true` when the fork pinned vitest
    // ^2.1.0, whose configDefaults.exclude still included '**/dist/**'. Card 2f05b3e3 (the
    // vitest major bump) is exactly the "revisit (flip back)" trigger that comment named: on
    // vitest ^5.0.3, configDefaults.exclude no longer covers dist/** (matching the vitest-4
    // premise the original, pre-0b550d89 version of this assertion encoded). The config's own
    // explicit 'dist/**' entry (never removed) is now load-bearing again, not a redundant
    // belt-and-suspenders -- this flip is exactly why removing it would have been premature.
    const byDefaultsOnly = configDefaults.exclude.some((p) => picomatch(p)('dist/__tests__/a.test.js'))
    expect(byDefaultsOnly).toBe(false)
  })
})
