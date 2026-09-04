// Card 9081d02d, the 08dcc153 incident: a CleanCore card landed on origin/main with the commit
// message "gate-teljes @ 645b8ece" while the card carried no REVIEW, no QA, no Cybersec and no
// Cybered comment at all. Nothing in the landing path ever asked -- "gate-complete" was an
// assertion by whoever typed the command, and the commit message repeated it as a measurement.
//
// The check now asks the board. This file runs its selftest on every landing, and -- the half that
// is easy to forget -- pins that both landers actually CALL it. A control that ships unwired is
// the failure mode I have already hit twice in this repo.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const STORE = join(REPO_ROOT, 'store')

describe('landing gate-verdict check', () => {
  it('ships the checker, its parser and its selftest', () => {
    for (const f of [
      'landing-gate-verdict-check.sh',
      'landing-gate-verdict-parse.py',
      'landing-gate-verdict-check.selftest.sh',
    ]) {
      expect(existsSync(join(STORE, f)), `${f} missing`).toBe(true)
    }
  })

  it('its selftest passes, and reports a COUNTED number of cases', () => {
    const out = execFileSync('bash', [join(STORE, 'landing-gate-verdict-check.selftest.sh')], {
      encoding: 'utf-8',
      timeout: 120_000,
    })
    // A counted number, not a literal: a harness that could report success with zero cases run
    // would be worse than no harness.
    expect(out).toMatch(/selftest: [1-9]\d* case\(s\), PASS/)
  })

  // THE WIRING. Cybersec's LOW on card 171c9f42, and it was right: the two tests that used to sit
  // here asserted on the landers' SOURCE TEXT (`toContain` of the exact call line), and mutating
  // `return 1` -> `return 0` in the helper left them GREEN. A test that cannot fail when the
  // control is removed is not evidence of the control.
  //
  // The strong evidence now lives in the selftest, which drives the REAL cleancore-land.sh through
  // its real --allow-ungated path against a stub board. This test makes that coverage
  // non-deletable: if those two cases disappear, this fails.
  it('the selftest actually exercises the lander flag path, both ways', () => {
    const out = execFileSync('bash', [join(STORE, 'landing-gate-verdict-check.selftest.sh')], {
      encoding: 'utf-8',
      timeout: 120_000,
    })
    expect(out).toContain('ok   --allow-ungated does NOT wave through a FAILING verdict')
    expect(out).toContain('ok   --allow-ungated DOES tolerate a merely-missing verdict')
    // ...and the return-code contract those two rest on.
    expect(out).toContain('ok   a FAILING verdict returns 2')
  })

  // These remain source-level on purpose, and only for the three things that were actually WRONG
  // -- each is a defect Cybersec measured, and each assertion fails if the fix is reverted. What
  // they deliberately do NOT do any more is restate the whole call line, which is what made the
  // previous pair break on an unrelated edit while staying blind to a removed control.
  it('marveen-land.sh passes a resolved SHA, not the branch name', () => {
    const src = readFileSync(join(STORE, 'marveen-land.sh'), 'utf-8')
    expect(src).toContain('landing-gate-verdict-check.sh')
    // The bug: the parser compares HEX PREFIXES, so a branch name could never match and a fully
    // gated card produced the same "no verdict" line as an ungated one.
    expect(src).toMatch(/rev-parse "\$branch"/)
    expect(src, 'the branch name must not be passed where a sha is expected').not.toContain(
      'gate_verdict_check "$LAND_CARD" "$branch"',
    )
    // The second half: `|| true` swallowed the one outcome worth acting on, since report mode
    // already returns 0 for everything except a FAILING verdict.
    expect(src).not.toMatch(/gate_verdict_check[^\n]*report[^\n]*\|\| true/)
    // Still REPORT, not refuse: marveen gates AFTER landing, so demanding a verdict up front would
    // deadlock every marveen landing.
    expect(src).not.toMatch(/gate_verdict_check "\$LAND_CARD"[^\n]*refuse/)
  })

  it('cleancore-land.sh always CALLS the check, and --allow-ungated only tolerates its answer', () => {
    const src = readFileSync(join(STORE, 'cleancore-land.sh'), 'utf-8')
    expect(src).toContain('landing-gate-verdict-check.sh')
    expect(src).toContain('--allow-ungated')
    // The bug: the flag used to skip the CALL, so the FAILED branch never ran at all.
    const flagIdx = src.indexOf('if [ "$ALLOW_UNGATED" -eq 1 ]; then')
    const callIdx = src.indexOf('gate_verdict_check "$CARD" "$SHA" refuse')
    expect(callIdx).toBeGreaterThan(0)
    if (flagIdx > 0) {
      expect(callIdx, 'the check must not sit inside the flag\'s skip branch').toBeLessThan(flagIdx)
    }
    // ...and the caller must distinguish a FAILING verdict from a merely-missing one, which is the
    // only way the flag can tolerate the second without ever waving through the first.
    expect(src).toMatch(/gate_rc.*-eq 2|-eq 2.*gate_rc/s)
  })

  it('fails CLOSED when the board cannot be read, in refuse mode only', () => {
    const src = readFileSync(join(STORE, 'landing-gate-verdict-check.sh'), 'utf-8')
    // An unreachable board cannot tell a gated card from an ungated one, and this control exists
    // precisely for the case where nobody checked -- so it must refuse rather than shrug through.
    expect(src).toContain('fails CLOSED')
    expect(src).toContain('Fails CLOSED')
  })

  it('never lets --allow-ungated override an actual FAILING verdict', () => {
    const src = readFileSync(join(STORE, 'landing-gate-verdict-check.sh'), 'utf-8')
    expect(src).toContain('A failing verdict is never overridden by --allow-ungated')
    // and the FAILED branch returns before the allow-ungated path can be consulted
    const failedIdx = src.indexOf('FAILED)')
    const strictIdx = src.indexOf('if [ "$strict" -eq 0 ]')
    expect(failedIdx).toBeGreaterThan(0)
    expect(failedIdx).toBeLessThan(strictIdx)
  })
})
