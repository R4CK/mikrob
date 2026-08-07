// Guard: the ip-address SSRF advisories stay closed in the lockfile (card b4c3e38d).
//
// GHSA-mwp4-54f8-5fhr (+ GHSA-4xrf-jv44-h6hh, GHSA-22jq-vg5j-6vgg): ip-address <= 10.3.0 decodes a
// leading-zero octet as DECIMAL while a resolver decodes it as OCTAL. Measured A/B on the two trees:
//
//   input        10.2.0 (vulnerable)   10.4.0 (fixed)
//   010.0.0.1    parsed -> 10.0.0.1    REJECTED
//   0177.0.0.1   REJECTED              REJECTED
//   127.0.0.1    parsed -> 127.0.0.1   parsed -> 127.0.0.1
//
// So an SSRF allowlist checking `010.0.0.1` sees "10.0.0.1", believes it is private, and lets a
// request through that the OS actually sends to 8.0.0.1. The four-digit `0177` was already rejected
// at 10.2.0 -- the two-digit `010` was the real gap.
//
// The vulnerability reaches us transitively: @anthropic-ai/claude-agent-sdk ->
// @modelcontextprotocol/sdk -> express-rate-limit -> ip-address, where it keys rate-limit buckets by
// client IP. Not our own SSRF egress path, so the practical exposure is low -- but the fix costs one
// lockfile bump and the advisory is real.
//
// This asserts the LOCKFILE, which is the artifact the fix consists of: package.json is unchanged.
// A runtime probe would instead test whatever happens to be installed in node_modules, which on a
// not-yet-`npm ci`-ed checkout is the OLD copy -- it would fail for a deploy reason rather than a
// code reason, and people would learn to ignore it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf-8')) as {
  packages: Record<string, { version?: string }>
}

/** [major, minor, patch] for a semver string, so comparisons are numeric rather than lexical. */
const parse = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10))
function atLeast(actual: string, min: string): boolean {
  const a = parse(actual)
  const m = parse(min)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (m[i] ?? 0)) return true
    if ((a[i] ?? 0) < (m[i] ?? 0)) return false
  }
  return true
}

describe('ip-address SSRF advisories stay closed (card b4c3e38d)', () => {
  it('pins ip-address at or above the fixed version', () => {
    const v = lock.packages['node_modules/ip-address']?.version
    expect(v, 'ip-address is not in the lockfile -- this assertion would be vacuous').toBeTruthy()
    // 10.4.0 is the first release carrying all three advisory fixes; <=10.3.0 is vulnerable.
    expect(atLeast(v as string, '10.4.0'), `ip-address ${v} is below the fixed 10.4.0`).toBe(true)
  })

  it('carries the transitive chain forward with it', () => {
    // The bump only holds if the packages that pull ip-address in moved too; a lockfile that
    // upgraded ip-address alone would be reverted by the next `npm install`.
    const sdk = lock.packages['node_modules/@modelcontextprotocol/sdk']?.version
    const hono = lock.packages['node_modules/@hono/node-server']?.version
    expect(sdk, 'MCP SDK missing from the lockfile').toBeTruthy()
    expect(hono, '@hono/node-server missing from the lockfile').toBeTruthy()
    expect(atLeast(sdk as string, '1.30.0')).toBe(true)
    // hono 2.x is the SDK's OWN choice: 1.30.0 declares "^1.19.9 || ^2.0.5", so the major bump is
    // sanctioned upstream rather than forced by us.
    expect(atLeast(hono as string, '2.0.5')).toBe(true)
  })

  it('needs no package.json change, so the fix cannot drift into a direct dependency', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const direct = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    expect(Object.keys(direct)).not.toContain('ip-address')
    expect(Object.keys(direct)).not.toContain('@hono/node-server')
  })
})
