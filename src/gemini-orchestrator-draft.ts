// Gemini orchestrator draft loop (card 21fbc293, slice 2/4 of cf757409).
//
// SCOPE: drives the EXISTING local-LLM draft engine (store/offload-dispatch.sh) one card at a
// time, in the order 1/4 (gemini-orchestrator.ts) proposed and persisted to
// store/gemini-orchestrator-queue.json. This module does NOT reimplement drafting -- it only
// decides WHICH card to call the existing machinery on, and WHEN (kill switch + route gated,
// same shape as 1/4). It never reads card content itself: the card id is the only thing that
// crosses this module's own boundary into the subprocess; offload-dispatch.sh is the one that
// resolves and sees the actual card title/description, exactly as it already does for a normal,
// Claude-driven dispatch.
//
// DECISION B (parent cf757409, Peti 11162/11164): while this loop drives offload-dispatch.sh, the
// draft text itself must never land in a kanban comment -- it goes to disk under
// store/drafts/<cardId>/, and the card gets only a short referencing comment. This is implemented
// on offload-dispatch.sh's side (OFFLOAD_DRAFT_SINK=file, see post_draft_comment() there); this
// module's only job is to set that env var when it spawns the subprocess.
//
// FAIL-CLOSED SHAPE (mirrors gemini-orchestrator.ts): kill switch OFF by default, route must be
// exactly "gemini", a missing/malformed queue is a no-op (never "drive nothing" silently confused
// with "drive everything"). Per-card: a timeout or non-zero exit is recorded and the loop moves on
// to the next id -- one wedged card must never stall every other card behind it in the order.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { isGeminiOrchestratorEnabled, readFallbackRoute } from './gemini-orchestrator.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const STORE = join(ROOT, 'store')

const QUEUE_PATH = join(STORE, 'gemini-orchestrator-queue.json')
const OFFLOAD_DISPATCH_SCRIPT = join(STORE, 'offload-dispatch.sh')

// The local-llm-rag.sh advisory path a single leaf can take is itself documented (offload-
// dispatch.sh's try_leaf) as running up to ~120s; a ceiling well above that turns a genuinely
// wedged subprocess (not just a slow one) into a fail-closed "skip this card" instead of hanging
// the whole sweep on it.
const DRAFT_TIMEOUT_MS = 180_000

export interface QueueOrder {
  order: string[]
  decidedAt: number
}

/**
 * Reads 1/4's proposed order. Fail-closed: anything but a well-formed {order: string[], decidedAt:
 * number} returns null -- a missing file, corrupt/partial JSON, or a wrong shape are all treated
 * the same as "no queue available", never as "drive an empty/garbage list".
 */
export function readQueueOrder(): QueueOrder | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(QUEUE_PATH, 'utf-8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.order) || !obj.order.every((x) => typeof x === 'string')) return null
  if (typeof obj.decidedAt !== 'number') return null
  return { order: obj.order as string[], decidedAt: obj.decidedAt }
}

export interface DraftCardResult {
  id: string
  ok: boolean
  reason?: string
}

/**
 * Drives the existing local-LLM draft engine for exactly one card id. Sets OFFLOAD_DRAFT_SINK=file
 * (decision B) so the draft lands on disk, not in a kanban comment. Fail-closed on anything but a
 * clean exit 0: a timeout, a crash, or any non-zero exit is reported as not-ok and the caller moves
 * on -- this function never throws.
 */
export function runDraftForCard(
  cardId: string,
  spawn: typeof spawnSync = spawnSync,
): DraftCardResult {
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawn('bash', [OFFLOAD_DISPATCH_SCRIPT, cardId], {
      encoding: 'utf-8',
      timeout: DRAFT_TIMEOUT_MS,
      env: { ...process.env, OFFLOAD_DRAFT_SINK: 'file', OFFLOAD_NO_GEMINI: '1' },
    })
  } catch (err) {
    return { id: cardId, ok: false, reason: `spawn_threw: ${String(err)}` }
  }
  if (result.error) return { id: cardId, ok: false, reason: String(result.error) }
  if (result.status !== 0) return { id: cardId, ok: false, reason: `exit_${result.status ?? 'null'}` }
  return { id: cardId, ok: true }
}

export interface DraftSweepSummary {
  ran: boolean
  reason?: string
  results?: DraftCardResult[]
}

/**
 * I/O wrapper (mirrors runGeminiOrchestratorSweep's shape in gemini-orchestrator.ts): checks the
 * kill switch and route before doing anything, reads 1/4's proposed order, then drives
 * offload-dispatch.sh for every id IN THAT ORDER, one at a time (the local model is single-slot,
 * same constraint offload-dispatch.sh's own OFFLOAD_MAX_SUBTASKS comment documents -- this loop
 * does not parallelize). A single card's failure/timeout does not stop the sweep; it is recorded
 * in the summary and the loop continues to the next id.
 */
export function runGeminiOrchestratorDraftSweep(
  readQueue: () => QueueOrder | null = readQueueOrder,
  runOne: (id: string) => DraftCardResult = runDraftForCard,
): DraftSweepSummary {
  if (!isGeminiOrchestratorEnabled()) {
    console.log('[gemini-orchestrator-draft] kill switch is OFF -- no-op.')
    return { ran: false, reason: 'kill_switch_off' }
  }
  if (readFallbackRoute() !== 'gemini') {
    console.log('[gemini-orchestrator-draft] route is not gemini -- no-op.')
    return { ran: false, reason: 'not_gemini_route' }
  }

  const queue = readQueue()
  if (!queue || queue.order.length === 0) {
    console.log('[gemini-orchestrator-draft] no queue order available -- no-op.')
    return { ran: false, reason: 'no_queue' }
  }

  const results: DraftCardResult[] = []
  for (const id of queue.order) {
    results.push(runOne(id))
  }
  const okCount = results.filter((r) => r.ok).length
  console.log(`[gemini-orchestrator-draft] drove ${results.length} card(s), ${okCount} ok.`)
  return { ran: true, results }
}

/** Entry-point body, extracted (mirrors gemini-orchestrator.ts's runAsEntryPoint) so it is directly
 *  testable without the module-load-time process.argv guard below ever firing in a test. */
export function runAsEntryPoint(): void {
  try {
    runGeminiOrchestratorDraftSweep()
    process.exit(0)
  } catch (err) {
    console.error('[gemini-orchestrator-draft] Fatal:', err)
    process.exit(1)
  }
}

// Entry point when run directly: node dist/gemini-orchestrator-draft.js
if (process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^.*[/\\]/, '/'))) {
  runAsEntryPoint()
}
