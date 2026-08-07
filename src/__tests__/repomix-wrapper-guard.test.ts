// The repomix wrapper's security guarantees are CONFIGURATION, so they rot silently (card b41c3dd3,
// Cybersec conditional GO cm#6194). Nothing in the type system stops someone from "simplifying" the
// flag checks away, and the failure is invisible: repomix keeps working, it just starts packing
// secrets. Cybersec's conditions 3 and 4 are the load-bearing ones, so they are pinned here.
//
// Source-level assertions on purpose: the realistic regression is an edit to the wrapper, not a
// runtime fault. Actually packing a repo would need a fixture tree and the pinned binary; grepping
// the script catches the omission directly and runs everywhere.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

const WRAPPER = readFileSync(join(REPO_ROOT, 'store/repomix.sh'), 'utf8')

describe('store/repomix.sh -- Cybersec conditions stay enforced (card b41c3dd3)', () => {
  it('condition 4: refuses --no-security-check so secretlint can never be switched off', () => {
    expect(WRAPPER).toContain('--no-security-check')
    // The flag must be REFUSED, not merely mentioned: a `die` on the same guard.
    const guard = WRAPPER.slice(WRAPPER.indexOf('--no-security-check'))
    expect(guard).toMatch(/die \d+ "REFUSED/)
  })

  it('condition 4: the alternate spellings are covered too (one-flag foot-gun)', () => {
    for (const spelling of ['--no-security', '--security-check=false']) {
      expect(WRAPPER).toContain(spelling)
    }
  })

  it('condition 6: refuses --remote (fetching a third-party repo is an adopt review)', () => {
    expect(WRAPPER).toContain('--remote')
    const guard = WRAPPER.slice(WRAPPER.indexOf('--remote'))
    expect(guard).toMatch(/die \d+ "REFUSED/)
  })

  it('condition 2: pins an exact repomix version, never floating latest', () => {
    const pin = WRAPPER.match(/PINNED_VERSION="([^"]+)"/)
    // The literal is deliberate, not brittleness: an UNREVIEWED bump must fail here, so every
    // version change is acknowledged by a human. Bumped 1.17.0 -> 1.18.0 with card 827330ce
    // (upstream security release; the ReDoS-hardened redaction also runs on the local pack path).
    expect(pin?.[1]).toBe('1.18.0')
    expect(WRAPPER).not.toContain('repomix@latest')
  })

  it('condition 3: documents the registry + --ignore-scripts install rule', () => {
    // `prepare` runs on a git-URL install, so the install METHOD is the control.
    expect(WRAPPER).toContain('--ignore-scripts')
  })

  it('condition 5: default output path is under the gitignored store/ tree', () => {
    const out = WRAPPER.match(/OUT_DIR_DEFAULT="([^"]+)"/)
    expect(out?.[1]).toContain('/store/')
  })

  it('binary is the isolated pinned install, not a PATH lookup (no wrapper bypass)', () => {
    expect(WRAPPER).toContain('.npm-tools/bin/repomix')
    // A bare `repomix` call would resolve via PATH and skip every guard above.
    expect(WRAPPER).not.toMatch(/^\s*repomix\s/m)
  })
})
