// Local-LLM work queue (card defcc189).
//
// The offload path today is SYNCHRONOUS and ONE-SHOT: an agent blocks 15-70s on the 7B, and a card
// only receives a local draft at the dispatch instant. Measured over 740 calls, 87% were that single
// dispatch shot. Blocking is the reason the volume stays low -- every call spends agent time that
// would otherwise go to its own online work, so agents rationally avoid making them.
//
// This module is the state layer for the ASYNC replacement: any source (MikroB dispatch, an agent
// mid-task, a periodic sweep) enqueues and returns immediately; one worker drains the queue behind
// the GPU flock that store/local-llm.sh already owns.
//
// DELIBERATELY DB-ONLY. No Ollama call, no shell-out, no clock of its own -- `now` is injected on
// every write. That keeps the whole state machine unit-testable without a GPU, and it is why the
// worker (which does the I/O) is a separate, thin piece.
//
// SINGLE-WORKER ASSUMPTION, enforced not assumed: claimNext() flips pending -> running inside an
// IMMEDIATE transaction and re-checks the status in the UPDATE's WHERE clause, so two concurrent
// workers can never hand the same row out twice. The GPU flock already serializes the actual model
// call; this keeps the QUEUE honest even if someone starts a second worker by accident.

import type { Database } from 'better-sqlite3'

export type QueueStatus = 'pending' | 'running' | 'done' | 'failed'
export type QueuePriority = 'low' | 'normal' | 'high' | 'urgent'

export interface QueueRow {
  readonly id: number
  readonly agent: string
  readonly card_id: string | null
  readonly task_type: string | null
  readonly template: string | null
  readonly prompt: string
  readonly context: string | null
  readonly priority: QueuePriority
  readonly status: QueueStatus
  readonly source: string
  readonly attempts: number
  readonly created_at: number
  readonly started_at: number | null
  readonly finished_at: number | null
  readonly result: string | null
  readonly error: string | null
}

export interface EnqueueInput {
  readonly agent: string
  readonly prompt: string
  readonly cardId?: string | null
  readonly taskType?: string | null
  readonly template?: string | null
  readonly context?: string | null
  readonly priority?: QueuePriority
  readonly source?: string
}

/** Highest first. Mirrors the kanban ordering agents already reason about. */
const PRIORITY_RANK: Record<QueuePriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
}

/** How many times a row may be handed to the worker before it is abandoned as failed.
 *  Matches the local-llm-offload skill's 3-strikes rule: after three local attempts the task is
 *  the wrong shape for the 7B and belongs to an online agent, not to a fourth retry. */
export const MAX_ATTEMPTS = 3

/** Enqueue one unit of work. Returns the row id immediately -- callers never block on the model. */
export function enqueue(db: Database, input: EnqueueInput, now: number): number {
  const prompt = input.prompt.trim()
  if (!prompt) throw new Error('local-llm queue: prompt is required')
  if (!input.agent.trim()) throw new Error('local-llm queue: agent is required')
  const info = db
    .prepare(
      `INSERT INTO local_llm_queue (agent, card_id, task_type, template, prompt, context, priority, status, source, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?)`,
    )
    .run(
      input.agent.trim(),
      input.cardId ?? null,
      input.taskType ?? null,
      input.template ?? null,
      prompt,
      input.context ?? null,
      input.priority ?? 'normal',
      input.source ?? 'agent',
      now,
    )
  return Number(info.lastInsertRowid)
}

/**
 * Atomically take the next unit of work: highest priority, then oldest.
 *
 * The status re-check in the UPDATE's WHERE is the actual mutual exclusion -- a second worker that
 * selected the same row loses the race and gets null, instead of both running the same prompt.
 */
export function claimNext(db: Database, now: number): QueueRow | null {
  const claim = db.transaction((ts: number): QueueRow | null => {
    const candidate = db
      .prepare(
        `SELECT * FROM local_llm_queue
         WHERE status = 'pending'
         ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                  created_at,
                  id
         LIMIT 1`,
      )
      .get() as QueueRow | undefined
    if (!candidate) return null
    const upd = db
      .prepare(
        `UPDATE local_llm_queue
         SET status = 'running', started_at = ?, attempts = attempts + 1
         WHERE id = ? AND status = 'pending'`,
      )
      .run(ts, candidate.id)
    if (upd.changes === 0) return null // lost the race to another worker
    return db.prepare('SELECT * FROM local_llm_queue WHERE id = ?').get(candidate.id) as QueueRow
  })
  return claim.immediate(now)
}

/** Record a successful run. */
export function complete(db: Database, id: number, result: string, now: number): void {
  db.prepare(
    `UPDATE local_llm_queue SET status = 'done', result = ?, finished_at = ?, error = NULL WHERE id = ?`,
  ).run(result, now, id)
}

/**
 * Record a failed run. Below MAX_ATTEMPTS the row goes back to `pending` for another pass; at the
 * cap it is parked as `failed` so it stops consuming GPU time -- the 3-strikes rule, enforced in the
 * queue rather than left to whoever happens to be reading the log.
 */
export function fail(db: Database, id: number, error: string, now: number): QueueStatus {
  const row = db.prepare('SELECT attempts FROM local_llm_queue WHERE id = ?').get(id) as
    | { attempts: number }
    | undefined
  if (!row) return 'failed'
  const next: QueueStatus = row.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
  db.prepare(
    `UPDATE local_llm_queue SET status = ?, error = ?, finished_at = ? WHERE id = ?`,
  ).run(next, error.slice(0, 2000), next === 'failed' ? now : null, id)
  return next
}

/**
 * Return rows stuck in `running` past `staleMs` to `pending` (or `failed` at the attempt cap).
 *
 * Without this a worker killed mid-run (service restart, OOM, the WSL VM dropping) leaves its row
 * `running` forever: the queue looks busy and that work is silently never done again. The attempts
 * counter was already incremented at claim time, so a crash-looping row still hits the cap instead
 * of being retried indefinitely.
 */
export function reclaimStaleRunning(db: Database, staleMs: number, now: number): number {
  const cutoff = now - staleMs
  const stale = db
    .prepare(`SELECT id, attempts FROM local_llm_queue WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?`)
    .all(cutoff) as Array<{ id: number; attempts: number }>
  const toPending = db.prepare(
    `UPDATE local_llm_queue SET status = 'pending', started_at = NULL, error = ? WHERE id = ?`,
  )
  const toFailed = db.prepare(
    `UPDATE local_llm_queue SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
  )
  const reclaim = db.transaction((rows: Array<{ id: number; attempts: number }>) => {
    for (const r of rows) {
      if (r.attempts >= MAX_ATTEMPTS) toFailed.run('abandoned: worker vanished while running', now, r.id)
      else toPending.run('requeued: worker vanished while running', r.id)
    }
  })
  reclaim(stale)
  return stale.length
}

export function getById(db: Database, id: number): QueueRow | null {
  return (db.prepare('SELECT * FROM local_llm_queue WHERE id = ?').get(id) as QueueRow) ?? null
}

export interface QueueStats {
  readonly pending: number
  readonly running: number
  readonly done: number
  readonly failed: number
  /** Mean wall-clock ms from started_at to finished_at over completed rows; null when none yet. */
  readonly avgLatencyMs: number | null
}

/** Queue depth + mean latency, for the dashboard's local-LLM panel. */
export function stats(db: Database): QueueStats {
  const counts = db
    .prepare(`SELECT status, COUNT(*) AS n FROM local_llm_queue GROUP BY status`)
    .all() as Array<{ status: QueueStatus; n: number }>
  const by = (s: QueueStatus) => counts.find((c) => c.status === s)?.n ?? 0
  const lat = db
    .prepare(
      `SELECT AVG(finished_at - started_at) AS avg FROM local_llm_queue
       WHERE status = 'done' AND started_at IS NOT NULL AND finished_at IS NOT NULL`,
    )
    .get() as { avg: number | null }
  return {
    pending: by('pending'),
    running: by('running'),
    done: by('done'),
    failed: by('failed'),
    avgLatencyMs: lat?.avg == null ? null : Math.round(lat.avg),
  }
}

/** Per-agent counts, so the dashboard can show WHO is under-using the local model. */
export function statsByAgent(db: Database): Array<{ agent: string; pending: number; done: number; failed: number }> {
  return db
    .prepare(
      `SELECT agent,
              SUM(status = 'pending') AS pending,
              SUM(status = 'done')    AS done,
              SUM(status = 'failed')  AS failed
       FROM local_llm_queue
       GROUP BY agent
       ORDER BY agent`,
    )
    .all() as Array<{ agent: string; pending: number; done: number; failed: number }>
}

export { PRIORITY_RANK }
