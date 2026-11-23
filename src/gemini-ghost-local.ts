// Ghost pipeline on the local LLM, off the Gemini budget (card 0291283d, Peti Telegram 14354).
//
// WHY: measured 2026-11-20, 162 of 164 rows in store/seged-hivo-naplo.jsonl were Ghost
// (ranking/review) calls sharing the paid 5/hour Gemini window via gemini-ghost-budget.ts, while
// only 1 real card-coding Gemini call happened since 2026-10-25. Ghost has no budget of its own
// and must not spend the coding budget -- see memory ghost-to-local-llm-gemini-in-coding-chain-
// decision.
//
// This module is the drop-in replacement for the `callGemini`/`reserveSlot`/`releaseSlot`/
// `recordDetail` injection points decideGeminiOrder (gemini-orchestrator.ts) and reviewOneCard
// (gemini-orchestrator-draft-review.ts) already take -- neither of those functions changes shape,
// only what gets injected at the sweep-wrapper call sites does.
//
// NO seged-hivo-naplo.jsonl ROW, ON PURPOSE: that log and its 'agy-ghost' tag exist to meter the
// shared Gemini hourly/daily budget (gemini-ghost-budget.ts). A local call spends no Gemini quota,
// so recording it there would be a false budget-consumption entry for a call that never reached
// Gemini. Diagnostic logging goes to llm_ledger only (provider='local'), same table
// recordGhostCallDetail already writes to via llm-ledger-append.py, just without the
// seged-hivo-naplo.jsonl half.
import { execFileSync, spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GeminiCallOptions, GeminiResult } from './gemini-client.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const STORE = join(ROOT, 'store')

const LOCAL_LLM_SCRIPT = join(STORE, 'local-llm.sh')
const LEDGER_APPEND_SCRIPT = join(STORE, 'llm-ledger-append.py')

/** The pinned model for Ghost's local calls (Peti Telegram 14354) -- a named export so tests and
 *  the llm_ledger rows below can both refer to the SAME value, never a second hand-typed copy. */
export const GHOST_LOCAL_MODEL = process.env.GEMINI_GHOST_LOCAL_MODEL
  ?? 'hf.co/bigatuna/Qwen3.5-9b-Sushi-Coder-RL-GGUF:Q4_K_M'

// local-llm.sh's own curl timeout (store/local-llm.sh LOCAL_LLM_TIMEOUT) defaults to 120s; this
// outer ceiling leaves margin for the GPU lock wait ahead of it (same "outer > inner" shape as
// capture-pipeline.ts's defaultDraftFn, card c84a510a round 2).
const CALL_TIMEOUT_MS = 180_000

/**
 * Calls the LOCAL model for a Ghost ranking/review prompt. Same `(opts) => Promise<GeminiResult>`
 * shape callGemini already has, so it plugs into decideGeminiOrder/reviewOneCard unchanged.
 * local-llm.sh exit codes (store/local-llm.sh header): 0 ok | 2 ollama down | 3 model missing |
 * 4 bad usage | 5 api error | 6 gpu lock busy. Exit 6 maps to reason='gpu_busy' -- the caller
 * must treat that as "wait/skip", never as a reason to call Gemini instead (there is no Gemini
 * fallback wired here at all, which is the structural guarantee, not just a convention).
 */
export async function callLocalLlmForGhost(opts: GeminiCallOptions): Promise<GeminiResult> {
  try {
    const text = execFileSync(
      LOCAL_LLM_SCRIPT,
      ['--model', GHOST_LOCAL_MODEL, '--caller', 'quota-bridge-ghost', opts.prompt],
      { encoding: 'utf-8', timeout: CALL_TIMEOUT_MS },
    )
    const trimmed = text.trim()
    if (!trimmed) return { ok: false, reason: 'bad_response', detail: 'local-llm.sh returned empty output' }
    return { ok: true, text: trimmed }
  } catch (err) {
    const status = (err as { status?: number | null }).status
    if (status === 6) return { ok: false, reason: 'gpu_busy', detail: 'local-llm.sh GPU lock busy' }
    if (status === 3) return { ok: false, reason: 'model_missing', detail: `local-llm.sh exit ${status}` }
    if (status === 2) return { ok: false, reason: 'network', detail: 'local-llm.sh: ollama down' }
    return { ok: false, reason: 'bad_response', detail: `local-llm.sh exit ${status ?? 'unknown'}: ${String(err)}` }
  }
}

/** Always available: local calls are serialized by local-llm.sh's own GPU flock (exit 6 on
 *  contention), not by the shared Gemini hourly/daily budget -- there is nothing to reserve or
 *  release here. Matches decideGeminiOrder/reviewOneCard's `reserveSlot`/`releaseSlot` injection
 *  shape so the sweep wrappers can pass it in directly. */
export function alwaysAvailableSlot(): boolean {
  return true
}

export interface LocalGhostCallDetail {
  model: string
  durationMs: number
  outcome: 'ok' | 'error' | 'blocked'
  totalTokens?: number
  taskType: string
}

/**
 * Diagnostic-only (same convention as recordGhostCallDetail: a failure here must never change
 * whether the caller's own result counts as success/failure). Writes ONLY to llm_ledger
 * (provider='local') -- no seged-hivo-naplo.jsonl row, see module header for why.
 */
export function recordLocalGhostCallDetail(
  _hivasId: string,
  cardId: string,
  detail: LocalGhostCallDetail,
): boolean {
  try {
    const okFlag = detail.outcome === 'ok' ? ['--ok'] : ['--fail', '--fail-reason', detail.outcome]
    const result = spawnSync(
      'python3',
      [LEDGER_APPEND_SCRIPT, '--agent', 'quota-bridge-ghost', '--task-type', detail.taskType,
       '--provider', 'local', '--model', detail.model, ...okFlag,
       '--latency-ms', String(Math.round(detail.durationMs)), '--card', cardId],
      { timeout: 10_000 },
    )
    return !result.error && result.status === 0
  } catch {
    return false
  }
}
