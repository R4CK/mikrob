// Editable weekly new-dev-stop thresholds (card f3248478, Peti request). The fleet's
// pre-dispatch gate (store/pre-dispatch-check.sh) computes a dynamic threshold from
// days-to-reset: >3 days -> gt3days, <2 days -> lt2days, <1 day -> lt1day (CLAUDE.md
// "Heti limit 90% -- uj-fejlesztes stop" rule). Those were hardcoded 90/92/95; this
// makes them superadmin-editable from the dashboard's Claude Limit panel, persisted
// here so BOTH the TypeScript API and the bash gate script read the SAME file (no
// drift between two copies of the same three numbers).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from '../web/atomic-write.js'

const CONFIG_PATH = join(PROJECT_ROOT, 'store', 'weekly-threshold-config.json')

export interface WeeklyThresholdConfig {
  /** Threshold when >3 days remain to the weekly reset. Default 90. */
  readonly gt3days: number
  /** Threshold when <2 days remain to the weekly reset. Default 92. */
  readonly lt2days: number
  /** Threshold when <1 day remains to the weekly reset. Default 95. */
  readonly lt1day: number
  readonly updatedAt: number | null
}

export const DEFAULT_THRESHOLDS: Omit<WeeklyThresholdConfig, 'updatedAt'> = {
  gt3days: 90,
  lt2days: 92,
  lt1day: 95,
}

export class WeeklyThresholdError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WeeklyThresholdError'
  }
}

/** Read the current thresholds, or the CLAUDE.md defaults if never edited / unreadable /
 *  malformed -- this must never throw or block the gate script's own fallback. */
export function readThresholdConfig(path: string = CONFIG_PATH): WeeklyThresholdConfig {
  try {
    if (!existsSync(path)) return { ...DEFAULT_THRESHOLDS, updatedAt: null }
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    const clamp = (v: unknown, fallback: number): number => {
      const n = Number(v)
      return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.round(n))) : fallback
    }
    return {
      gt3days: clamp(raw['gt3days'], DEFAULT_THRESHOLDS.gt3days),
      lt2days: clamp(raw['lt2days'], DEFAULT_THRESHOLDS.lt2days),
      lt1day: clamp(raw['lt1day'], DEFAULT_THRESHOLDS.lt1day),
      updatedAt: Number.isFinite(Number(raw['updatedAt'])) ? Number(raw['updatedAt']) : null,
    }
  } catch {
    return { ...DEFAULT_THRESHOLDS, updatedAt: null }
  }
}

/** Persist edited thresholds. Fail-closed 1..100 integer validation (rule 12: a
 *  descriptive error, never a silently-clamped surprise on write -- read-side clamping
 *  above is the defence for files edited outside the API). */
export function writeThresholdConfig(
  input: { gt3days?: unknown; lt2days?: unknown; lt1day?: unknown },
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
  const config: WeeklyThresholdConfig = {
    gt3days: parseInt1to100(input.gt3days, 'gt3days'),
    lt2days: parseInt1to100(input.lt2days, 'lt2days'),
    lt1day: parseInt1to100(input.lt1day, 'lt1day'),
    updatedAt: now,
  }
  atomicWriteFileSync(path, JSON.stringify(config, null, 2))
  return config
}
