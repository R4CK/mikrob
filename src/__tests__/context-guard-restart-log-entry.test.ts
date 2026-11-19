import { describe, it, expect } from 'vitest'
import { buildRestartLogEntry } from '../context-guard.js'

// card d66b7681 (MikroB GO, msg 18804, condition 2): a structured, per-resume
// restart-log entry so it is later MEASURABLE whether resumed agents followed
// the stale-handoff instruction. Pure classification only -- the file-append
// side (context-guard-runner.ts) is I/O and out of scope for this pure test.
describe('buildRestartLogEntry classifies the same four branches resumePrompt() picks from', () => {
  it('no handoff at all', () => {
    const e = buildRestartLogEntry('samu', false, null, 1000)
    expect(e).toEqual({
      agent: 'samu', tsMs: 1000, handoffAgeMinutes: null, stale: false,
      firstActionInstructed: 'no-handoff-use-live-sources',
    })
  })
  it('fresh handoff (null staleness, handoff present)', () => {
    const e = buildRestartLogEntry('samu', true, null, 1000)
    expect(e).toEqual({
      agent: 'samu', tsMs: 1000, handoffAgeMinutes: 0, stale: false,
      firstActionInstructed: 'fresh-handoff-resume',
    })
  })
  it('stale handoff (numeric minutes)', () => {
    const e = buildRestartLogEntry('samu', true, 42, 1000)
    expect(e).toEqual({
      agent: 'samu', tsMs: 1000, handoffAgeMinutes: 42, stale: true,
      firstActionInstructed: 'stale-verify-live-before-irreversible',
    })
  })
  it('unmeasurable freshness', () => {
    const e = buildRestartLogEntry('samu', true, 'unknown', 1000)
    expect(e).toEqual({
      agent: 'samu', tsMs: 1000, handoffAgeMinutes: null, stale: true,
      firstActionInstructed: 'freshness-unmeasurable-cross-check',
    })
  })
})
