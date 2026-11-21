// Card 685f25cb: GET /api/freellm/calls -- per-call list for the FreeLLM dashboard page, sourced
// from llm_ledger (provider='freellm'), one row per real call appended by freellm-call.sh's own
// _freellm_ledger_log (card e96d56c5 F4). No new journal file: the per-call record already
// existed, nothing queried it for this page until now (MikroB root-cause measurement, 2026-11-20).
import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, appendLlmLedgerRow } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'
import { tryHandleFreellmStatus } from '../web/routes/freellm-status.js'

function mkRequest(path: string) {
  const req = new EventEmitter() as unknown as RouteContext['req']
  const out: { status: number; body: any } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() {},
  }
  process.nextTick(() => (req as unknown as EventEmitter).emit('end'))
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method: 'GET', url } as unknown as RouteContext
  return { ctx, out }
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('GET /api/freellm/calls', () => {
  it('returns a real success and a forced failure call within the default window', async () => {
    const now = Math.floor(Date.now() / 1000)
    appendLlmLedgerRow({ agentId: 'backend2', cardId: '685f25cb', taskType: 'offload', provider: 'freellm', model: 'auto', ok: true, latencyMs: 500, nowS: now })
    appendLlmLedgerRow({ agentId: 'backend2', cardId: '685f25cb', taskType: 'offload', provider: 'freellm', model: 'auto', ok: false, failReason: 'http_404', latencyMs: 300, nowS: now })

    const { ctx, out } = mkRequest('/api/freellm/calls')
    const handled = await tryHandleFreellmStatus(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.calls).toHaveLength(2)
    // newest first
    expect(out.body.calls[0].outcome).toBe('fail')
    expect(out.body.calls[0].fail_reason).toBe('http_404')
    expect(out.body.calls[1].outcome).toBe('ok')
    expect(out.body.counts_24h).toEqual({ ok: 1, fail: 1, stalled: 0, rate_429: 0, auth: 0 })
  })

  it('maps fail_reason to the outcome vocabulary: auth, 429, stalled, generic fail', async () => {
    const now = Math.floor(Date.now() / 1000)
    appendLlmLedgerRow({ agentId: 'backend2', taskType: 'offload', provider: 'freellm', ok: false, failReason: 'auth_401', nowS: now })
    appendLlmLedgerRow({ agentId: 'backend2', taskType: 'offload', provider: 'freellm', ok: false, failReason: 'quota_429', nowS: now })
    appendLlmLedgerRow({ agentId: 'backend2', taskType: 'offload', provider: 'freellm', ok: false, failReason: 'http_', nowS: now }) // stalled: all attempts timed out
    appendLlmLedgerRow({ agentId: 'backend2', taskType: 'offload', provider: 'freellm', ok: false, failReason: 'http_500', nowS: now })

    const { ctx, out } = mkRequest('/api/freellm/calls')
    await tryHandleFreellmStatus(ctx)
    const outcomes = out.body.calls.map((c: any) => c.outcome)
    expect(outcomes).toEqual(['fail', 'stalled', '429', 'auth'])
    // the window-wide counts bucket the same four rows the same way, independent of `limit`
    expect(out.body.counts_24h).toEqual({ ok: 0, fail: 1, stalled: 1, rate_429: 1, auth: 1 })
  })

  it('never leaks prompt or key material -- only the fixed metadata fields are present', async () => {
    const now = Math.floor(Date.now() / 1000)
    appendLlmLedgerRow({ agentId: 'backend2', cardId: 'cardX', taskType: 'offload', provider: 'freellm', model: 'auto', ok: true, nowS: now })

    const { ctx, out } = mkRequest('/api/freellm/calls')
    await tryHandleFreellmStatus(ctx)
    const row = out.body.calls[0] as Record<string, unknown>
    expect(Object.keys(row).sort()).toEqual(['agent', 'card', 'duration_ms', 'fail_reason', 'model', 'outcome', 'provider', 'ts'].sort())
    expect(row.provider).toBeNull()
  })

  it('a non-freellm provider row is excluded', async () => {
    const now = Math.floor(Date.now() / 1000)
    appendLlmLedgerRow({ agentId: 'backend2', taskType: 'offload', provider: 'local', ok: true, nowS: now })
    const { ctx, out } = mkRequest('/api/freellm/calls')
    await tryHandleFreellmStatus(ctx)
    expect(out.body.calls).toHaveLength(0)
  })

  it('a row older than the default 7-day window is excluded', async () => {
    const now = Math.floor(Date.now() / 1000)
    appendLlmLedgerRow({ agentId: 'backend2', taskType: 'offload', provider: 'freellm', ok: true, nowS: now - 8 * 24 * 3600 })
    const { ctx, out } = mkRequest('/api/freellm/calls')
    await tryHandleFreellmStatus(ctx)
    expect(out.body.calls).toHaveLength(0)
    // the 24h/7d counts are their own SQL query, computed independently of the capped `calls`
    // list -- an 8-day-old row must be excluded from those too, not just from the returned rows.
    expect(out.body.counts_7d).toEqual({ ok: 0, fail: 0, stalled: 0, rate_429: 0, auth: 0 })
  })

  it('excludes known test callers (test-agent/selftest/queue) from rows and counts by default', async () => {
    const now = Math.floor(Date.now() / 1000)
    appendLlmLedgerRow({ agentId: 'backend2', taskType: 'offload', provider: 'freellm', ok: true, nowS: now })
    appendLlmLedgerRow({ agentId: 'selftest', taskType: 'offload', provider: 'freellm', ok: true, nowS: now })
    appendLlmLedgerRow({ agentId: 'test-agent', taskType: 'offload', provider: 'freellm', ok: false, failReason: 'quota_429', nowS: now })
    appendLlmLedgerRow({ agentId: 'queue', taskType: 'offload', provider: 'freellm', ok: false, failReason: 'auth_401', nowS: now })

    const { ctx, out } = mkRequest('/api/freellm/calls')
    await tryHandleFreellmStatus(ctx)
    expect(out.body.calls).toHaveLength(1)
    expect(out.body.calls[0].agent).toBe('backend2')
    expect(out.body.counts_24h).toEqual({ ok: 1, fail: 0, stalled: 0, rate_429: 0, auth: 0 })

    const { ctx: ctx2, out: out2 } = mkRequest('/api/freellm/calls?includeTest=1')
    await tryHandleFreellmStatus(ctx2)
    expect(out2.body.calls).toHaveLength(4)
  })

  it('rejects an out-of-range limit with 400', async () => {
    const { ctx, out } = mkRequest('/api/freellm/calls?limit=0')
    await tryHandleFreellmStatus(ctx)
    expect(out.status).toBe(400)
  })

  it('rejects limit=501 (over the 500 cap) with 400', async () => {
    const { ctx, out } = mkRequest('/api/freellm/calls?limit=501')
    await tryHandleFreellmStatus(ctx)
    expect(out.status).toBe(400)
  })

  it('rejects a non-numeric since with 400', async () => {
    const { ctx, out } = mkRequest('/api/freellm/calls?since=not-a-number')
    await tryHandleFreellmStatus(ctx)
    expect(out.status).toBe(400)
  })

  it('a negative since is rejected with 400', async () => {
    const { ctx, out } = mkRequest('/api/freellm/calls?since=-1')
    await tryHandleFreellmStatus(ctx)
    expect(out.status).toBe(400)
  })
})
