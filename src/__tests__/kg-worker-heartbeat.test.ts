// Card 1388200c: a worker that never stamps liveness is indistinguishable from one that never
// existed -- this pins the stamp's upsert behaviour and the staleness window the UI/stats route
// relies on (kg.ts's computeKgStats).
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../kg/store.js'
import { recordWorkerHeartbeat, getWorkerHeartbeat, isWorkerActive, WORKER_STALE_SEC } from '../kg/worker-heartbeat.js'

function freshKgDb(): Database.Database {
  const db = new Database(':memory:')
  migrate(db)
  return db
}

describe('worker heartbeat', () => {
  it('getWorkerHeartbeat returns null before any run has stamped', () => {
    const db = freshKgDb()
    expect(getWorkerHeartbeat(db)).toBeNull()
  })

  it('records last_run_at and last_processed, and a later call overwrites (upsert, not append)', () => {
    const db = freshKgDb()
    recordWorkerHeartbeat(db, 1000, 3)
    expect(getWorkerHeartbeat(db)).toEqual({ last_run_at: 1000, last_processed: 3 })
    recordWorkerHeartbeat(db, 2000, 0)
    expect(getWorkerHeartbeat(db)).toEqual({ last_run_at: 2000, last_processed: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM kg_worker_heartbeat').get()).toEqual({ n: 1 })
  })

  it('defaults processed to 0 when omitted (the start-of-run stamp, before any tally exists)', () => {
    const db = freshKgDb()
    recordWorkerHeartbeat(db, 500)
    expect(getWorkerHeartbeat(db)).toEqual({ last_run_at: 500, last_processed: 0 })
  })

  it('isWorkerActive: null heartbeat is never active', () => {
    expect(isWorkerActive(null, 1000)).toBe(false)
  })

  it('isWorkerActive: true just under the staleness window, false just at/over it', () => {
    const hb = { last_run_at: 1000, last_processed: 0 }
    expect(isWorkerActive(hb, 1000 + WORKER_STALE_SEC - 1)).toBe(true)
    expect(isWorkerActive(hb, 1000 + WORKER_STALE_SEC)).toBe(false)
    expect(isWorkerActive(hb, 1000 + WORKER_STALE_SEC + 500)).toBe(false)
  })
})
