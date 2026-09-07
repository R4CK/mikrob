import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// AUTOUPDNODEENV905 source guard. With NODE_ENV=production in the caller's
// environment `npm ci` defaults to omit=dev, which prunes the TypeScript
// compiler; the update build then fails, rolls back (reverting the freshly
// pulled update.sh too), and the install repeats the same failure on every
// run while the customer sees green (the old dist keeps serving). Measured
// live on 2026-09-05: five rollbacks over ten days on a customer install.
//
// The defense is two-layered and BOTH layers are load-bearing:
//   1. every `npm ci` inside update.sh carries --include=dev (final, but only
//      effective once the fixed script has arrived);
//   2. the dashboard spawn path deletes NODE_ENV from the child env, because
//      installs still running an OLD update.sh can only be healed by the
//      environment they are launched with.

const ROOT = join(__dirname, '..', '..')

describe('update path survives NODE_ENV=production (AUTOUPDNODEENV905)', () => {
  it('every npm ci in update.sh carries --include=dev', () => {
    const script = readFileSync(join(ROOT, 'update.sh'), 'utf-8')
    const ciLines = script.split('\n').filter((l) => /\bnpm ci\b/.test(l) && !l.trim().startsWith('#'))
    expect(ciLines.length).toBeGreaterThan(0)
    for (const line of ciLines) {
      // Error-message hints ("futtasd: npm ci") are prose, not invocations.
      if (/echo/.test(line)) continue
      expect(line, `npm ci without --include=dev: ${line.trim()}`).toContain('--include=dev')
    }
  })

  it('the dashboard update spawn deletes NODE_ENV from the child environment', () => {
    const route = readFileSync(join(ROOT, 'src', 'web', 'routes', 'updates.ts'), 'utf-8')
    const spawnIdx = route.indexOf("spawn('/bin/bash'")
    expect(spawnIdx).toBeGreaterThan(-1)
    // AUTOUPDNODEENV905 half 2/2 (card c116696f): the deletion lives in the dedicated
    // buildUpdateScriptEnv(extraEnv) helper (Cybersec NO-GO on an earlier version that
    // mutated process.env directly -- this one builds a local copy instead), not inlined
    // right before the spawn call. Pin both ends: the spawn passes the helper's result as
    // `env`, and the helper itself deletes NODE_ENV from its own local copy.
    const spawnCall = route.slice(spawnIdx, spawnIdx + 400)
    expect(spawnCall).toContain('env: buildUpdateScriptEnv(')
    const helperIdx = route.indexOf('function buildUpdateScriptEnv(')
    expect(helperIdx).toBeGreaterThan(-1)
    const helperBody = route.slice(helperIdx, helperIdx + 300)
    expect(helperBody).toContain('delete env.NODE_ENV')
  })
})
