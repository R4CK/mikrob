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

export interface WeeklyLimitSnapshot {
  /** The "Weekly / All models" usage percentage, 0..100. */
  readonly pct: number
  /** Unix seconds when the snapshot was recorded. */
  readonly setAt: number
  /** How the snapshot was obtained: `manual` (operator entry, the only working path
   *  today) or `oauth` (auto-written by store/weekly-usage-probe.sh IF the token is ever
   *  re-scoped -- see header). The reader passes the stored value through so an auto-read
   *  is never mislabelled as manual. */
  readonly source: 'manual' | 'oauth'
  /** The weekly reset time as shown on the usage screen (e.g. 'Thu 3:59 PM'), or null. */
  readonly resetAt: string | null
  /** Optional operator note. */
  readonly note: string | null
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
export function readWeeklySnapshot(path: string = SNAPSHOT_PATH): WeeklyLimitSnapshot | null {
  try {
    if (!existsSync(path)) return null
    const s = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    const pct = Number(s['pct'])
    if (!Number.isFinite(pct)) return null
    return {
      pct: Math.max(0, Math.min(100, pct)),
      setAt: Number(s['setAt']) || 0,
      // Pass the stored source through (an oauth auto-read must not read back as manual);
      // any unknown/absent value falls back to the safe 'manual' default.
      source: s['source'] === 'oauth' ? 'oauth' : 'manual',
      resetAt: typeof s['resetAt'] === 'string' ? (s['resetAt'] as string) : null,
      note: typeof s['note'] === 'string' ? (s['note'] as string) : null,
    }
  } catch {
    return null
  }
}

/** Record a manual weekly-% snapshot (operator input). Validates 0..100 fail-closed
 *  with a descriptive message; persists atomically. `now` is injected. */
export function writeWeeklySnapshot(
  input: { pct?: unknown; resetAt?: unknown; note?: unknown },
  now: number,
  path: string = SNAPSHOT_PATH,
): WeeklyLimitSnapshot {
  const pct = Number(input.pct)
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new WeeklyLimitError('A heti-limit százalék 0 és 100 közötti szám kell legyen.')
  }
  const trim = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
  const snap: WeeklyLimitSnapshot = {
    pct: Math.round(pct * 10) / 10,
    setAt: now,
    source: 'manual',
    resetAt: trim(input.resetAt),
    note: trim(input.note),
  }
  atomicWriteFileSync(path, JSON.stringify(snap, null, 2))
  return snap
}
