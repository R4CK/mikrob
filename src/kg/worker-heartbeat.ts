// Card 1388200c: the Megoldás-tár UI claimed a backfill was "running" (kg.empty.backfill_running)
// while no worker ever existed to run it (src/web/kg-capture-hook.ts's promised
// store/kg-capture-worker.sh never existed). A single-row liveness stamp, written at the START of
// every worker invocation (store/kg-capture-worker.sh -> scripts/kg-backfill.ts ->
// backfill-cli.ts), lets the stats route (kg.ts) tell "a worker ran recently" from "nothing has
// ever drained this queue" -- the UI can then show the real state instead of an assumed one.

import type Database from 'better-sqlite3'

export interface WorkerHeartbeat {
  readonly last_run_at: number
  readonly last_processed: number
}

/** Upserts the single heartbeat row. Called at the START of a run (before any candidate is
 *  processed) so even a zero-candidate run proves the worker is alive -- the alternative (stamping
 *  only after a successful batch) would make a quiet night look identical to a dead worker. */
export function recordWorkerHeartbeat(kgDb: Database.Database, now: number, processed: number = 0): void {
  kgDb
    .prepare(
      `INSERT INTO kg_worker_heartbeat (id, last_run_at, last_processed) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_run_at = excluded.last_run_at, last_processed = excluded.last_processed`,
    )
    .run(now, processed)
}

export function getWorkerHeartbeat(kgDb: Database.Database): WorkerHeartbeat | null {
  return (kgDb.prepare('SELECT last_run_at, last_processed FROM kg_worker_heartbeat WHERE id = 1').get() as
    | WorkerHeartbeat
    | undefined) ?? null
}

/** A worker scheduled every 10 minutes (store/kg-capture-worker.sh's cron cadence) that hasn't
 *  stamped in this long is not "between runs" anymore -- it is stopped, crashed, or never started.
 *  2x the schedule interval, same margin reclaimStaleRunning/STALE_RUNNING_MS use elsewhere for
 *  "worker probably dead" thresholds. */
export const WORKER_STALE_SEC = 20 * 60

export function isWorkerActive(heartbeat: WorkerHeartbeat | null, now: number): boolean {
  if (!heartbeat) return false
  return now - heartbeat.last_run_at < WORKER_STALE_SEC
}
