import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../../config.js'
import { logger } from '../../logger.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// BE contract for card 64788453 (Peti 11248-11287): read-only view over the seged-hivo.py JSONL
// ledger (store/seged-hivo-naplo.jsonl), scoped to the "agy" (Gemini) engine only -- the dashboard
// panel for this is card 57da740c (Pair-FE), built in parallel against this exact shape
// (contract-first-codev). The prompt's CONTENT never reaches this route: the ledger itself only
// ever carries `prompt_sha256` (see scripts/seged-hivo.py), never the prompt text.

const LOG_FILE = join(STORE_DIR, 'seged-hivo-naplo.jsonl')
const STOP_FILE = join(STORE_DIR, 'seged-hivo-STOP.json')
const ENGINE = 'agy'
/** Fleet-wide, rolling-60-minute cap enforced by store/gemini-agy-call.sh -- mirrored here READ-ONLY
 *  so the dashboard can show the SAME number the wrapper gates on, without re-deriving it from a
 *  different rule. */
export const HOURLY_LIMIT = 5
const WINDOW_MS = 60 * 60 * 1000

interface RawRow {
  tipus?: string
  ido?: string
  hivas_id?: string
  hivas?: string
  hivo?: string
  kartya?: string
  seged?: string
  modell?: string
  feladattipus?: string
  status?: string
  duracio_s?: number
  tokens_total?: number | null
  eredmeny?: string
  pont?: number
  velemeny?: string
}

export interface GeminiCallRow {
  ts: number
  model: string
  caller: string
  cardId: string
  taskType: string
  status: string
  durationS: number | null
  tokens: number | null
  rating: { result: string; score: number; opinion: string } | null
}

export interface GeminiCallsSummaryBucket {
  calls: number
  ok: number
  error: number
  blocked: number
}

export interface GeminiCallsResponse {
  quota: { used: number; limit: number; windowStart: number; nextFreeAt: number | null }
  stop: { active: boolean; reason: string | null }
  calls: GeminiCallRow[]
  summary: { byModel: Record<string, GeminiCallsSummaryBucket>; byTaskType: Record<string, GeminiCallsSummaryBucket> }
}

/** Parse the ledger's lines, skipping anything that is not a JSON object (a truncated last line,
 *  stray `[1,2]`, ...) -- matches scripts/seged-hivo.py's own `read_log` tolerance: one bad byte
 *  must not take the whole endpoint down. */
export function parseLedgerLines(lines: string[]): RawRow[] {
  const rows: RawRow[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push(parsed as RawRow)
    } catch {
      // malformed line -- skipped, not fatal (same tolerance as the Python reader)
    }
  }
  return rows
}

/** One row per actual call, last-row-wins per `hivas_id` (older rows only have `ido`) -- mirrors
 *  scripts/seged-hivo.py's `calls_of`: a `status=started` row alone (process killed mid-run) still
 *  counts, a later `ok`/`error`/`blocked` row for the same id replaces it. Rating rows
 *  (`tipus==='ertekeles'`) are never calls and are excluded here. */
export function dedupeCalls(rows: RawRow[]): RawRow[] {
  const last = new Map<string, RawRow>()
  for (const row of rows) {
    if (row.tipus === 'ertekeles') continue
    const key = row.hivas_id ?? row.ido ?? ''
    last.set(key, row)
  }
  return [...last.values()]
}

/** The last rating recorded against a call's `ido` (a call may be rated more than once; the most
 *  recent `--ertekel` wins, same as scripts/seged-hivo.py's own `summary`). */
export function latestRatings(rows: RawRow[]): Map<string, RawRow> {
  const ratings = new Map<string, RawRow>()
  for (const row of rows) {
    if (row.tipus === 'ertekeles' && row.hivas) ratings.set(row.hivas, row)
  }
  return ratings
}

function toEpochMs(iso: string | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/** Agy-only call rows, newest first, shaped for the FE contract. `nowMs` is injectable for tests. */
export function buildCallRows(allRows: RawRow[], nowMs: number): GeminiCallRow[] {
  const ratings = latestRatings(allRows)
  const calls = dedupeCalls(allRows).filter((r) => r.seged === ENGINE)
  const shaped: GeminiCallRow[] = []
  for (const call of calls) {
    const ts = toEpochMs(call.ido)
    if (ts === null) continue
    const rating = call.ido ? ratings.get(call.ido) : undefined
    shaped.push({
      ts,
      model: call.modell ?? '',
      caller: call.hivo ?? '',
      cardId: call.kartya ?? '',
      taskType: call.feladattipus ?? '',
      status: call.status ?? 'ismeretlen',
      durationS: typeof call.duracio_s === 'number' ? call.duracio_s : null,
      tokens: typeof call.tokens_total === 'number' ? call.tokens_total : null,
      rating: rating
        ? { result: rating.eredmeny ?? '', score: rating.pont ?? 0, opinion: rating.velemeny ?? '' }
        : null,
    })
  }
  shaped.sort((a, b) => b.ts - a.ts)
  return shaped
}

/** Fleet-wide rolling quota over the last {@link WINDOW_MS}: how many non-blocked agy calls have
 *  gone out, and when the OLDEST one in the window ages out (the next free slot), mirroring
 *  store/gemini-agy-call.sh's own count exactly (status!=='blocked', engine==='agy'). */
export function computeQuota(
  calls: GeminiCallRow[],
  nowMs: number,
): { used: number; limit: number; windowStart: number; nextFreeAt: number | null } {
  const windowStart = nowMs - WINDOW_MS
  const inWindow = calls.filter((c) => c.ts >= windowStart).sort((a, b) => a.ts - b.ts)
  const used = inWindow.length
  const nextFreeAt = used >= HOURLY_LIMIT ? inWindow[0]!.ts + WINDOW_MS : null
  return { used, limit: HOURLY_LIMIT, windowStart, nextFreeAt }
}

function bump(bucket: Record<string, GeminiCallsSummaryBucket>, key: string, status: string): void {
  const b = (bucket[key] ??= { calls: 0, ok: 0, error: 0, blocked: 0 })
  b.calls += 1
  if (status === 'ok') b.ok += 1
  else if (status === 'blocked') b.blocked += 1
  else b.error += 1
}

export function buildSummary(
  calls: GeminiCallRow[],
): { byModel: Record<string, GeminiCallsSummaryBucket>; byTaskType: Record<string, GeminiCallsSummaryBucket> } {
  const byModel: Record<string, GeminiCallsSummaryBucket> = {}
  const byTaskType: Record<string, GeminiCallsSummaryBucket> = {}
  for (const c of calls) {
    bump(byModel, c.model || 'ismeretlen', c.status)
    bump(byTaskType, c.taskType || 'ismeretlen', c.status)
  }
  return { byModel, byTaskType }
}

/** store/gemini-agy-call.sh's own STOP file (shared with scripts/seged-hivo.py: a 403/429 answer
 *  sets it, every call is refused until a human deletes it). Read-only here, same fail-soft shape
 *  every other optional-file reader in this codebase uses: unreadable/unparsable -> active with a
 *  generic reason rather than silently reporting "not active" for a flag that IS set. */
function readStopState(): { active: boolean; reason: string | null } {
  if (!existsSync(STOP_FILE)) return { active: false, reason: null }
  try {
    const raw = readFileSync(STOP_FILE, 'utf-8')
    try {
      const doc = JSON.parse(raw) as { minta?: string; hivas?: string; seged?: string; modell?: string }
      return { active: true, reason: doc.minta ? `${doc.seged ?? ''}:${doc.modell ?? ''} -> ${doc.minta}` : raw.slice(0, 200) }
    } catch {
      return { active: true, reason: raw.slice(0, 200) }
    }
  } catch (err) {
    logger.warn({ err, file: STOP_FILE }, 'gemini-calls: STOP file unreadable, treating as active')
    return { active: true, reason: 'STOP fájl nem olvasható' }
  }
}

function readLedgerRows(): RawRow[] {
  if (!existsSync(LOG_FILE)) return []
  try {
    return parseLedgerLines(readFileSync(LOG_FILE, 'utf-8').split('\n'))
  } catch (err) {
    logger.warn({ err, file: LOG_FILE }, 'gemini-calls: ledger unreadable')
    return []
  }
}

export async function tryHandleGeminiCalls(ctx: RouteContext): Promise<boolean> {
  const { path, method, res } = ctx
  if (path !== '/api/gemini-calls' || method !== 'GET') return false

  const nowMs = Date.now()
  const allRows = readLedgerRows()
  const calls = buildCallRows(allRows, nowMs)
  const response: GeminiCallsResponse = {
    quota: computeQuota(calls, nowMs),
    stop: readStopState(),
    calls,
    summary: buildSummary(calls),
  }
  json(res, response)
  return true
}
