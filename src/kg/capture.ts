// Capture queue (MT-05, card c991508f): the DB-only state layer for "a card closed, go extract a
// knowledge-graph solution from it". Deliberately separate from the pipeline (capture-pipeline.ts)
// that does the actual LLM call + graph writes -- same split as local-llm-queue.ts/its worker, so
// the hot path that enqueues (a kanban move request) never blocks on an LLM call.

import type Database from 'better-sqlite3'

export type CaptureReason = 'closed' | 'backfill' | 'reopen'
export type CaptureState = 'pending' | 'done' | 'failed' | 'skipped'

export interface CaptureQueueRow {
  readonly card_id: string
  readonly reason: CaptureReason
  readonly attempts: number
  readonly last_error: string | null
  readonly state: CaptureState
  readonly created_at: number
  readonly updated_at: number
}

/** Enqueues (or re-arms) a capture for one card. `kg_capture_queue.card_id` is the primary key --
 *  a card that closes, reopens and closes again must re-run capture, so a row already in a
 *  terminal state (done/failed/skipped) is reset to pending; a row already pending/mid-flight is
 *  left alone rather than restarting it out from under a worker that might be processing it.
 *
 *  Attempts reset to 0 on every re-arm EXCEPT one case (RedHat 23045 B1 / the backfill.ts cap
 *  that reads this field): a 'backfill' re-arm of a row the backfill itself already failed
 *  ('backfill' reason, 'failed' state) keeps the running count instead of resetting it, so a
 *  capped retry can actually be enforced across repeated backfill runs. Every other re-arm --
 *  closed/reopen (genuinely new content), or a backfill retry of a row some OTHER path failed --
 *  is a fresh attempt and resets to 0, as before. */
export function enqueueCapture(kgDb: Database.Database, cardId: string, reason: CaptureReason, now: number): void {
  const existing = kgDb.prepare('SELECT state, reason FROM kg_capture_queue WHERE card_id = ?').get(cardId) as
    | { state: CaptureState; reason: CaptureReason }
    | undefined
  if (existing && existing.state === 'pending') return
  const keepAttempts = reason === 'backfill' && existing?.reason === 'backfill' && existing?.state === 'failed'
  kgDb.prepare(
    `INSERT INTO kg_capture_queue (card_id, reason, attempts, state, created_at, updated_at)
     VALUES (?, ?, 0, 'pending', ?, ?)
     ON CONFLICT(card_id) DO UPDATE SET reason = excluded.reason,
       attempts = CASE WHEN ? THEN attempts ELSE 0 END, state = 'pending',
       last_error = NULL, updated_at = excluded.updated_at`,
  ).run(cardId, reason, now, now, keepAttempts ? 1 : 0)
}

export function listPendingCaptures(kgDb: Database.Database, limit: number = 20): CaptureQueueRow[] {
  return kgDb
    .prepare(`SELECT * FROM kg_capture_queue WHERE state = 'pending' ORDER BY created_at ASC LIMIT ?`)
    .all(limit) as CaptureQueueRow[]
}

// G1 (card c84a510a): a row the live hook enqueued ('closed'/'reopen') that then failed (a
// transient draftFn/write error, same class markCaptureFailed already tracks for 'backfill' rows)
// used to be permanently stuck -- listPendingCaptures only reads state='pending', and
// defaultListCandidates (backfill.ts) excludes anything already in the queue regardless of
// reason. A capture-worker drain cycle during sustained GPU contention (measured on this card:
// three consecutive first-row failures) would silently and permanently drop that card's capture,
// with no re-arm path short of the one-off manual scripts used during this investigation
// (kg-reset-hang-victims.ts/kg-rearm-contention-failures.ts). Same bounded-retry shape the
// 'backfill' reason already has (defaultListCandidates' MAX_BACKFILL_RETRY_ATTEMPTS): capped, not
// unbounded or "never".
export const MAX_CLOSED_RETRY_ATTEMPTS = 2

/** Failed rows whose reason is 'closed' or 'reopen' (the live hook's own enqueues, never
 *  'backfill' -- that reason already has its own retry path via defaultListCandidates), with
 *  attempts still under the cap. Oldest-first, same ordering convention as listPendingCaptures. */
export function listRetryableClosedCaptures(
  kgDb: Database.Database,
  limit: number = 20,
  maxAttempts: number = MAX_CLOSED_RETRY_ATTEMPTS,
): CaptureQueueRow[] {
  if (!Number.isInteger(limit) || limit <= 0) return []
  return kgDb
    .prepare(
      `SELECT * FROM kg_capture_queue
       WHERE state = 'failed' AND reason IN ('closed', 'reopen') AND attempts < ?
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(maxAttempts, limit) as CaptureQueueRow[]
}

// All three mark* functions below UPSERT rather than plain-UPDATE: a plain UPDATE is a silent
// no-op when no row exists yet (0 rows affected, no error), which would hide a real call-order bug
// behind "nothing happened" instead of surfacing it -- the row this call describes must exist
// after it returns, whether or not something enqueued it first.

export function markCaptureDone(kgDb: Database.Database, cardId: string, now: number): void {
  kgDb
    .prepare(
      `INSERT INTO kg_capture_queue (card_id, reason, attempts, state, created_at, updated_at)
       VALUES (?, 'closed', 0, 'done', ?, ?)
       ON CONFLICT(card_id) DO UPDATE SET state = 'done', updated_at = excluded.updated_at`,
    )
    .run(cardId, now, now)
}

export function markCaptureFailed(kgDb: Database.Database, cardId: string, error: string, now: number): void {
  const errTrunc = error.slice(0, 2000)
  kgDb
    .prepare(
      `INSERT INTO kg_capture_queue (card_id, reason, attempts, state, last_error, created_at, updated_at)
       VALUES (?, 'closed', 1, 'failed', ?, ?, ?)
       ON CONFLICT(card_id) DO UPDATE SET state = 'failed', attempts = attempts + 1,
         last_error = excluded.last_error, updated_at = excluded.updated_at`,
    )
    .run(cardId, errTrunc, now, now)
}

export function markCaptureSkipped(kgDb: Database.Database, cardId: string, reasonText: string, now: number): void {
  const reasonTrunc = reasonText.slice(0, 2000)
  kgDb
    .prepare(
      `INSERT INTO kg_capture_queue (card_id, reason, attempts, state, last_error, created_at, updated_at)
       VALUES (?, 'closed', 0, 'skipped', ?, ?, ?)
       ON CONFLICT(card_id) DO UPDATE SET state = 'skipped', last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
    )
    .run(cardId, reasonTrunc, now, now)
}
