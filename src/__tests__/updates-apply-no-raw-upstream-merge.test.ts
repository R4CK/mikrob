// Card 55885cb1 (Cybered finding on ef6a8031, comment 11275, point B): the dashboard's
// POST /api/updates/apply used to accept {"repo":"upstream"} and respond by fetching the raw
// `upstream` git remote and merging `upstream/main` directly onto HEAD, then immediately handing
// off to update.sh -- completely bypassing the gated, batched upstream-sync process (e5c46e87)
// that reviews every upstream commit through QA+Cybersec+Cybered before it reaches this fork's
// own `origin`. Peti's decision (comment 11279): the endpoint may never again touch the raw
// `upstream` remote; every accepted `repo` value must run the SAME fork-pull path.
//
// This pins the ABSENCE the same way update-unit-maintenance-order.test.ts pins the absence of
// the not-adopted keepalive/morning-park functions: a static source-level assertion so a future
// edit that reintroduces a direct `git merge ... upstream/main` call in this file's apply handler
// fails loudly, rather than a runtime test that could pass by accident if nothing happens to call
// the dangerous code path in that particular test run.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const ROUTE_SRC = readFileSync(join(ROOT, 'src', 'web', 'routes', 'updates.ts'), 'utf-8')

describe('POST /api/updates/apply never merges the raw upstream remote', () => {
  it('the route source contains no git-merge-upstream/main construction', () => {
    // Covers both an exec-args array (['merge', 'upstream/main', ...]) and a shelled-out string
    // form, in case a future edit changes HOW the call is made without changing THAT it is made.
    expect(ROUTE_SRC).not.toMatch(/merge['"]?\s*,\s*['"]upstream\/main['"]/)
    expect(ROUTE_SRC).not.toMatch(/git merge upstream\/main/)
  })

  it('the route source never fetches the raw upstream remote', () => {
    // 'fetch', 'upstream' as an exec-args pair, or the shelled-out form -- the fork-pull path only
    // ever talks to 'origin'; 'upstream' as a remote name has no legitimate reason to appear here.
    expect(ROUTE_SRC).not.toMatch(/fetch['"]?\s*,\s*['"]upstream['"]/)
    expect(ROUTE_SRC).not.toMatch(/git fetch upstream\b/)
  })

  it('repo is accepted but no longer selects a different code path', () => {
    // The old shape branched control flow on the parsed repo value ("if (repo === 'upstream')").
    // After the fix there is exactly one call to spawnUpdateScript in the apply handler, and no
    // conditional branch keyed on a parsed repo value feeds into a DIFFERENT action.
    const applyHandlerStart = ROUTE_SRC.indexOf("path === '/api/updates/apply'")
    expect(applyHandlerStart).toBeGreaterThan(-1)
    const handlerBody = ROUTE_SRC.slice(applyHandlerStart, ROUTE_SRC.indexOf('\n  return false', applyHandlerStart))
    const spawnCalls = handlerBody.match(/spawnUpdateScript\(/g) ?? []
    expect(spawnCalls.length).toBe(1)
    expect(handlerBody).not.toMatch(/if\s*\(\s*repo\s*===\s*['"]upstream['"]\s*\)/)
  })
})
