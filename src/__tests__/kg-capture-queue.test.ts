// MT-05 (card c991508f) queue state layer: capture.ts is DB-only, same split as
// local-llm-queue.ts -- these tests need no subprocess, no mock, just a fresh :memory: kg db.
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../kg/store.js'
import { enqueueCapture, listPendingCaptures, markCaptureDone, markCaptureFailed, markCaptureSkipped } from '../kg/capture.js'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  migrate(db)
  return db
}

describe('kg capture queue', () => {
  it('enqueues a pending row for a closed card', () => {
    const db = freshDb()
    enqueueCapture(db, 'c1', 'closed', 100)
    const rows = listPendingCaptures(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.card_id).toBe('c1')
    expect(rows[0]!.reason).toBe('closed')
    expect(rows[0]!.state).toBe('pending')
    db.close()
  })

  it('re-enqueuing an already-pending card is a no-op (does not reset attempts/created_at)', () => {
    const db = freshDb()
    enqueueCapture(db, 'c1', 'closed', 100)
    enqueueCapture(db, 'c1', 'closed', 200)
    const rows = listPendingCaptures(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.created_at).toBe(100)
    db.close()
  })

  it('re-enqueuing a card that previously finished (done/failed/skipped) resets it to pending', () => {
    const db = freshDb()
    enqueueCapture(db, 'c1', 'closed', 100)
    markCaptureDone(db, 'c1', 150)
    expect(listPendingCaptures(db)).toHaveLength(0)
    enqueueCapture(db, 'c1', 'reopen', 300)
    const rows = listPendingCaptures(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reason).toBe('reopen')
    db.close()
  })

  it('markCaptureFailed increments attempts and records the error', () => {
    const db = freshDb()
    enqueueCapture(db, 'c1', 'closed', 100)
    markCaptureFailed(db, 'c1', 'boom', 200)
    const row = db.prepare('SELECT * FROM kg_capture_queue WHERE card_id = ?').get('c1') as
      { state: string; attempts: number; last_error: string }
    expect(row.state).toBe('failed')
    expect(row.attempts).toBe(1)
    expect(row.last_error).toBe('boom')
    db.close()
  })

  it('markCaptureSkipped records a state=skipped row', () => {
    const db = freshDb()
    enqueueCapture(db, 'c1', 'closed', 100)
    markCaptureSkipped(db, 'c1', 'no REVIEW comment', 200)
    const row = db.prepare('SELECT state FROM kg_capture_queue WHERE card_id = ?').get('c1') as { state: string }
    expect(row.state).toBe('skipped')
    db.close()
  })

  // RedHat 23045 B1 / 23081 item 1: backfill.ts's MAX_BACKFILL_RETRY_ATTEMPTS cap only means
  // anything if attempts actually accumulates across backfill retries -- these pin that exact
  // behaviour at the capture.ts layer (not just via defaultListCandidates' raw-SQL-seeded rows).
  it('re-enqueuing a BACKFILL retry of a BACKFILL-failed row KEEPS the attempts count', () => {
    const db = freshDb()
    enqueueCapture(db, 'c1', 'backfill', 100)
    markCaptureFailed(db, 'c1', 'boom', 150)
    enqueueCapture(db, 'c1', 'backfill', 200)
    const row = db.prepare('SELECT attempts, state, reason FROM kg_capture_queue WHERE card_id = ?').get('c1') as {
      attempts: number
      state: string
      reason: string
    }
    expect(row.attempts).toBe(1)
    expect(row.state).toBe('pending')
    expect(row.reason).toBe('backfill')
    db.close()
  })

  it('a SECOND backfill failure accumulates to attempts=2, reaching the retry cap', () => {
    const db = freshDb()
    enqueueCapture(db, 'c1', 'backfill', 100)
    markCaptureFailed(db, 'c1', 'boom', 150)
    enqueueCapture(db, 'c1', 'backfill', 200)
    markCaptureFailed(db, 'c1', 'boom again', 250)
    const row = db.prepare('SELECT attempts FROM kg_capture_queue WHERE card_id = ?').get('c1') as { attempts: number }
    expect(row.attempts).toBe(2)
    db.close()
  })

  it('re-enqueuing a CLOSED/REOPEN re-arm still resets attempts to 0 (new content, not a backfill retry)', () => {
    const db = freshDb()
    enqueueCapture(db, 'c1', 'backfill', 100)
    markCaptureFailed(db, 'c1', 'boom', 150)
    enqueueCapture(db, 'c1', 'reopen', 200)
    const row = db.prepare('SELECT attempts, reason FROM kg_capture_queue WHERE card_id = ?').get('c1') as {
      attempts: number
      reason: string
    }
    expect(row.attempts).toBe(0)
    expect(row.reason).toBe('reopen')
    db.close()
  })

  it('a backfill re-arm of a row that failed for a DIFFERENT reason (closed) resets attempts to 0', () => {
    const db = freshDb()
    enqueueCapture(db, 'c1', 'closed', 100)
    markCaptureFailed(db, 'c1', 'boom', 150)
    enqueueCapture(db, 'c1', 'backfill', 200)
    const row = db.prepare('SELECT attempts FROM kg_capture_queue WHERE card_id = ?').get('c1') as { attempts: number }
    expect(row.attempts).toBe(0)
    db.close()
  })
})
