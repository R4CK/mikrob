// Card 0d2be5e5 (Cybersec, on the 8417fa5e gate): OLLAMA_HOST steers every local-model call and was
// overridable with NO validation. That was a small matter while the path carried code fragments;
// the specialist routing changed what flows through it -- --task morning-brief / daily-log /
// board-reconcile / tg-draft now pass the owner's email and calendar content and the whole kanban
// state. A remote value would have made every morning brief a silent outbound transfer.
//
// This file runs the guard's selftest and pins the two things a selftest alone cannot: that the
// guard is actually CALLED at startup, and that the flag literal the escape hatch reads is the one
// documented. Measured while writing this: 8 of the 11 store/*.selftest.sh files in this repo are
// referenced by nothing at all and therefore never run, which is exactly how a control ships
// unwired -- reported separately rather than fixed here.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const STORE = join(REPO_ROOT, 'store')
const LLM = join(STORE, 'local-llm.sh')

describe('OLLAMA_HOST loopback guard (card 0d2be5e5)', () => {
  it('ships the guard and its selftest', () => {
    expect(existsSync(LLM), 'local-llm.sh missing').toBe(true)
    expect(existsSync(join(STORE, 'local-llm-host-guard.selftest.sh')), 'selftest missing').toBe(true)
  })

  it('its selftest passes, and reports a COUNTED number of cases', () => {
    const out = execFileSync('bash', [join(STORE, 'local-llm-host-guard.selftest.sh')], {
      encoding: 'utf-8',
      timeout: 120_000,
    })
    // A counted number, not a literal: a harness that reports success with zero cases run is worse
    // than no harness.
    expect(out).toMatch(/selftest: [1-9]\d* case\(s\), PASS/)
  })

  // The half a selftest cannot prove about itself: that the check is INVOKED, not merely defined.
  // A guard function nobody calls passes every one of its own unit cases.
  it('the guard is actually invoked at startup, not just defined', () => {
    const src = readFileSync(LLM, 'utf-8')
    expect(src).toContain('require_loopback_ollama_host()')
    const invocations = src
      .split('\n')
      .filter((l) => /^\s*require_loopback_ollama_host\s*$/.test(l))
    expect(
      invocations.length,
      'require_loopback_ollama_host is defined but never called -- the guard would pass its own ' +
        'selftest and enforce nothing',
    ).toBeGreaterThanOrEqual(1)
  })

  it('the opt-in escape keeps the exact name the refusal message tells operators to use', () => {
    const src = readFileSync(LLM, 'utf-8')
    // Renaming one side would leave a refusal that names a variable which no longer works.
    expect(src).toContain('LOCAL_LLM_ALLOW_REMOTE_HOST')
    const refusal = src.slice(src.indexOf('is not loopback'))
    expect(
      refusal.slice(0, 400),
      'the refusal must name the escape hatch operators are supposed to set',
    ).toContain('LOCAL_LLM_ALLOW_REMOTE_HOST=1')
  })
})
