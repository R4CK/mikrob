// Nothing may write the update-check cadence out by hand (card 06bed89a).
//
// WHAT DRIFTED. startUpdateChecker's interval became 6 hours on 2026-08-21 (Peti). Two other places
// had the old number typed into them and neither moved:
//   - web/routes/overview.ts, in a comment: "runs every 15 min via startUpdateChecker"
//   - web.ts, in the STARTUP LOG: "Update checker started (15min poll)"
//
// The log line is the one that matters. A stale comment misleads whoever reads the code, and they
// have the code in front of them. A stale log line misleads whoever is debugging why updates look
// stale -- the one person who cannot afford a false premise, reading the one line that looks
// authoritative. It was wrong at every startup for three weeks.
//
// The fix is not "correct the number in both": that is what was done last time, one file at a time,
// and it is why only one of them was. UPDATE_CHECK_INTERVAL_MS is the single source; this test
// keeps it single.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { UPDATE_CHECK_INTERVAL_MS } from '../web/update-checker.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('update-check cadence is stated once (card 06bed89a)', () => {
  it('the exported constant is the real interval the poller uses', () => {
    // Pins the premise: if startUpdateChecker stopped using the constant, every claim below would
    // be about a number nothing acts on.
    const src = readFileSync(join(SRC, 'web/update-checker.ts'), 'utf8')
    const intervalLine = src.split('\n').find((l) => l.includes('setInterval('))
    expect(intervalLine, 'startUpdateChecker no longer calls setInterval').toBeTruthy()
    expect(intervalLine!).toContain('UPDATE_CHECK_INTERVAL_MS')
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60_000)
  })

  it('THE DEFECT: the startup log derives the cadence instead of asserting a literal', () => {
    const src = readFileSync(join(SRC, 'web.ts'), 'utf8')
    const logLine = src.split('\n').find((l) => l.includes('Update checker started'))
    expect(logLine, 'the startup log line disappeared -- update this test with it').toBeTruthy()
    expect(logLine!).toContain('UPDATE_CHECK_INTERVAL_MS')
    // The exact shape that was wrong for three weeks.
    expect(logLine!).not.toMatch(/\d+\s*min/i)
  })

  it('the overview comment no longer restates a cadence', () => {
    const src = readFileSync(join(SRC, 'web/routes/overview.ts'), 'utf8')
    expect(src).not.toMatch(/runs every \d+ ?(min|hour)/i)
  })

  it('no source file outside update-checker.ts types a cadence for this poller', () => {
    // The general rule, so the next restatement is caught wherever it is added rather than only in
    // the two files that happened to have one. Scoped to lines that name the poller, so unrelated
    // intervals elsewhere are none of this test's business.
    const offenders: string[] = []
    for (const rel of ['web.ts', 'web/routes/overview.ts']) {
      const src = readFileSync(join(SRC, rel), 'utf8')
      src.split('\n').forEach((line, i) => {
        if (!/refreshUpdateStatus|startUpdateChecker|Update checker/i.test(line)) return
        if (/\b\d+\s*(min|perc|hour|óra|ora)\b/i.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders, 'these restate the update-check cadence -- read UPDATE_CHECK_INTERVAL_MS instead').toEqual([])
  })
})
