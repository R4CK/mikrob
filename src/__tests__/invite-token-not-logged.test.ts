// Card 961843fb: the invite auto-approval line logged the invite TOKEN itself.
//
// `logger.info({ ..., token: tToken }, 'Channel invite auto-approved')` put a live invite
// credential into the journal, which is readable by anyone who can read the service log. It is only
// LOW because the token is single-use -- `usedAt` is set just above -- but "already spent" is a
// property of the flow, not of the logging, and flows change. It is the same class as the startup
// token closed on card 62631948.
//
// Two layers, because the unit test alone would not stop the next one: the behaviour of the
// replacement, and a CORPUS rule over src/ so no other logger call starts passing a raw token.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inviteLogRef } from '../web/channel-invites.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('the log reference identifies an invite without revealing it', () => {
  const token = 'k3Jq9vB2xLm7Pq4Rt6Yw1z'

  it('is short, hex, and stable for the same token', () => {
    expect(inviteLogRef(token)).toMatch(/^[0-9a-f]{8}$/)
    expect(inviteLogRef(token)).toBe(inviteLogRef(token))
  })

  it('does not contain the token, or any part of it long enough to matter', () => {
    const ref = inviteLogRef(token)
    expect(ref).not.toContain(token)
    for (let i = 0; i + 4 <= token.length; i++) {
      expect(ref, `the reference leaked the substring "${token.slice(i, i + 4)}"`).not.toContain(token.slice(i, i + 4))
    }
  })

  it('separates different invites (so it is still useful in a log)', () => {
    expect(inviteLogRef('aaaaaaaaaaaaaaaaaaaaaa')).not.toBe(inviteLogRef('bbbbbbbbbbbbbbbbbbbbbb'))
  })
})

/** Every .ts under src/, minus tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      out.push(...sourceFiles(full))
    } else if (entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

/**
 * A `token:` (or secret/password/apiKey) property whose value is a plain identifier, inside a
 * logger call's first argument. `mode: token ? 'oauth' : 'apikey'` is NOT matched -- that logs a
 * derived label, not the value -- and neither is `invite: inviteLogRef(tToken)`, because the value
 * is a call, not a bare name.
 */
const LOGGED_SECRET_RX =
  /logger\.(?:info|warn|error|debug|trace|fatal)\(\s*\{[^}]*?\b(?:token|secret|password|apiKey|api_key|accessToken|refreshToken)\s*:\s*[A-Za-z_$][\w$.]*\s*[,}]/

describe('no logger call passes a raw credential', () => {
  const files = sourceFiles(SRC)

  it('scans a plausible number of source files (a broken walk would pass vacuously)', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('finds no raw credential property in any logger object', () => {
    const offenders = files
      .filter((f) => LOGGED_SECRET_RX.test(readFileSync(f, 'utf-8')))
      .map((f) => relative(SRC, f))
    expect(
      offenders,
      `these files log a credential value:\n${offenders.join('\n')}\n` +
        `The journal keeps it for as long as the log is retained. Log a non-reversible reference ` +
        `instead (see inviteLogRef in web/channel-invites.ts), or drop the field -- an id is usually ` +
        `enough for audit correlation.`,
    ).toEqual([])
  })

  it('the rule is not vacuous: it flags the shape that shipped', () => {
    const shipped = `logger.info({ name, provider, senderId: pEntry.senderId, token: tToken }, 'Channel invite auto-approved')`
    expect(LOGGED_SECRET_RX.test(shipped)).toBe(true)
  })

  it('the rule does NOT flag a derived label or a hashed reference', () => {
    expect(LOGGED_SECRET_RX.test(`logger.info({ mode: token ? 'oauth' : 'apikey' }, 'stored')`)).toBe(false)
    expect(LOGGED_SECRET_RX.test(`logger.info({ invite: inviteLogRef(tToken) }, 'approved')`)).toBe(false)
  })
})
