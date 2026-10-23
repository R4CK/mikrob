// MT-06 (card 7c9be2d8): backfill existing 'done' cards into the knowledge graph in batches,
// gated on GPU load, through the SAME capture pipeline MT-05 (c991508f) already proved on
// EK-MT-2/3/4. This file is only the selection + batch loop; the actual LLM draft + graph write
// is runCapture (capture-pipeline.ts) -- the live hook and this backfill must never be two
// implementations of one rule, same reasoning as scripts/kanban-relations-backfill.ts.
//
// EK-MT-12 is the behaviour this module must prove: processed/active/draft/failed counts and
// wall-time logged, and the GPU-hold tier (root CLAUDE.md rule 16, "a GPU-kapu tartása alatt nem
// indul helyi modellhívás") stops the batch BEFORE the next local-LLM call, never falls back to
// an online model (MODULTERV section 5: capture is local-only, no Gemini/online in this path).

import type Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { getEffectiveSettingValue } from '../settings-store.js'
import { enqueueCapture } from './capture.js'
import type { CaptureRunResult } from './capture-pipeline.js'

const MARVEEN_MAIN = process.env.MARVEEN_MAIN || '/home/neon/marveen'
const GPU_GATE_TIMEOUT_MS = 10_000

export interface GpuGateResult {
  readonly admit: boolean
  readonly detail: string
}

export interface BackfillDeps {
  captureEnabled: () => boolean
  listCandidates: (limit: number) => readonly string[]
  gpuGate: () => GpuGateResult
  runOne: (cardId: string) => CaptureRunResult
  now: () => number
}

export interface BackfillBatchResult {
  readonly candidates: number
  readonly processed: number
  readonly active: number
  readonly draft: number
  readonly failed: number
  readonly skipped: number
  readonly haltedOnGpuHold: boolean
  readonly captureDisabled: boolean
  readonly elapsedSec: number
}

/** Same switch and same fail-closed-on-error reading as kg-capture-hook.ts's captureEnabled --
 *  the backfill writer must respect KG_CAPTURE_ENABLED exactly like the live close-time hook,
 *  not bypass it as a third, unguarded writer (RedHat 23045, X1). */
export function defaultCaptureEnabled(): boolean {
  try {
    return String(getEffectiveSettingValue('KG_CAPTURE_ENABLED')) === '1'
  } catch {
    return false
  }
}

/** 'done' cards not yet in kg_capture_queue, oldest first. Whether a card actually has a REVIEW
 *  comment is left to runCapture to decide (it already marks a card without one 'skipped') --
 *  duplicating that check here would be a second place that has to agree with the first.
 *  Checks the limit BEFORE pushing (RedHat 23045, X2): an invalid limit (NaN, 0, negative) yields
 *  zero candidates instead of the unbounded "NaN >= length never breaks" behaviour. */
export function defaultListCandidates(
  mainDb: Database.Database,
  kgDb: Database.Database,
  limit: number,
): readonly string[] {
  if (!Number.isInteger(limit) || limit <= 0) return []
  const queued = new Set(
    (kgDb.prepare('SELECT card_id FROM kg_capture_queue').all() as { card_id: string }[]).map(
      (r) => r.card_id,
    ),
  )
  const done = mainDb
    .prepare(`SELECT id FROM kanban_cards WHERE status = 'done' ORDER BY created_at ASC`)
    .all() as { id: string }[]
  const out: string[] = []
  for (const row of done) {
    if (out.length >= limit) break
    if (queued.has(row.id)) continue
    out.push(row.id)
  }
  return out
}

/** Shells out to the same vram-guard-check.sh every other local-first caller asks (offload-
 *  dispatch.sh, local-llm-rag.sh) -- one gate, not a second opinion. execFileSync throws on a
 *  non-zero exit (HOLD, rc=1); Node still attaches the captured stdout to the thrown error when
 *  `encoding` is set, so the HOLD detail line is not lost. */
export function defaultGpuGate(scriptPath: string = `${MARVEEN_MAIN}/store/vram-guard-check.sh`): GpuGateResult {
  try {
    const out = execFileSync('bash', [scriptPath], { encoding: 'utf8', timeout: GPU_GATE_TIMEOUT_MS }).trim()
    return { admit: true, detail: out }
  } catch (err) {
    const withStdout = err as { stdout?: string | Buffer }
    const detail = withStdout.stdout
      ? String(withStdout.stdout).trim()
      : err instanceof Error
        ? err.message
        : String(err)
    return { admit: false, detail }
  }
}

function tallyNodeStatuses(kgDb: Database.Database, ids: readonly string[]): { active: number; draft: number } {
  let active = 0
  let draft = 0
  for (const id of ids) {
    const row = kgDb.prepare('SELECT status FROM kg_nodes WHERE id = ?').get(id) as
      | { status: string }
      | undefined
    if (row?.status === 'active') active++
    else draft++
  }
  return { active, draft }
}

/** One batch: up to `limit` candidates, GPU gate checked before EVERY local-LLM call (not just
 *  once at the start) -- a long-running batch can see the GPU go from free to loaded partway
 *  through. On HOLD the loop stops outright rather than skipping to the next candidate: the
 *  pressure is a property of the GPU, not of any one card, so the rest of the batch would almost
 *  certainly hold too, and skip-and-continue would silently re-check the gate hundreds of times
 *  for nothing. The already-processed count in the result is what ran before the hold. */
export function runBackfillBatch(kgDb: Database.Database, limit: number, deps: BackfillDeps): BackfillBatchResult {
  const started = deps.now()
  if (!deps.captureEnabled()) {
    return {
      candidates: 0,
      processed: 0,
      active: 0,
      draft: 0,
      failed: 0,
      skipped: 0,
      haltedOnGpuHold: false,
      captureDisabled: true,
      elapsedSec: deps.now() - started,
    }
  }
  const candidates = deps.listCandidates(limit)
  let processed = 0
  let active = 0
  let draft = 0
  let failed = 0
  let skipped = 0
  let haltedOnGpuHold = false

  for (const cardId of candidates) {
    const gate = deps.gpuGate()
    if (!gate.admit) {
      haltedOnGpuHold = true
      break
    }
    enqueueCapture(kgDb, cardId, 'backfill', deps.now())
    const result = deps.runOne(cardId)
    processed++
    if (result.outcome === 'captured') {
      const t = tallyNodeStatuses(kgDb, result.solutionIds)
      active += t.active
      draft += t.draft
    } else if (result.outcome === 'failed') {
      failed++
    } else {
      skipped++
    }
  }

  return {
    candidates: candidates.length,
    processed,
    active,
    draft,
    failed,
    skipped,
    haltedOnGpuHold,
    captureDisabled: false,
    elapsedSec: deps.now() - started,
  }
}
