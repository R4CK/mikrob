/**
 * Card c84a510a: one-off re-arm for the 6 kg_capture_queue rows that hit the kg-capture
 * generation-hang (failed, attempts=1, ETIMEDOUT/ollama-timeout) before the DRAFT_CALL_TIMEOUT_MS
 * fix. They are stuck for good otherwise: defaultListCandidates excludes any queued card_id
 * whose reason isn't 'backfill', and listPendingCaptures only reads state='pending' rows -- a
 * failed row with reason='closed' matches neither, so nothing will ever re-try it on its own.
 * enqueueCapture(..., 'closed', ...) is the existing, tested re-arm path (capture.ts): same
 * reason it already had, resets attempts to 0 and state to 'pending'.
 */
import { openKgDb } from '../src/kg/store.js'
import { enqueueCapture } from '../src/kg/capture.js'

const STUCK = ['03f15aca', '2a15eb5f', '54c980f1', '603bfce8', '9d1ee327', 'acffb1d6']

const db = openKgDb(process.argv[2])
const now = Math.floor(Date.now() / 1000)

for (const id of STUCK) {
  const before = db.prepare('SELECT state, reason, attempts FROM kg_capture_queue WHERE card_id = ?').get(id)
  enqueueCapture(db, id, 'closed', now)
  const after = db.prepare('SELECT state, reason, attempts FROM kg_capture_queue WHERE card_id = ?').get(id)
  console.log(id, 'before=', JSON.stringify(before), 'after=', JSON.stringify(after))
}
db.close()
