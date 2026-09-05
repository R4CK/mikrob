// Guard: the fast-uri and qs advisories stay closed in the lockfile (card 74851e8b).
//
// THE DEFECT THIS CARD ACTUALLY FOUND was not a missing override. package.json already carried
// `"fast-uri": ">=3.1.4 <4"` -- and the tree still installed 3.1.5, which npm audit flagged HIGH.
// The advisory range is 3.0.0 - 3.1.5, so a floor of 3.1.4 sits INSIDE it: the override was
// satisfied by two vulnerable versions and read, to anyone scanning package.json, like a closed
// issue. An override floor below the advisory ceiling is a no-op wearing the costume of a fix, and
// nothing was checking the relationship between the two numbers. That is the general failure this
// file pins, not just today's two package names.
//
//   fast-uri  3.0.0 - 3.1.5   HIGH       host confusion / SSRF via IDN, IPv6, percent-decoding
//                                        (GHSA-5jgf-p345-68v8, -f65p-4m7j-42xc, -fph4-wmhf-6fwf,
//                                         -jqff-g426-hqxp). First fixed: 3.1.6.
//   qs        2.2.5 - 6.15.3  MODERATE   array-limit bypass via bracket-key comma parsing, and DoS
//                                        via attacker-controlled isBuffer (GHSA-x5fp-wj9c-mxmx,
//                                        GHSA-4mjr-xmp4-gh2g). First fixed: 6.16.0.
//
// Both reach us transitively through @anthropic-ai/claude-agent-sdk -> @modelcontextprotocol/sdk:
// fast-uri under ajv (URI resolution for $id/$ref), qs under express/body-parser. Neither is called
// by our own routes, so practical exposure is low -- but they run inside a live process.
//
// WHY THE CEILING STAYS AT <4. ajv@8.20.0 declares `"fast-uri": "^3.0.1"`. 3.1.6 carries the fixes
// INSIDE that range, so the fix needs no semver violation and no major bump under a dependency we
// do not control. Overriding to 4.x would have forced ajv onto a major it never declared support
// for, for no additional security. Same for qs: body-parser wants ^6.15.2 and express ^6.14.0, and
// 6.16.0 satisfies both.
//
// Asserted against the LOCKFILE, following ip-address-ssrf-advisory.test.ts and for its reason: a
// runtime probe would measure whatever sits in node_modules, which on a checkout that has not been
// installed yet is the OLD copy -- failing for a deploy reason rather than a code reason is how a
// guard teaches people to ignore it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf-8')) as {
  packages: Record<string, { version?: string }>
}
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')) as {
  overrides?: Record<string, string>
  pnpm?: { overrides?: Record<string, string> }
}

/** [major, minor, patch] so comparisons are numeric, not lexical ('3.1.10' < '3.1.9' as strings). */
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

/** The `>=X <Y` floor of an override string, or null when it has no floor to read. */
function floorOf(range: string | undefined): string | null {
  const m = /(?:^|\s)>=\s*(\d+\.\d+\.\d+)/.exec(range ?? '')
  return m ? m[1] : null
}

const ADVISORIES = [
  { name: 'fast-uri', firstFixed: '3.1.6', vulnerableCeiling: '3.1.5' },
  { name: 'qs', firstFixed: '6.16.0', vulnerableCeiling: '6.15.3' },
] as const

describe('fast-uri and qs advisories stay closed (card 74851e8b)', () => {
  it.each(ADVISORIES)('$name is installed at or above $firstFixed', ({ name, firstFixed }) => {
    const v = lock.packages[`node_modules/${name}`]?.version
    expect(v, `${name} is not in the lockfile -- this assertion would be vacuous`).toBeTruthy()
    expect(atLeast(v as string, firstFixed), `${name} ${v} is below the fixed ${firstFixed}`).toBe(true)
  })

  // The actual root cause, generalized: a floor inside the advisory range satisfies the override
  // while still installing a vulnerable version. `>=3.1.4 <4` did exactly that for eight months.
  it.each(ADVISORIES)('the $name override FLOOR is at or above $firstFixed, not merely present', ({ name, firstFixed, vulnerableCeiling }) => {
    const floor = floorOf(pkg.overrides?.[name])
    expect(floor, `no >= floor to read in the ${name} override -- ${pkg.overrides?.[name]}`).toBeTruthy()
    expect(
      atLeast(floor as string, firstFixed),
      `the ${name} override floor ${floor} is at or below the advisory ceiling ${vulnerableCeiling}, ` +
        `so a vulnerable version satisfies it -- raise the floor to ${firstFixed} or higher`,
    ).toBe(true)
  })

  // package.json carries the same override map twice, for npm and for pnpm. Updating one and not
  // the other is silent: whichever installer you happen to run decides whether the fix applies.
  // Found the hard way while writing this card's fix.
  it('the npm and pnpm override blocks are the same map', () => {
    expect(pkg.overrides, 'no npm overrides block').toBeTruthy()
    expect(pkg.pnpm?.overrides, 'no pnpm overrides block').toBeTruthy()
    expect(pkg.pnpm?.overrides).toEqual(pkg.overrides)
  })

  // ajv declares ^3.0.1; staying under 4 is the deliberate half of the fix, not an oversight.
  it('fast-uri stays inside the major ajv declares support for', () => {
    expect(pkg.overrides?.['fast-uri']).toContain('<4')
    const v = lock.packages['node_modules/fast-uri']?.version as string
    expect(parse(v)[0]).toBe(3)
  })

  it('CONTROL: the floor comparison rejects the range this card replaced', () => {
    // Otherwise "the floor is high enough" and "the check cannot tell" look identical.
    expect(floorOf('>=3.1.4 <4')).toBe('3.1.4')
    expect(atLeast('3.1.4', '3.1.6')).toBe(false)
    expect(atLeast('3.1.6', '3.1.6')).toBe(true)
    expect(atLeast('3.1.10', '3.1.9')).toBe(true) // numeric, not lexical
    expect(floorOf('^3.1.7')).toBeNull()
    expect(floorOf(undefined)).toBeNull()
  })
})
