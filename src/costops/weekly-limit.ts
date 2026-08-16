// Weekly-limit % snapshot (card 8388642a / FÁZIS2, part 3). The Claude Max/Pro
// "Weekly limits / All models" usage % that drives the fleet's new-dev stop rule.
//
// IMPORTANT (memory: weekly-usage-autoread-unavailable): there is NO reliable
// PROGRAMMATIC read of the weekly % (the OAuth token lacks the usage scope). So this
// is a MANUAL snapshot: the operator reads the % off the Claude usage screen and
// records it here (value + the reset time shown there). No fantasy auto-read. If no
// snapshot exists, the reader returns null and the API surfaces a DESCRIPTIVE,
// actionable message (rule 12) instead of a fake number.
//
// RE-VERIFIED FRESH 2026-07-25 (card c9ce4254, Peti asked to automate this): a live
// probe of the account OAuth endpoints with the fleet token (sk-ant-oat0..., from
// marveen/.env) still fails on scope -- GET /api/oauth/profile -> HTTP 403
// "OAuth token does not meet scope requirement any_of(user:profile, user:office)".
// So the manual snapshot remains authoritative. The re-runnable probe + forward-
// compatible auto-reader lives in store/weekly-usage-probe.sh: if Peti ever re-issues
// the token WITH an account scope, that script writes this snapshot with source='oauth'
// (hence the widened source union below) and can be cron'd -- no code change needed.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from '../web/atomic-write.js'

const SNAPSHOT_PATH = join(PROJECT_ROOT, 'store', 'weekly-limit-snapshot.json')

/** One usage bar from the /usage screen: a percentage (0..100) + its reset label. */
export interface UsageMetric {
  readonly pct: number
  /** The reset time as shown on the usage screen (e.g. 'Thu 3:59 PM'), or null. */
  readonly resetAt: string | null
}

export interface WeeklyLimitSnapshot {
  /** The "Weekly / All models" usage percentage, 0..100. CANONICAL: this is the value the
   *  fleet's new-dev stop rule reads, so it stays top-level and backward-compatible. */
  readonly pct: number
  /** Unix seconds when the snapshot was recorded. */
  readonly setAt: number
  /** How the snapshot was obtained: `manual` (operator entry), `panel` (auto-read from the
   *  dedicated Max-authed /usage panel via store/weekly-usage-panel-read.sh), or `oauth`
   *  (auto-written by store/weekly-usage-probe.sh IF the token is ever re-scoped -- see header).
   *  The reader passes the stored value through so an auto-read is never mislabelled as manual. */
  readonly source: 'manual' | 'oauth' | 'panel'
  /** The weekly (all-models) reset time as shown on the usage screen (e.g. 'Thu 3:59 PM'), or null. */
  readonly resetAt: string | null
  /** Unix seconds since the CURRENT `resetAt` label took effect -- i.e. when it last actually
   *  CHANGED across writes, not merely got re-confirmed by another probe cycle. `resetAt` is a
   *  free-text label straight off the usage screen ('Thu 3:59 PM', 'Aug 20, 4pm (...)') with no
   *  reliable single format to parse into an absolute time, so this reuses the official source
   *  (a label change IS the weekly reset happening) instead of computing a second, independent
   *  week boundary (card 87b2fef9). Null until the first snapshot with a known resetAt lands. */
  readonly resetBoundarySetAt: number | null
  /** Optional operator note. */
  readonly note: string | null
  // --- Enriched /usage metrics (card a91c6039), all null when not captured. Additive: old
  //     snapshots that carry only `pct`/`resetAt` still read fine. -------------------------------
  /** Current session usage bar. */
  readonly session: UsageMetric | null
  /** Current week (Fable) usage bar. */
  readonly fable: UsageMetric | null
  /** The active weekly-limit promo text, e.g. '+50% weekly limit through Aug 19', or null. */
  readonly promo: string | null
}

/** Thrown on an invalid manual snapshot input (bad %). Maps to a 400 with a
 *  descriptive, actionable message (rule 12). */
export class WeeklyLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WeeklyLimitError'
  }
}

/** Read the current manual weekly-% snapshot. Fail-safe: null when never recorded,
 *  unreadable, or malformed (so the gauge shows the empty/needs-input state, never a
 *  fake or crashing value). `path` is injectable for tests. */
/** Parse an optional UsageMetric ({pct, resetAt}) from stored JSON, fail-safe to null. */
function readMetric(v: unknown): UsageMetric | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const pct = Number(o['pct'])
  if (!Number.isFinite(pct)) return null
  return {
    pct: Math.max(0, Math.min(100, pct)),
    resetAt: typeof o['resetAt'] === 'string' ? (o['resetAt'] as string) : null,
  }
}

export function readWeeklySnapshot(path: string = SNAPSHOT_PATH): WeeklyLimitSnapshot | null {
  try {
    if (!existsSync(path)) return null
    const s = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    const pct = Number(s['pct'])
    if (!Number.isFinite(pct)) return null
    return {
      pct: Math.max(0, Math.min(100, pct)),
      setAt: Number(s['setAt']) || 0,
      // Pass the stored source through (an auto-read must not read back as manual);
      // any unknown/absent value falls back to the safe 'manual' default.
      source: s['source'] === 'oauth' ? 'oauth' : s['source'] === 'panel' ? 'panel' : 'manual',
      resetAt: typeof s['resetAt'] === 'string' ? (s['resetAt'] as string) : null,
      resetBoundarySetAt: Number.isFinite(s['resetBoundarySetAt']) ? (s['resetBoundarySetAt'] as number) : null,
      note: typeof s['note'] === 'string' ? (s['note'] as string) : null,
      // Enriched fields: null when an older snapshot / manual entry omitted them.
      session: readMetric(s['session']),
      fable: readMetric(s['fable']),
      promo: typeof s['promo'] === 'string' && (s['promo'] as string).trim().length > 0 ? (s['promo'] as string).trim() : null,
    }
  } catch {
    return null
  }
}

/** Record a manual weekly-% snapshot (operator input). Validates 0..100 fail-closed
 *  with a descriptive message; persists atomically. `now` is injected. */
export function writeWeeklySnapshot(
  input: {
    pct?: unknown
    resetAt?: unknown
    note?: unknown
    source?: unknown
    session?: unknown
    fable?: unknown
    promo?: unknown
  },
  now: number,
  path: string = SNAPSHOT_PATH,
): WeeklyLimitSnapshot {
  const pct = Number(input.pct)
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new WeeklyLimitError('A heti-limit százalék 0 és 100 közötti szám kell legyen.')
  }
  const trim = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
  // Validate an optional enriched metric fail-closed: omitted -> null; present -> must be a
  // {pct} object with pct in 0..100 (a bad captured value is rejected, never stored as garbage).
  const metric = (v: unknown, label: string): UsageMetric | null => {
    if (v === undefined || v === null) return null
    if (typeof v !== 'object') {
      throw new WeeklyLimitError(`A(z) ${label} mezőnek {pct, resetAt} objektumnak kell lennie.`)
    }
    const o = v as Record<string, unknown>
    const p = Number(o['pct'])
    if (!Number.isFinite(p) || p < 0 || p > 100) {
      throw new WeeklyLimitError(`A(z) ${label} százalék 0 és 100 közötti szám kell legyen.`)
    }
    return { pct: Math.round(p * 10) / 10, resetAt: trim(o['resetAt']) }
  }
  const source: WeeklyLimitSnapshot['source'] =
    input.source === 'panel' ? 'panel' : input.source === 'oauth' ? 'oauth' : 'manual'
  const resetAt = trim(input.resetAt)
  // The label changing value IS the weekly reset (see the field's own doc comment above) -- carry
  // the boundary forward unchanged when the label is re-confirmed or absent this round, and only
  // stamp a fresh `now` when it actually differs from what the previous snapshot had.
  const prev = readWeeklySnapshot(path)
  const resetBoundarySetAt = resetAt !== null && resetAt !== prev?.resetAt ? now : (prev?.resetBoundarySetAt ?? null)
  const snap: WeeklyLimitSnapshot = {
    pct: Math.round(pct * 10) / 10,
    setAt: now,
    source,
    resetAt,
    resetBoundarySetAt,
    note: trim(input.note),
    session: metric(input.session, 'session'),
    fable: metric(input.fable, 'fable'),
    promo: trim(input.promo),
  }
  atomicWriteFileSync(path, JSON.stringify(snap, null, 2))
  return snap
}
