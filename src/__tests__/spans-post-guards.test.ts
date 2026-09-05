import { describe, it, expect, beforeAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, getOtelSpan, upsertOtelSpan } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { SYSTEM_DIRECTIVE_SENDER } from '../web/system-directive-id.js'
import { tryHandleSpans } from '../web/routes/spans.js'
import type { RouteContext } from '../web/routes/types.js'

// Card 63beeb8a (Cybered's non-blocking finding on dbc0b4bf's gate).
//
// WHY THIS FILE EXISTS AT ALL. otel-distributed-tracing.test.ts opens by saying it covers
// "POST/GET /api/spans" -- it does not. It defines its OWN local upsertOtelSpan/closeOtelSpan
// against a scratch database and never calls tryHandleSpans, so the route had ZERO coverage and its
// whole suite stayed green no matter what the handler did. That is why the write side could drift
// this far from the read side without anything going red.
//
// WHAT THE ROUTE HAD TO ANSWER FOR. dbc0b4bf made the READ side of otel_spans trustworthy so the
// table can become an alerting base. The WRITE side bypassed every one of those rules: an
// unconditional close that overwrote an already-measured latency, an unvalidated end_ms, and an
// agent_id nobody checked -- while the shared Bearer token is readable by every sub-agent. A forged
// or silently-rewritten row is exactly the failure an alerting table must not have.
function fakeCtx(rawBody: string): { ctx: RouteContext; res: { statusCode: number; body: string } } {
  const req = new EventEmitter() as unknown as RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => { /* readBody over-limit hook */ }
  const state = { statusCode: 200, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() { /* not used by json() */ },
  } as unknown as RouteContext['res']
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(rawBody))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const path = '/api/spans'
  return { ctx: { req, res, path, method: 'POST', url: new URL(`http://localhost${path}`), fedPeer: null }, res: state }
}

async function postRaw(raw: string): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const { ctx, res } = fakeCtx(raw)
  expect(await tryHandleSpans(ctx)).toBe(true)
  return { statusCode: res.statusCode, json: res.body ? JSON.parse(res.body) : {} }
}
const post = (body: unknown) => postRaw(JSON.stringify(body))

let seq = 0
const nextIds = () => { seq += 1; return { trace_id: `T${seq}`, span_id: `S${seq}` } }

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

describe('POST /api/spans -- body validation', () => {
  it('a malformed body is a 400, not a 500', async () => {
    // It used to throw out of the handler and surface as a server error, which tells a client
    // nothing and is indistinguishable from the server actually being broken.
    const r = await postRaw('{not json')
    expect(r.statusCode).toBe(400)
    expect(String(r.json.error)).toContain('invalid JSON')
  })

  it('a non-object body (array, string, null) is a 400', async () => {
    for (const raw of ['[1,2]', '"a string"', 'null']) {
      expect((await postRaw(raw)).statusCode).toBe(400)
    }
  })

  it('trace_id/span_id must be present AND strings -- a number is not an id', async () => {
    expect((await post({ span_id: 'S' })).statusCode).toBe(400)
    expect((await post({ trace_id: 'T' })).statusCode).toBe(400)
    expect((await post({ trace_id: 1, span_id: 2 })).statusCode).toBe(400)
    expect((await post({ trace_id: '  ', span_id: 'S' })).statusCode).toBe(400)
  })

  it('status must be one of the four known values', async () => {
    const ids = nextIds()
    const r = await post({ ...ids, agent_id: MAIN_AGENT_ID, operation: 'op', start_ms: 1, status: 'bogus' })
    expect(r.statusCode).toBe(400)
    expect(String(r.json.error)).toContain('status must be one of')
  })

  it('end_ms must be a non-negative finite number -- not a string, not NaN, not negative', async () => {
    const ids = nextIds()
    for (const end of ['123', -1, null] as unknown[]) {
      const r = await post({ ...ids, end_ms: end })
      expect(r.statusCode, `end_ms=${JSON.stringify(end)} should be refused`).toBe(400)
    }
  })

  it('start_ms is validated on the open path too, not just required', async () => {
    const ids = nextIds()
    const r = await post({ ...ids, agent_id: MAIN_AGENT_ID, operation: 'op', start_ms: 'soon' })
    expect(r.statusCode).toBe(400)
  })
})

describe('POST /api/spans -- who a span may be attributed to', () => {
  it('refuses an unregistered agent_id with 403', async () => {
    const ids = nextIds()
    const r = await post({ ...ids, agent_id: 'not-a-real-agent', operation: 'op', start_ms: 1 })
    expect(r.statusCode).toBe(403)
    expect(String(r.json.error)).toContain('unknown agent')
    expect(getOtelSpan(ids.trace_id, ids.span_id), 'nothing may be written on a refusal').toBeNull()
  })

  it('refuses the reserved in-process sender ids with 403 -- same rule as POST /api/messages', async () => {
    // The router legitimately writes these in-process; over HTTP they are a claim a token holder
    // does not get to make. Asserted here because the two guards must not drift apart.
    const ids = nextIds()
    const r = await post({ ...ids, agent_id: SYSTEM_DIRECTIVE_SENDER, operation: 'op', start_ms: 1 })
    expect(r.statusCode).toBe(403)
    expect(String(r.json.error)).toContain('reserved')
  })

  it('refuses the sanitize-normalization bypass ("@<reserved id>")', async () => {
    // Survives a .trim() comparison but sanitizes to the reserved id -- the same asymmetry the
    // messages guard closes. The check must normalize before matching.
    const ids = nextIds()
    expect((await post({ ...ids, agent_id: `@${SYSTEM_DIRECTIVE_SENDER}`, operation: 'op', start_ms: 1 })).statusCode).toBe(403)
  })

  it('still accepts a registered fleet agent -- the guard never widens into refuse-everything', async () => {
    const ids = nextIds()
    const r = await post({ ...ids, agent_id: MAIN_AGENT_ID, operation: 'op', start_ms: 1000 })
    expect(r.statusCode).toBe(200)
    const row = getOtelSpan(ids.trace_id, ids.span_id)
    expect(row?.status).toBe('running')
    expect(row?.end_ms).toBeNull()
  })
})

describe('POST /api/spans -- first terminal event wins (the dbc0b4bf invariant)', () => {
  it('closes an OPEN span', async () => {
    const ids = nextIds()
    upsertOtelSpan({ ...ids, parent_span_id: null, agent_id: MAIN_AGENT_ID, operation: 'op', start_ms: 1000, attributes: null })
    const r = await post({ ...ids, end_ms: 5000, status: 'ok' })
    expect(r.statusCode).toBe(200)
    expect(getOtelSpan(ids.trace_id, ids.span_id)?.end_ms).toBe(5000)
  })

  it('REFUSES a second close and leaves the measured duration untouched', async () => {
    // THE POINT OF THE CARD. The old handler called the unconditional closeOtelSpan, so a second
    // close silently replaced a measured inter-agent latency with whatever the later caller was
    // timing -- two different quantities in one column, indistinguishable afterwards.
    const ids = nextIds()
    upsertOtelSpan({ ...ids, parent_span_id: null, agent_id: MAIN_AGENT_ID, operation: 'op', start_ms: 1000, attributes: null })
    expect((await post({ ...ids, end_ms: 5000, status: 'ok' })).statusCode).toBe(200)

    const r = await post({ ...ids, end_ms: 999_999, status: 'error' })
    expect(r.statusCode).toBe(409)
    const row = getOtelSpan(ids.trace_id, ids.span_id)
    expect(row?.end_ms, 'the first measurement must survive the second close').toBe(5000)
    expect(row?.status).toBe('ok')
  })

  it('an already-closed span is NOT mistaken for a missing one and re-created', async () => {
    // The specific trap closeOtelSpanIfOpen's own doc comment names: its false return means
    // "not open", which is both "already closed" and "does not exist". The not-found branch
    // creates-and-closes, so collapsing the two would rewrite the row through the back door --
    // defeating the check that was just added.
    const ids = nextIds()
    upsertOtelSpan({ ...ids, parent_span_id: null, agent_id: MAIN_AGENT_ID, operation: 'op', start_ms: 1000, attributes: null })
    await post({ ...ids, end_ms: 5000, status: 'ok' })

    const r = await post({ ...ids, end_ms: 777, status: 'error', agent_id: MAIN_AGENT_ID, operation: 'op', start_ms: 1000 })
    expect(r.statusCode).toBe(409)
    expect(getOtelSpan(ids.trace_id, ids.span_id)?.end_ms).toBe(5000)
  })
})

describe('POST /api/spans -- create-and-close in one call', () => {
  it('needs the full, VALID creation set, not merely present fields', async () => {
    const ids = nextIds()
    expect((await post({ ...ids, end_ms: 2000 })).statusCode).toBe(404)
    expect((await post({ ...ids, end_ms: 2000, agent_id: MAIN_AGENT_ID, operation: 'op', start_ms: 'x' })).statusCode).toBe(404)
  })

  it('refuses a negative duration -- a wrong duration is worse than a missing one', async () => {
    const ids = nextIds()
    const r = await post({ ...ids, end_ms: 500, agent_id: MAIN_AGENT_ID, operation: 'op', start_ms: 1000 })
    expect(r.statusCode).toBe(400)
    expect(String(r.json.error)).toContain('earlier than start_ms')
    expect(getOtelSpan(ids.trace_id, ids.span_id)).toBeNull()
  })

  it('applies the SAME agent_id rule on this path -- not just the open path', async () => {
    const ids = nextIds()
    const r = await post({ ...ids, end_ms: 2000, agent_id: 'not-a-real-agent', operation: 'op', start_ms: 1000 })
    expect(r.statusCode).toBe(403)
    expect(getOtelSpan(ids.trace_id, ids.span_id)).toBeNull()
  })

  it('writes the span when everything checks out', async () => {
    const ids = nextIds()
    const r = await post({ ...ids, end_ms: 2000, agent_id: MAIN_AGENT_ID, operation: 'op', start_ms: 1000, status: 'ok' })
    expect(r.statusCode).toBe(200)
    const row = getOtelSpan(ids.trace_id, ids.span_id)
    expect(row?.end_ms).toBe(2000)
    expect(row?.status).toBe('ok')
  })

  it('a non-string attributes/parent_span_id becomes null rather than reaching the column raw', async () => {
    const ids = nextIds()
    await post({ ...ids, agent_id: MAIN_AGENT_ID, operation: 'op', start_ms: 1000, attributes: { a: 1 }, parent_span_id: 42 })
    const row = getOtelSpan(ids.trace_id, ids.span_id)
    expect(row?.attributes).toBeNull()
    expect(row?.parent_span_id).toBeNull()
  })
})
