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

  // THE WIRING. The selftest above proves the function works; these prove it is reached.
  it('cleancore-land.sh sources it and REFUSES on it', () => {
    const src = readFileSync(join(STORE, 'cleancore-land.sh'), 'utf-8')
    expect(src).toContain('landing-gate-verdict-check.sh')
    expect(src).toContain('gate_verdict_check "$CARD" "$SHA" refuse')
    // The documented override, and the fact that it is a NAMED flag rather than a blanket --force.
    expect(src).toContain('--allow-ungated')
  })

  it('marveen-land.sh sources it in REPORT mode, and only with an explicit --card', () => {
    const src = readFileSync(join(STORE, 'marveen-land.sh'), 'utf-8')
    expect(src).toContain('landing-gate-verdict-check.sh')
    expect(src).toContain('gate_verdict_check "$LAND_CARD" "$branch" report')
    // NOT strict here, and that is deliberate rather than an oversight: marveen gates AFTER
    // landing (the root CLAUDE.md's "a visszaadott sha a Gate-SHA"), so the sha a gate will judge
    // is the one this script is about to produce. Demanding a verdict up front would deadlock
    // every marveen landing. If someone "tightens" this to refuse, the fleet stops landing.
    expect(src).not.toContain('gate_verdict_check "$LAND_CARD" "$branch" refuse')
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
