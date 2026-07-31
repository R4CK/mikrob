// Editable weekly stop thresholds (cards f3248478 + d08b98f4, Peti decisions).
//
// WHAT CHANGED IN d08b98f4: the three DAY-DEPENDENT thresholds (>3 days -> 90, <2 days -> 92,
// <1 day -> 95) are gone. Peti explicitly approved dropping the day escalation: the schedule was hard
// to reason about and nobody could say, looking at the panel, what the fleet would do at 93%. Two
// day-independent levels replace it, and they mean genuinely different things:
//
//   newDevStop (default 90) -- NO NEW DEVELOPMENT. In-flight cards finish, gates still run, the
//                              local-LLM offload takes over. This is the existing behaviour.
//   testStop   (default 97) -- EVERYTHING STOPS, including QA/Cybersec/Cybered gate work. Every role
//                              agent is parked; only MikroB stays alive (rule 7's standing exception:
//                              it monitors, answers Peti and restarts the fleet).
//
// Both the TypeScript API and the bash gate (store/pre-dispatch-check.sh) read THIS file, so the two
// halves of the fleet cannot drift apart on what "the threshold" is.
//
// MONOTONICITY IS ENFORCED, not assumed (card d53c1e00): newDevStop <= testStop. Each value is valid
// on its own in 1..100, so without the comparison an operator could save newDevStop=97/testStop=90 --
// which would stop the gates BEFORE new development, i.e. the fleet would keep opening work it could
// no longer verify.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from '../web/atomic-write.js'

const CONFIG_PATH = join(PROJECT_ROOT, 'store', 'weekly-threshold-config.json')

export interface WeeklyThresholdConfig {
  /** Weekly usage % at which NEW development stops (in-flight work and gates continue). Default 90. */
  readonly newDevStop: number
  /** Weekly usage % at which GATE work stops too and every role agent is parked. Default 97. */
  readonly testStop: number
  readonly updatedAt: number | null
}

export const DEFAULT_THRESHOLDS: Omit<WeeklyThresholdConfig, 'updatedAt'> = {
  newDevStop: 90,
  testStop: 97,
}

export class WeeklyThresholdError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WeeklyThresholdError'
  }
}

const clampPercent = (v: unknown, fallback: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.round(n))) : fallback
}

/**
 * Read the current thresholds, or the defaults if never edited / unreadable / malformed -- this must
 * never throw and never block the gate script's own fallback.
 *
 * MIGRATES the old three-field shape in place: a file written before d08b98f4 carries
 * gt3days/lt2days/lt1day, and its gt3days IS the "new development stops" level, so it is adopted as
 * newDevStop. The old file has nothing that means "stop the gates too", so testStop takes the default
 * -- deriving it from lt1day would invent a policy the operator never chose.
 */
export function readThresholdConfig(path: string = CONFIG_PATH): WeeklyThresholdConfig {
  try {
    if (!existsSync(path)) return { ...DEFAULT_THRESHOLDS, updatedAt: null }
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    const legacy = raw['newDevStop'] === undefined && raw['gt3days'] !== undefined
    const newDevStop = clampPercent(
      legacy ? raw['gt3days'] : raw['newDevStop'],
      DEFAULT_THRESHOLDS.newDevStop,
    )
    const testStop = clampPercent(raw['testStop'], DEFAULT_THRESHOLDS.testStop)
    // Defence in depth (card d53c1e00): writeThresholdConfig rejects a non-monotonic pair, but a file
    // hand-edited outside the API could still carry one -- fall back to the safe defaults rather than
    // serve a rule that stops verification before it stops work.
    if (newDevStop > testStop) return { ...DEFAULT_THRESHOLDS, updatedAt: null }
    return {
      newDevStop,
      testStop,
      updatedAt: Number.isFinite(Number(raw['updatedAt'])) ? Number(raw['updatedAt']) : null,
    }
  } catch {
    return { ...DEFAULT_THRESHOLDS, updatedAt: null }
  }
}

/** Persist edited thresholds. Fail-closed 1..100 integer validation with a descriptive error
 *  (rule 12), never a silently-clamped surprise on write. */
export function writeThresholdConfig(
  input: { newDevStop?: unknown; testStop?: unknown },
  now: number,
  path: string = CONFIG_PATH,
): WeeklyThresholdConfig {
  const parseInt1to100 = (v: unknown, label: string): number => {
    const n = Number(v)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 100) {
      throw new WeeklyThresholdError(`A(z) "${label}" kuszob 1 es 100 kozotti egesz szam kell legyen.`)
    }
    return n
  }
  const newDevStop = parseInt1to100(input.newDevStop, 'newDevStop')
  const testStop = parseInt1to100(input.testStop, 'testStop')
  if (newDevStop > testStop) {
    throw new WeeklyThresholdError(
      `Az "uj fejlesztes leall" kuszob nem lehet nagyobb a "teszteles is leall" kuszobnel ` +
        `(${newDevStop} > ${testStop}): a flotta gate nelkul nyitna uj munkat.`,
    )
  }
  const config: WeeklyThresholdConfig = { newDevStop, testStop, updatedAt: now }
  atomicWriteFileSync(path, JSON.stringify(config, null, 2))
  return config
}
