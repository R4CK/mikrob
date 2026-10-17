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
})
