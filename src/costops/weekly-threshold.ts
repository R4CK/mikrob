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

// ---------------------------------------------------------------------------------------------
// Auto-aggressiveness ramp (card 346d3933, Peti 2026-08-01).
//
// The local-LLM offload aggressiveness used to be a single flat number (the standing "optimal 75"
// directive). Peti asked for it to RISE automatically as the weekly usage approaches newDevStop, so
// the fleet leans harder on the free local GPU exactly when Claude tokens are about to run out --
// WITHOUT ever overriding a value Peti set by hand on the dashboard slider.
//
// Three rules, and the manual-override one is the load-bearing one:
//   1. monotone non-decreasing curve in weekly% -- far from the threshold it sits at the standing
//      baseline, and it climbs as the threshold nears;
//   2. AT (or above) the threshold, with no manual override, it pins to 100;
//   3. MANUAL OVERRIDE WINS -- if Peti set the slider (`aggressiveness_source: 'manual'`), the ramp
//      never touches the value until he switches it back to 'auto'.
// ---------------------------------------------------------------------------------------------

/** The offload directive file the fleet agents + the local-llm-offload skill read. Its
 *  `aggressiveness` is what the ramp writes; `aggressiveness_source` is what protects a manual set. */
const OFFLOAD_CONFIG_PATH = join(PROJECT_ROOT, 'store', 'local-llm-offload-active.json')
/** Where the live weekly % lands: weekly-usage-panel-read.sh -> pre-dispatch-check.sh set-weekly. */
const WEEKLY_USAGE_PATH = join(PROJECT_ROOT, 'store', 'weekly-usage.json')

/**
 * Aggressiveness FAR from the threshold (weekly% at/below 0). Set to the standing "optimal" default
 * (75, cross-referenced from src/web/routes/local-llm.ts OPTIMAL_AGGRESSIVENESS): the ramp raises the
 * established proactive baseline toward 100 as the threshold nears, and never DROPS below it -- so
 * turning the ramp on cannot silently weaken the offload Peti already asked for. Lower this one
 * constant if Peti wants the ramp to start from a genuinely low floor.
 */
export const RAMP_FLOOR_AGGRESSIVENESS = 75

export type AggressivenessSource = 'manual' | 'auto'

/** The subset of the offload config the ramp reads/writes. Everything else in the file is preserved. */
export interface OffloadRampConfig {
  aggressiveness?: number
  aggressiveness_source?: string
  aggressiveness_set_at?: string
  [key: string]: unknown
}

const clamp100 = (n: number): number => Math.max(0, Math.min(100, Math.round(n)))

/**
 * The ramp curve. Monotone non-decreasing in `weeklyPct`, linear from {@link RAMP_FLOOR_AGGRESSIVENESS}
 * at weekly 0 to 100 at `newDevStop`, and pinned to 100 at or above the threshold.
 *
 * Pure + deterministic. `floor` is injectable for tests; production always uses the constant.
 */
export function rampAggressiveness(
  weeklyPct: number,
  newDevStop: number,
  floor: number = RAMP_FLOOR_AGGRESSIVENESS,
): number {
  const pct = Number(weeklyPct)
  const threshold = Number(newDevStop)
  const f = clamp100(floor)
  // A non-positive or unusable threshold cannot define a ramp; fail SAFE to the top (be maximally
  // aggressive) rather than invent a slope, since a broken threshold means we cannot tell how close
  // to the limit we are.
  if (!Number.isFinite(pct) || !Number.isFinite(threshold) || threshold <= 0) return 100
  if (pct <= 0) return f
  if (pct >= threshold) return 100
  return clamp100(f + (100 - f) * (pct / threshold))
}

/**
 * Resolve whether the aggressiveness is under manual or automatic control.
 *
 * An explicit `aggressiveness_source` wins. For a LEGACY file that has none: if a value was ever set
 * (`aggressiveness_set_at` present) it is treated as MANUAL -- turning the ramp on must never clobber
 * a number an operator already chose. Only a pristine config (no source, no set_at) defaults to auto.
 */
export function resolveAggressivenessSource(cfg: OffloadRampConfig): AggressivenessSource {
  if (cfg.aggressiveness_source === 'manual' || cfg.aggressiveness_source === 'auto') {
    return cfg.aggressiveness_source
  }
  return cfg.aggressiveness_set_at ? 'manual' : 'auto'
}

/** What {@link applyAggressivenessRamp} decided, for logging and for the applier's exit reporting. */
export interface RampDecision {
  readonly source: AggressivenessSource
  readonly weeklyPct: number
  readonly newDevStop: number
  readonly previous: number | undefined
  readonly next: number
  readonly changed: boolean
  readonly config: OffloadRampConfig
}

/**
 * Apply the ramp to an offload config, given the live weekly% and the threshold. Returns the config
 * to persist and whether anything changed.
 *
 * MANUAL wins: a manual source returns the config byte-for-byte unchanged (changed:false). An auto
 * source recomputes the aggressiveness from {@link rampAggressiveness}; if it differs it is written
 * with a fresh `aggressiveness_set_at` and `aggressiveness_source:'auto'` stamped, so the file always
 * states plainly what set the value and when.
 */
export function applyAggressivenessRamp(
  cfg: OffloadRampConfig,
  weeklyPct: number,
  newDevStop: number,
  nowIso: string,
): RampDecision {
  const source = resolveAggressivenessSource(cfg)
  const previous = typeof cfg.aggressiveness === 'number' ? cfg.aggressiveness : undefined
  if (source === 'manual') {
    return { source, weeklyPct, newDevStop, previous, next: previous ?? 100, changed: false, config: cfg }
  }
  const next = rampAggressiveness(weeklyPct, newDevStop)
  if (previous === next && cfg.aggressiveness_source === 'auto') {
    return { source, weeklyPct, newDevStop, previous, next, changed: false, config: cfg }
  }
  const config: OffloadRampConfig = {
    ...cfg,
    aggressiveness: next,
    aggressiveness_source: 'auto',
    aggressiveness_set_at: nowIso,
  }
  return { source, weeklyPct, newDevStop, previous, next, changed: true, config }
}

/** Read the live weekly % from weekly-usage.json (`.percent`); null if absent/unreadable/malformed. */
export function readWeeklyPercent(path: string = WEEKLY_USAGE_PATH): number | null {
  try {
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    const pct = Number(raw['percent'])
    return Number.isFinite(pct) ? pct : null
  } catch {
    return null
  }
}

/** Read the offload directive file as a mutable record; {} if absent/unreadable. */
export function readOffloadRampConfig(path: string = OFFLOAD_CONFIG_PATH): OffloadRampConfig {
  try {
    if (!existsSync(path)) return {}
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (raw && typeof raw === 'object') return raw as OffloadRampConfig
  } catch {
    /* fall through to empty */
  }
  return {}
}

export { OFFLOAD_CONFIG_PATH, WEEKLY_USAGE_PATH }
