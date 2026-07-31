// The dashboard port is interpolated into an allowlist PREFIX (`http://localhost:${PORT}/`), so an
// unvalidated value is an egress-gate bypass, not a cosmetic bug: `WEB_PORT=3420@evil.com` makes
// `localhost:3420` a URL userinfo section and evil.com the resolved HOST -- putting an
// attacker-chosen origin on the built-in allowlist (Cybersec MEDIUM, card 266d8248).
//
// Source-level: the resolver runs at module load from env/.env, so the realistic regression is
// someone dropping the validation, not a runtime fault. The URL-semantics assertions below prove the
// attack is real rather than theoretical.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

const GATE = readFileSync(join(REPO_ROOT, 'scripts/hooks/egress-gate.mjs'), 'utf8')

/** The port-resolver block: from the DASHBOARD_PORT declaration to the allowlist that CONSUMES it.
 *  (`ALLOWED_PREFIXES` also appears earlier in the file, so the end index must be searched FROM the
 *  declaration -- a plain indexOf yields an empty slice and vacuously-passing assertions.) */
function resolverBlock(): string {
  const start = GATE.indexOf('const DASHBOARD_PORT')
  const end = GATE.indexOf('ALLOWED_PREFIXES', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return GATE.slice(start, end)
}

describe('egress-gate dashboard-port validation (card 266d8248)', () => {
  it('the attack is real: an @ in the port turns the prefix host into the attacker host', () => {
    // Documents WHY the validation exists -- this is standard URL userinfo parsing.
    expect(new URL('http://localhost:3420@evil.com/').hostname).toBe('evil.com')
    expect(new URL('http://localhost:3420/').hostname).toBe('localhost')
  })

  it('the resolver validates the port as digits only', () => {
    expect(GATE).toMatch(/\/\^\\d\{1,5\}\$\//)
  })

  it('BOTH sources are validated -- env and .env (either one alone would leave a hole)', () => {
    const resolver = resolverBlock()
    const checks = resolver.match(/isValidPort\(/g) ?? []
    expect(checks.length).toBeGreaterThanOrEqual(2)
  })

  it('falls back to the default port instead of trusting a rejected value', () => {
    const resolver = resolverBlock()
    expect(resolver).toContain("return '3420'")
  })

  it('regression: a raw unvalidated env read must not reach the prefix', () => {
    // The pre-fix shape was `if (process.env['WEB_PORT']) return process.env['WEB_PORT']`.
    expect(GATE).not.toMatch(/if \(process\.env\['WEB_PORT'\]\) return process\.env\['WEB_PORT'\]/)
  })
})
