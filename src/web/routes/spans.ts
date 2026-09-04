import { upsertOtelSpan, closeOtelSpanIfOpen, getOtelSpan, getOtelTrace, listOtelTraces } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import { isKnownAgent } from '../agent-config.js'
import { isReservedSenderId } from '../system-directive-id.js'
import { sanitizeAgentIdent } from '../../prompt-safety.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

const SPAN_STATUSES = ['ok', 'error', 'timeout', 'running'] as const
type SpanStatus = (typeof SPAN_STATUSES)[number]

/** A millisecond wall-clock stamp. Rejects NaN/Infinity/negatives and non-numbers (a JSON body can
 *  carry a string or an object here just as easily as a number). */
function isMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

/**
 * Who a span may be ATTRIBUTED to over HTTP. Card 63beeb8a.
 *
 * Deliberately the SAME rule POST /api/messages applies to `from`, and for the same reason: on the
 * router path a span's agent_id IS a message's from_agent, so the two must not disagree about who
 * may claim to be whom. The shared Bearer token is readable by every sub-agent, so without this any
 * token holder could file spans attributed to an arbitrary or reserved identity -- and this table
 * is being built to become an alerting base, where a forged or misattributed row is the whole
 * problem.
 *
 * The reserved in-process ids ('system', 'system-directive') are refused here exactly as they are
 * there: legitimate when the router writes them in-process, never a claim an HTTP caller gets to
 * make. Returns the rejection reason, or null when the id is acceptable.
 */
function rejectAgentId(agentId: string): string | null {
  const id = sanitizeAgentIdent(agentId)
  if (isReservedSenderId(id)) return 'agent_id is reserved for in-process system senders'
  if (!isKnownAgent(id)) return `unknown agent '${agentId.trim()}' -- agent_id must be a registered fleet agent id`
  return null
}

export async function tryHandleSpans(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/spans -- open or close a span
  // Open: { trace_id, span_id, parent_span_id?, agent_id, operation, start_ms, attributes? }
  // Close (patch): { trace_id, span_id, end_ms, status? }
  if (path === '/api/spans' && method === 'POST') {
    const body = await readBody(req)
    // A malformed body used to throw out of the handler and surface as a 500 -- an unhelpful answer
    // to a client error, and indistinguishable from the server actually being broken.
    let data: {
      trace_id?: unknown
      span_id?: unknown
      parent_span_id?: unknown
      agent_id?: unknown
      operation?: unknown
      start_ms?: unknown
      end_ms?: unknown
      status?: unknown
      attributes?: unknown
    }
    try {
      data = JSON.parse(body.toString()) as typeof data
    } catch {
      json(res, { error: 'invalid JSON body' }, 400)
      return true
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      json(res, { error: 'body must be a JSON object' }, 400)
      return true
    }

    if (!isNonEmptyString(data.trace_id) || !isNonEmptyString(data.span_id)) {
      json(res, { error: 'trace_id and span_id required (non-empty strings)' }, 400)
      return true
    }
    const traceId = data.trace_id
    const spanId = data.span_id

    if (data.status !== undefined && !SPAN_STATUSES.includes(data.status as SpanStatus)) {
      json(res, { error: `status must be one of: ${SPAN_STATUSES.join(', ')}` }, 400)
      return true
    }
    const status = (data.status as SpanStatus | undefined) ?? 'ok'

    // The create-and-close / open paths both need these three; validated once, here, so the two
    // call sites below cannot drift on what "valid" means.
    const hasCreateFields =
      isNonEmptyString(data.agent_id) && isNonEmptyString(data.operation) && isMs(data.start_ms)

    if (data.end_ms !== undefined) {
      // ---- CLOSE PATH ----
      if (!isMs(data.end_ms)) {
        json(res, { error: 'end_ms must be a non-negative finite number (ms since epoch)' }, 400)
        return true
      }
      const endMs = data.end_ms

      // FIRST TERMINAL EVENT WINS -- the same rule the router path follows (card dbc0b4bf). These
      // spans measure inter-agent latency; a second close would overwrite a measured latency with
      // some later, different quantity, and the two are indistinguishable afterwards.
      //
      // The lookup is what makes that safe to enforce here: closeOtelSpanIfOpen() returning false
      // means "not open", which is BOTH "already closed" and "does not exist" -- and the not-found
      // branch below creates-and-closes, so collapsing the two would rewrite the row anyway. That
      // is precisely the trap closeOtelSpanIfOpen's own doc comment warns about.
      const existing = getOtelSpan(traceId, spanId)
      if (existing) {
        if (existing.end_ms !== null) {
          json(res, {
            error: 'span is already closed -- the first terminal event wins, so its measured ' +
              'duration is not overwritten. Open a new span if you are measuring something else.',
          }, 409)
          return true
        }
        if (!closeOtelSpanIfOpen(traceId, spanId, endMs, status)) {
          // It was open a moment ago and is not now: another writer closed it in between. Same
          // answer as above -- the other writer got there first.
          json(res, { error: 'span was closed concurrently by another writer -- first terminal event wins' }, 409)
          return true
        }
        json(res, { ok: true })
        return true
      }

      // Not found: the caller may create and close in one call, but only with a full, valid span.
      if (!hasCreateFields) {
        json(res, { error: 'span not found; provide agent_id, operation, start_ms (valid) to create and close in one call' }, 404)
        return true
      }
      const startMs = data.start_ms as number
      if (endMs < startMs) {
        // A negative duration is never a measurement, and this table's whole purpose is durations.
        json(res, { error: 'end_ms must not be earlier than start_ms' }, 400)
        return true
      }
      const rejection = rejectAgentId(data.agent_id as string)
      if (rejection) {
        logger.warn({ agent_id: String(data.agent_id).trim(), trace_id: traceId }, 'Rejected POST /api/spans with an unacceptable agent_id')
        json(res, { error: rejection }, 403)
        return true
      }
      upsertOtelSpan({
        trace_id: traceId, span_id: spanId,
        parent_span_id: isNonEmptyString(data.parent_span_id) ? data.parent_span_id : null,
        agent_id: data.agent_id as string, operation: data.operation as string,
        start_ms: startMs, end_ms: endMs,
        status,
        attributes: isNonEmptyString(data.attributes) ? data.attributes : null,
      })
      json(res, { ok: true })
      return true
    }

    // ---- OPEN PATH ----
    if (!hasCreateFields) {
      json(res, { error: 'agent_id, operation, and start_ms (valid) required to open a span' }, 400)
      return true
    }
    const rejection = rejectAgentId(data.agent_id as string)
    if (rejection) {
      logger.warn({ agent_id: String(data.agent_id).trim(), trace_id: traceId }, 'Rejected POST /api/spans with an unacceptable agent_id')
      json(res, { error: rejection }, 403)
      return true
    }
    upsertOtelSpan({
      trace_id: traceId, span_id: spanId,
      parent_span_id: isNonEmptyString(data.parent_span_id) ? data.parent_span_id : null,
      agent_id: data.agent_id as string, operation: data.operation as string,
      start_ms: data.start_ms as number, end_ms: null,
      status: 'running',
      attributes: isNonEmptyString(data.attributes) ? data.attributes : null,
    })
    json(res, { ok: true })
    return true
  }

  // GET /api/traces -- list recent traces
  if (path === '/api/traces' && method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 200)
    json(res, listOtelTraces(limit))
    return true
  }

  // GET /api/traces/:id -- full span tree for a trace
  const traceMatch = path.match(/^\/api\/traces\/([^/]+)$/)
  if (traceMatch && method === 'GET') {
    const traceId = traceMatch[1]
    const spans = getOtelTrace(traceId)
    if (!spans.length) { json(res, { error: 'trace not found' }, 404); return true }
    json(res, { trace_id: traceId, spans })
    return true
  }

  return false
}
