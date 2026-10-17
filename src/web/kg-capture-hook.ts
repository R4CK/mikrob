// Route-layer glue for MT-05 (card c991508f): fires right after a kanban move/update request
// actually changes a card's status, same shape as fireKanbanDispatch beside it -- fire-and-forget,
// best-effort, never lets a knowledge-graph problem turn a successful card move into a 500.
//
// Deliberately only ENQUEUES (writes one kg_capture_queue row) rather than running the LLM-calling
// pipeline synchronously inside the HTTP request: capture-pipeline.ts's runCapture shells out to
// Ollama, which the request thread must never block on (the same reasoning local-llm-queue.ts
// documents for its own async split). A separate worker (store/kg-capture-worker.sh, polling this
// queue) drains it -- this file's only job is to make sure the row exists.
//
// KG_CAPTURE_ENABLED is OFF by default (config-registry.ts): `onKanbanCardClosed` no-ops before
// ever touching the kg database file, so a fresh install's move/update behaviour is byte-identical
// to before this card existed, exactly as the MODULTERV's "kapcsoló mögött" rule requires.

import { getEffectiveSettingValue } from '../settings-store.js'
import { logger } from '../logger.js'
import { openKgDb, kgDbPath } from '../kg/store.js'
import { enqueueCapture } from '../kg/capture.js'

function captureEnabled(): boolean {
  try {
    return String(getEffectiveSettingValue('KG_CAPTURE_ENABLED')) === '1'
  } catch {
    return false
  }
}

let kgDbSingleton: ReturnType<typeof openKgDb> | null = null
function kgDb(): ReturnType<typeof openKgDb> {
  if (!kgDbSingleton) kgDbSingleton = openKgDb(kgDbPath())
  return kgDbSingleton
}

/** Call after a move/update request succeeds. No-op unless the transition actually entered 'done'
 *  from something else -- a reorder or an already-done card re-saved must not re-enqueue. */
export function onKanbanCardStatusChanged(cardId: string, prevStatus: string | undefined, nextStatus: unknown): void {
  if (nextStatus !== 'done' || prevStatus === 'done') return
  if (!captureEnabled()) return
  try {
    enqueueCapture(kgDb(), cardId, 'closed', Math.floor(Date.now() / 1000))
  } catch (err) {
    logger.warn({ err, cardId }, 'kg-capture: enqueue failed (card move still succeeded)')
  }
}

/** Test-only: drop the cached handle so a test can point a fresh one at a disposable file. */
export function resetKgDbSingletonForTest(): void {
  if (kgDbSingleton) { kgDbSingleton.close(); kgDbSingleton = null }
}
