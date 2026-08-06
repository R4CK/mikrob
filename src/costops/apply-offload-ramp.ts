// CLI: apply the auto-aggressiveness ramp (card 346d3933).
//
// Invoked by weekly-usage-panel-read.sh once per 30-minute probe cycle, right after the live weekly %
// has been written to weekly-usage.json. It reads that %, the current newDevStop threshold, and the
// offload directive file, then -- ONLY when the aggressiveness is under automatic control -- writes
// the ramped value back. A manual override is left untouched.
//
// All the decision logic lives in weekly-threshold.ts (pure, unit-tested); this file is the thin IO
// shell: read three files, call applyAggressivenessRamp, write one file atomically. It never throws
// on bad input (the bash caller treats a non-zero exit as best-effort), and prints a one-line
// human-readable result so the probe log says what happened.

import { atomicWriteFileSync } from '../web/atomic-write.js'
import {
  applyAggressivenessRamp,
  OFFLOAD_CONFIG_PATH,
  readOffloadRampConfig,
  readThresholdConfig,
  readWeeklyPercent,
} from './weekly-threshold.js'

/** Run the ramp once. `nowIso` is injectable for tests; the CLI stamps the wall clock. */
export function runOffloadRamp(nowIso: string): string {
  const weeklyPct = readWeeklyPercent()
  if (weeklyPct === null) {
    return 'SKIP: no live weekly % (weekly-usage.json absent or unreadable) -- ramp not applied.'
  }
  const { newDevStop } = readThresholdConfig()
  const cfg = readOffloadRampConfig()
  const decision = applyAggressivenessRamp(cfg, weeklyPct, newDevStop, nowIso)

  if (decision.source === 'manual') {
    return `MANUAL: aggressiveness is operator-set (${decision.previous ?? 'unset'}%), ramp skipped (weekly ${weeklyPct}%, threshold ${newDevStop}%).`
  }
  if (!decision.changed) {
    return `AUTO: aggressiveness already ${decision.next}% at weekly ${weeklyPct}% (threshold ${newDevStop}%), no write.`
  }
  atomicWriteFileSync(OFFLOAD_CONFIG_PATH, JSON.stringify(decision.config, null, 2) + '\n')
  return `AUTO: aggressiveness ${decision.previous ?? 'unset'}% -> ${decision.next}% (weekly ${weeklyPct}%, threshold ${newDevStop}%).`
}

// Run when invoked directly (node dist/costops/apply-offload-ramp.js), not when imported by a test.
if (process.argv[1] && process.argv[1].endsWith('apply-offload-ramp.js')) {
  try {
    console.log(runOffloadRamp(new Date().toISOString()))
  } catch (err) {
    console.error('apply-offload-ramp failed:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
