// Card 0a527826 (F4 side-effect health board, Pair-FE 2d9c0bb2): one health entry per
// side-effect kind, turning 'red' after 3 consecutive failures. Reuses existing logs/tables
// instead of a new instrumentation layer -- additive only (Peti 14288): no existing route,
// table or log is touched.
//
// Contract (agreed with Fron Ted, card 2d9c0bb2 REVIEW 34995):
//   GET /api/health/effects -> { effects: [{ kind, status: 'ok'|'red', consecutiveFailures,
//                                             lastError, lastCheckedAt }] }
//
// Coverage: 5 of the 6 kinds named in the card description have a real, queryable run history
// (land-runs.jsonl, task_runs, telegram_outbox, offload-attempts.json, memories.embedding).
// `gate_dispatch` does NOT -- gate-dispatch-check.sh is a stateless decision helper and nothing
// in the codebase persists a dispatch send's own success/failure today. Reporting it anyway
// would mean fabricating a status with no real measurement behind it, so it is left out of this
// round's effects array rather than guessed at (see REVIEW for the full explanation).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../../config.js'
import { getDb } from '../../db.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export const HEALTH_EFFECTS_ENABLED_PATH = join(STORE_DIR, 'health-effects-enabled.json')
const RED_THRESHOLD = 3

export function readHealthEffectsEnabled(path = HEALTH_EFFECTS_ENABLED_PATH): boolean {
  try {
    const d: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    return typeof d === 'object' && d !== null && (d as Record<string, unknown>).enabled === true
  } catch {
    return false
  }
}

export type EffectStatus = 'ok' | 'red'

export interface EffectHealth {
  kind: string
  status: EffectStatus
  consecutiveFailures: number
  lastError: string | null
  lastCheckedAt: string
}

interface Trailing { count: number; lastError: string | null }

// Walks items NEWEST-FIRST. classify() returns 'fail' (extends the streak), 'ok' (ends it), or
// 'skip' (a neutral event -- e.g. a deliberate abort, or a run still in flight -- that neither
// extends nor breaks it, so an unrelated event in between two real failures cannot hide them).
export function trailingFailures<T>(
  itemsNewestFirst: readonly T[],
  classify: (item: T) => 'fail' | 'ok' | 'skip',
  errorOf: (item: T) => string | null,
): Trailing {
  let count = 0
  let lastError: string | null = null
  for (const item of itemsNewestFirst) {
    const c = classify(item)
    if (c === 'skip') continue
    if (c === 'ok') break
    count++
    if (lastError === null) lastError = errorOf(item)
  }
  return { count, lastError }
}

function toHealth(kind: string, t: Trailing, now: number): EffectHealth {
  return {
    kind,
    status: t.count >= RED_THRESHOLD ? 'red' : 'ok',
    consecutiveFailures: t.count,
    lastError: t.count > 0 ? t.lastError : null,
    lastCheckedAt: new Date(now).toISOString(),
  }
}

// ---- land (store/land-runs.jsonl) ------------------------------------------------------------

interface LandRunLine { event?: string; result?: string; note?: string }

export function computeLandEffect(lines: string[], now = Date.now()): EffectHealth {
  const finished: LandRunLine[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as LandRunLine
      if (e.event === 'finished') finished.push(e)
    } catch { /* malformed line: skip, do not fail the whole read */ }
  }
  finished.reverse() // the file is append-only chronological; we need newest-first
  const t = trailingFailures(
    finished,
    (e) => (e.result === 'fail' ? 'fail' : e.result === 'ok' || e.result === 'pushed' ? 'ok' : 'skip'),
    (e) => e.note ?? `land result=${e.result ?? 'unknown'}`,
  )
  return toHealth('land', t, now)
}

export function readLandEffect(path = join(STORE_DIR, 'land-runs.jsonl'), now = Date.now()): EffectHealth {
  if (!existsSync(path)) return toHealth('land', { count: 0, lastError: null }, now)
  return computeLandEffect(readFileSync(path, 'utf-8').split('\n'), now)
}

// ---- scheduled_task (task_runs table) --------------------------------------------------------

export interface TaskRunRow { status: string; outcome: string | null; completed_at: number | null }

export function computeScheduledTaskEffect(rowsNewestFirst: TaskRunRow[], now = Date.now()): EffectHealth {
  const t = trailingFailures(
    rowsNewestFirst,
    (r) => {
      if (r.completed_at === null) return 'skip' // still open, no verdict yet
      if (r.outcome === 'lost' || r.outcome === 'lost-giveup') return 'fail'
      if (r.outcome === 'done') return 'ok'
      return 'skip' // skipped/skipped-precheck/etc: a policy outcome, not a mechanism failure
    },
    (r) => `scheduled task outcome=${r.outcome ?? 'unknown'}`,
  )
  return toHealth('scheduled_task', t, now)
}

export function readScheduledTaskEffect(now = Date.now(), limit = 30): EffectHealth {
  const rows = getDb().prepare(
    'SELECT status, outcome, completed_at FROM task_runs ORDER BY ts DESC LIMIT ?',
  ).all(limit) as TaskRunRow[]
  return computeScheduledTaskEffect(rows, now)
}

// ---- telegram_send (telegram_outbox table) ---------------------------------------------------

export interface TelegramOutboxRow { status: string; last_error: string | null }

export function computeTelegramSendEffect(rowsNewestFirst: TelegramOutboxRow[], now = Date.now()): EffectHealth {
  const t = trailingFailures(
    rowsNewestFirst,
    (r) => (r.status === 'sent' ? 'ok' : 'fail'), // 'pending' (still retrying) and 'failed' both count
    (r) => r.last_error,
  )
  return toHealth('telegram_send', t, now)
}

export function readTelegramSendEffect(now = Date.now(), limit = 20): EffectHealth {
  const rows = getDb().prepare(
    'SELECT status, last_error FROM telegram_outbox ORDER BY created_at DESC LIMIT ?',
  ).all(limit) as TelegramOutboxRow[]
  return computeTelegramSendEffect(rows, now)
}

// ---- offload_draft (store/offload-attempts.json) ----------------------------------------------

interface OffloadAttempt { status?: string; reason?: string; updated_at?: number }

export function computeOffloadDraftEffect(attempts: Record<string, OffloadAttempt>, now = Date.now()): EffectHealth {
  const newestFirst = Object.values(attempts).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
  const t = trailingFailures(
    newestFirst,
    (a) => (a.status === 'exhausted' ? 'fail' : a.status === 'done' ? 'ok' : 'skip'), // 'pending': still retrying
    (a) => `offload exhausted (${a.reason ?? 'unknown reason'})`,
  )
  return toHealth('offload_draft', t, now)
}

export function readOffloadDraftEffect(path = join(STORE_DIR, 'offload-attempts.json'), now = Date.now()): EffectHealth {
  if (!existsSync(path)) return toHealth('offload_draft', { count: 0, lastError: null }, now)
  try {
    const attempts = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, OffloadAttempt>
    return computeOffloadDraftEffect(attempts, now)
  } catch {
    return toHealth('offload_draft', { count: 0, lastError: null }, now)
  }
}

// ---- memory_embed (memories table) -------------------------------------------------------------
//
// No persisted error text exists for a failed embed attempt (unlike the other four kinds).
// The only real, queryable signal is whether recently-created memories still carry a NULL
// embedding -- a trailing run of NULLs among the newest rows is a genuine measurement (embedding
// has not happened for recent memories), not a guess, even though it cannot name a cause.

export interface MemoryEmbedRow { embedding: string | null }

export function computeMemoryEmbedEffect(rowsNewestFirst: MemoryEmbedRow[], now = Date.now()): EffectHealth {
  const t = trailingFailures(
    rowsNewestFirst,
    (r) => (r.embedding === null ? 'fail' : 'ok'),
    () => 'embedding column is NULL for a recent memory (not yet embedded)',
  )
  return toHealth('memory_embed', t, now)
}

export function readMemoryEmbedEffect(now = Date.now(), limit = 20): EffectHealth {
  const rows = getDb().prepare(
    'SELECT embedding FROM memories ORDER BY created_at DESC LIMIT ?',
  ).all(limit) as MemoryEmbedRow[]
  return computeMemoryEmbedEffect(rows, now)
}

// ---- route -------------------------------------------------------------------------------------

export function readAllEffects(now = Date.now()): EffectHealth[] {
  return [
    readLandEffect(undefined, now),
    readScheduledTaskEffect(now),
    readTelegramSendEffect(now),
    readOffloadDraftEffect(undefined, now),
    readMemoryEmbedEffect(now),
  ]
}

export async function tryHandleHealthEffects(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (path === '/api/health/effects' && method === 'GET') {
    // Default off until this card is gated (Peti 14288: additive, flag default off).
    json(res, { effects: readHealthEffectsEnabled() ? readAllEffects() : [] })
    return true
  }
  return false
}
