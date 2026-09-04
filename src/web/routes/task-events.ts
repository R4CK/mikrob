// Task-event + summary feed for the LLM Orchestrator Monitoring dashboard (card a5bbfb98).
//
// Pair-FE: 87be1810 (Fron Ted -- Swimlane Timeline component)
// Pair-BE: a5bbfb98 (this)
//
// CONTRACT FIRST (rule 8b), so the FE can build against it in parallel with a mock:
//
//   GET /api/task-events?from=<epochMs>&to=<epochMs>[&agent=<name>][&limit=<1..2000>]
//     -> { fromMs, toMs, events: TaskEvent[], truncated: boolean }
//        TaskEvent = { id, lane, agent, category, startMs, endMs, durationMs, status, cardId }
//
//   GET /api/task-summary?from=<epochMs>&to=<epochMs>
//     -> { fromMs, toMs, models: ModelUsage[], activeModels, taskCount, failedCount,
//          byCategory: Record<string, number>, avgDurationMs, blockCoverage }
//
// WHY blockCoverage IS PART OF THE CONTRACT AND NOT A FOOTNOTE. Measured on live data while writing
// this: only local-LLM tasks record both a start and an end, so only the "local" lane can draw
// blocks. Online-model work has token counts but no per-task duration stored anywhere -- otel_spans
// looks like the source and is not (9229 rows, 12 closed, zero attributes; see db.ts). A timeline
// that assumed every model had blocks would render empty lanes and read as a bug rather than as the
// honest state, so the endpoint says which lanes it can actually fill.
import { getTaskEvents, getTaskSummary } from '../../db.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const MAX_LIMIT = 2000
const DEFAULT_LIMIT = 500
/** A whole year of blocks is not a timeline, it is an accidental table scan. The cap is on the
 *  WINDOW, not the row count, so a caller gets told the range is too wide instead of silently
 *  receiving a truncated slice that looks complete. */
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000

/** Parse a required epoch-ms query param. Returns null when absent or not a finite integer, so the
 *  caller can answer with a message naming the parameter rather than a bare 400. */
function epochMsParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name)
  if (raw === null || raw.trim() === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null
  return n
}

function badRequest(res: RouteContext['res'], message: string): true {
  // Rule 12: say what is wrong AND what to do, without leaking internals.
  json(res, { error: message }, 400)
  return true
}

export async function tryHandleTaskEvents(ctx: RouteContext): Promise<boolean> {
  const { path, method, url, res } = ctx
  if (method !== 'GET') return false
  if (path !== '/api/task-events' && path !== '/api/task-summary') return false

  const fromMs = epochMsParam(url, 'from')
  const toMs = epochMsParam(url, 'to')
  if (fromMs === null || toMs === null) {
    return badRequest(res, 'A "from" es "to" parameter kotelezo, mindketto epoch MILLISZEKUNDUMBAN (pl. from=1788500000000). Add meg mindkettot.')
  }
  if (toMs <= fromMs) {
    return badRequest(res, 'A "to" legyen nagyobb mint a "from" -- egy nulla vagy negativ hosszu idoablakra nincs mit rajzolni.')
  }
  if (toMs - fromMs > MAX_WINDOW_MS) {
    return badRequest(res, `Az idoablak legfeljebb 31 nap lehet (kertel: ${Math.round((toMs - fromMs) / 86400000)} nap). Szukitsd a tartomanyt.`)
  }

  if (path === '/api/task-summary') {
    json(res, getTaskSummary(fromMs, toMs))
    return true
  }

  const agentRaw = url.searchParams.get('agent')
  const agent = agentRaw !== null && agentRaw.trim() !== '' ? agentRaw.trim() : null

  const limitRaw = url.searchParams.get('limit')
  let limit = DEFAULT_LIMIT
  if (limitRaw !== null && limitRaw.trim() !== '') {
    const n = Number(limitRaw)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      return badRequest(res, `A "limit" egesz szam legyen 1 es ${MAX_LIMIT} kozott.`)
    }
    limit = n
  }

  // Ask for one more than requested: if it comes back, the window really is truncated. Comparing
  // rows.length === limit would report truncation on an exactly-full page that had nothing after it.
  const rows = getTaskEvents(fromMs, toMs, agent, limit + 1)
  const truncated = rows.length > limit
  json(res, { fromMs, toMs, events: truncated ? rows.slice(0, limit) : rows, truncated })
  return true
}
