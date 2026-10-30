// Card 08d1aa90: freellm keys proxy. The route never touches the real
// freellmapi -- freellmapi-client.js is mocked so these tests assert on the
// route's OWN contract (validation, masking, error mapping), not on a live
// upstream. The "never logs/returns the full key" requirement is checked by
// grepping every captured response body and every logger call for the
// planted secret value.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const SECRET_KEY = 'planted-test-fixture-value-should-never-leak-9f3c7a'

const freellmapiRequestMock = vi.fn()
vi.mock('../web/freellmapi-client.js', async (orig) => {
  const actual = await orig<typeof import('../web/freellmapi-client.js')>()
  return {
    ...actual,
    freellmapiRequest: (...args: unknown[]) => freellmapiRequestMock(...args),
  }
})

const logCalls: unknown[] = []
vi.mock('../logger.js', () => ({
  logger: {
    info: (...a: unknown[]) => logCalls.push(a),
    warn: (...a: unknown[]) => logCalls.push(a),
    error: (...a: unknown[]) => logCalls.push(a),
    debug: (...a: unknown[]) => logCalls.push(a),
  },
}))

const { tryHandleFreellmKeys } = await import('../web/routes/freellm-keys.js')
const { FreellmapiUnavailableError } = await import('../web/freellmapi-client.js')

beforeEach(() => {
  freellmapiRequestMock.mockReset()
  logCalls.length = 0
})

function mkRequest(path: string, method: string, body?: unknown) {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  const out: { status: number; body: any } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() {},
  }
  const url = new URL(`http://localhost:3420${path}`)
  if (body !== undefined) {
    process.nextTick(() => {
      ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
      ;(req as unknown as EventEmitter).emit('end')
    })
  } else {
    process.nextTick(() => (req as unknown as EventEmitter).emit('end'))
  }
  const ctx = { req, res, path: url.pathname, method, url } as unknown as RouteContext
  return { ctx, out }
}

describe('freellm-keys proxy', () => {
  it('POST stores a key upstream and returns only set/hint/error, never the masked prefix', async () => {
    // Real upstream shape for a >8-char key (server/src/lib/crypto.ts maskKey,
    // measured against the installed freellmapi): first4 + "..." + last4.
    freellmapiRequestMock
      .mockResolvedValueOnce({ status: 200, data: [] }) // F1: pre-add existing-row check
      .mockResolvedValueOnce({ status: 201, data: { id: 9, maskedKey: 'gsk_...3c7a' } })
    const { ctx, out } = mkRequest('/api/freellm/keys', 'POST', { provider: 'groq', key: SECRET_KEY })
    const handled = await tryHandleFreellmKeys(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(201)
    expect(out.body).toMatchObject({ provider: 'groq', set: true, hint: '3c7a', error: null })
    expect(out.body.masked).toBeUndefined()
    expect(freellmapiRequestMock).toHaveBeenNthCalledWith(2, 'POST', '/api/keys', { platform: 'groq', key: SECRET_KEY })
  })

  it('POST replaces an existing row for the provider instead of appending a second one (RedHat F1, comment 25444)', async () => {
    // WhiteHat2 GO 25458 LOW-1: add the new key FIRST, delete the stale row after
    // (a failed add never destroys a previously working key).
    freellmapiRequestMock
      .mockResolvedValueOnce({ status: 200, data: [{ id: 11, platform: 'groq', maskedKey: '****9b2e' }] })
      .mockResolvedValueOnce({ status: 201, data: { id: 12, maskedKey: 'gsk_...xd07' } })
      .mockResolvedValueOnce({ status: 200, data: { deleted: true } }) // delete the old row after
    const { ctx, out } = mkRequest('/api/freellm/keys', 'POST', { provider: 'groq', key: SECRET_KEY })
    await tryHandleFreellmKeys(ctx)
    expect(out.status).toBe(201)
    expect(freellmapiRequestMock).toHaveBeenNthCalledWith(1, 'GET', '/api/keys')
    expect(freellmapiRequestMock).toHaveBeenNthCalledWith(2, 'POST', '/api/keys', { platform: 'groq', key: SECRET_KEY })
    expect(freellmapiRequestMock).toHaveBeenNthCalledWith(3, 'DELETE', '/api/keys/11')
    expect(freellmapiRequestMock).toHaveBeenCalledTimes(3)
  })

  it('POST removes every pre-existing row for the provider, leaving other providers untouched (RedHat F1)', async () => {
    freellmapiRequestMock
      .mockResolvedValueOnce({
        status: 200,
        data: [
          { id: 1, platform: 'groq', maskedKey: '****aaaa' },
          { id: 2, platform: 'cerebras', maskedKey: '****bbbb' },
          { id: 3, platform: 'groq', maskedKey: '****cccc' },
        ],
      })
      .mockResolvedValueOnce({ status: 201, data: { id: 4, maskedKey: 'gsk_...dddd' } })
      .mockResolvedValueOnce({ status: 200, data: { deleted: true } })
      .mockResolvedValueOnce({ status: 200, data: { deleted: true } })
    const { ctx, out } = mkRequest('/api/freellm/keys', 'POST', { provider: 'groq', key: SECRET_KEY })
    await tryHandleFreellmKeys(ctx)
    expect(out.status).toBe(201)
    expect(freellmapiRequestMock).toHaveBeenNthCalledWith(3, 'DELETE', '/api/keys/1')
    expect(freellmapiRequestMock).toHaveBeenNthCalledWith(4, 'DELETE', '/api/keys/3')
    expect(freellmapiRequestMock).toHaveBeenCalledTimes(4)
  })

  it('maps google_ai_studio to the real freellmapi platform "google" on add, list and delete (WhiteHat2 GO 25458 finding 1, card 3c9c3a10)', async () => {
    freellmapiRequestMock
      .mockResolvedValueOnce({ status: 200, data: [] })
      .mockResolvedValueOnce({ status: 201, data: { id: 20, maskedKey: '****g00g' } })
    const post = mkRequest('/api/freellm/keys', 'POST', { provider: 'google_ai_studio', key: SECRET_KEY })
    await tryHandleFreellmKeys(post.ctx)
    expect(post.out.status).toBe(201)
    expect(post.out.body.provider).toBe('google_ai_studio')
    expect(freellmapiRequestMock).toHaveBeenNthCalledWith(2, 'POST', '/api/keys', { platform: 'google', key: SECRET_KEY })

    freellmapiRequestMock.mockReset()
    freellmapiRequestMock.mockResolvedValueOnce({
      status: 200,
      data: [{ id: 20, platform: 'google', maskedKey: '****g00g', createdAt: '2026-10-30 10:00:00' }],
    })
    const get = mkRequest('/api/freellm/keys', 'GET')
    await tryHandleFreellmKeys(get.ctx)
    expect(get.out.body).toEqual([
      { provider: 'google_ai_studio', setBy: 'admin', since: Math.floor(Date.parse('2026-10-30T10:00:00Z') / 1000), set: true, hint: 'g00g', error: null },
    ])

    freellmapiRequestMock.mockReset()
    freellmapiRequestMock
      .mockResolvedValueOnce({ status: 200, data: [{ id: 20, platform: 'google', maskedKey: '****g00g' }] })
      .mockResolvedValueOnce({ status: 200, data: { deleted: true } })
    const del = mkRequest('/api/freellm/keys/google_ai_studio', 'DELETE')
    await tryHandleFreellmKeys(del.ctx)
    expect(del.out.body).toEqual({ provider: 'google_ai_studio', deleted: true })
    expect(freellmapiRequestMock).toHaveBeenNthCalledWith(2, 'DELETE', '/api/keys/20')
  })

  it('a Promise.all of concurrent POSTs for the same provider leaves exactly one row (WhiteHat2 GO 25458 LOW-2, card 3c9c3a10)', async () => {
    // Simulates the real upstream's unconditional-INSERT behaviour against an
    // in-memory row set, through the route's own lock -- not through the client
    // mock call sequence (two concurrent requests interleave their GET/POST/DELETE
    // calls, so asserting call order is not meaningful; asserting the END STATE is).
    let nextId = 1
    let rows: Array<{ id: number; platform: string; maskedKey: string }> = []
    freellmapiRequestMock.mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET') return { status: 200, data: rows.map((r) => ({ ...r })) }
      if (method === 'POST') {
        const b = body as { platform: string; key: string }
        const row = { id: nextId++, platform: b.platform, maskedKey: `****${b.key.slice(-4)}` }
        rows.push(row)
        return { status: 201, data: { id: row.id, maskedKey: row.maskedKey } }
      }
      if (method === 'DELETE') {
        const id = Number(path.split('/').pop())
        rows = rows.filter((r) => r.id !== id)
        return { status: 200, data: { deleted: true } }
      }
      throw new Error(`unexpected method ${method}`)
    })
    const post = (key: string) => {
      const { ctx } = mkRequest('/api/freellm/keys', 'POST', { provider: 'groq', key })
      return tryHandleFreellmKeys(ctx)
    }
    await Promise.all([post('concurrent-key-aaaa'), post('concurrent-key-bbbb'), post('concurrent-key-cccc')])
    expect(rows.filter((r) => r.platform === 'groq')).toHaveLength(1)
  })

  it('maps every real upstream mask shape to set/hint/error (card fd5fcc2c D1)', async () => {
    const cases: Array<{ maskedKey: string; expect: { set: boolean; hint: string | null; error: string | null } }> = [
      // >8 chars: first4 + "..." + last4 -- the first4 is dropped, the contract promises only the last 4.
      { maskedKey: 'gsk_...3c7a', expect: { set: true, hint: '3c7a', error: null } },
      // 5-8 chars: "****" + last2.
      { maskedKey: '****7a', expect: { set: true, hint: '7a', error: null } },
      // <5 chars: "****", no hint available.
      { maskedKey: '****', expect: { set: true, hint: null, error: null } },
      // Decrypt failure -- the key IS set, but must surface as a distinct error, not as a plain "set".
      { maskedKey: '[decrypt failed]', expect: { set: true, hint: null, error: 'decrypt_failed' } },
      // WhiteHat2 GO 25458 L1: a hostile/future upstream shape with a longer tail
      // must still be capped at 4 characters, never passed through longer.
      { maskedKey: 'gsk_abcdef...ghijklmnopqrstuvwxyz', expect: { set: true, hint: 'wxyz', error: null } },
      { maskedKey: '****0123456789ab', expect: { set: true, hint: '89ab', error: null } },
    ]
    for (const { maskedKey, expect: wanted } of cases) {
      freellmapiRequestMock.mockReset()
      freellmapiRequestMock.mockResolvedValueOnce({
        status: 200,
        data: [{ id: 1, platform: 'groq', maskedKey, createdAt: '2026-10-29 14:42:33' }],
      })
      const { ctx, out } = mkRequest('/api/freellm/keys', 'GET')
      await tryHandleFreellmKeys(ctx)
      expect(out.body[0]).toMatchObject(wanted)
    }
  })

  it('POST rejects an empty provider', async () => {
    const { ctx, out } = mkRequest('/api/freellm/keys', 'POST', { provider: '', key: SECRET_KEY })
    await tryHandleFreellmKeys(ctx)
    expect(out.status).toBe(400)
    expect(freellmapiRequestMock).not.toHaveBeenCalled()
  })

  it('POST rejects an empty key', async () => {
    const { ctx, out } = mkRequest('/api/freellm/keys', 'POST', { provider: 'groq', key: '' })
    await tryHandleFreellmKeys(ctx)
    expect(out.status).toBe(400)
    expect(freellmapiRequestMock).not.toHaveBeenCalled()
  })

  it('POST rejects a provider outside the fixed allow-list (RedHat/WhiteHat B4, card 08d1aa90)', async () => {
    const { ctx, out } = mkRequest('/api/freellm/keys', 'POST', { provider: 'some-other-llm', key: SECRET_KEY })
    await tryHandleFreellmKeys(ctx)
    expect(out.status).toBe(400)
    expect(freellmapiRequestMock).not.toHaveBeenCalled()
  })

  it('POST rejects a key over the length cap, fail-closed (B4)', async () => {
    const { ctx, out } = mkRequest('/api/freellm/keys', 'POST', { provider: 'groq', key: 'x'.repeat(513) })
    await tryHandleFreellmKeys(ctx)
    expect(out.status).toBe(400)
    expect(freellmapiRequestMock).not.toHaveBeenCalled()
  })

  it('DELETE rejects a provider outside the fixed allow-list, never reaching upstream (B4)', async () => {
    // Encoded traversal segment: decodeURIComponent turns this into "../../etc/passwd",
    // which must fail the allow-list check rather than ever reach freellmapiRequest.
    const { ctx, out } = mkRequest('/api/freellm/keys/..%2F..%2Fetc%2Fpasswd', 'DELETE')
    await tryHandleFreellmKeys(ctx)
    expect(out.status).toBe(400)
    expect(freellmapiRequestMock).not.toHaveBeenCalled()
  })

  it('GET lists keys with only set/hint/error, never the plaintext key or its first chars', async () => {
    // createdAt arrives from freellmapi's SQLite driver as a "YYYY-MM-DD HH:MM:SS"
    // UTC string, not a unix epoch -- confirmed against the live service.
    freellmapiRequestMock.mockResolvedValueOnce({
      status: 200,
      data: [{ id: 1, platform: 'groq', maskedKey: 'gsk_...3c7a', createdAt: '2026-10-29 14:42:33' }],
    })
    const { ctx, out } = mkRequest('/api/freellm/keys', 'GET')
    await tryHandleFreellmKeys(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual([
      { provider: 'groq', setBy: 'admin', since: Math.floor(Date.parse('2026-10-29T14:42:33Z') / 1000), set: true, hint: '3c7a', error: null },
    ])
  })

  it('DELETE resolves the provider to an upstream id, then deletes it', async () => {
    freellmapiRequestMock
      .mockResolvedValueOnce({ status: 200, data: [{ id: 7, platform: 'groq', maskedKey: '****3c7a' }] })
      .mockResolvedValueOnce({ status: 200, data: { deleted: true } })
    const { ctx, out } = mkRequest('/api/freellm/keys/groq', 'DELETE')
    await tryHandleFreellmKeys(ctx)
    expect(out.body).toEqual({ provider: 'groq', deleted: true })
    expect(freellmapiRequestMock).toHaveBeenNthCalledWith(2, 'DELETE', '/api/keys/7')
  })

  it('DELETE on an allow-listed provider with no key set returns 404 without calling upstream delete', async () => {
    freellmapiRequestMock.mockResolvedValueOnce({ status: 200, data: [] })
    const { ctx, out } = mkRequest('/api/freellm/keys/mistral', 'DELETE')
    await tryHandleFreellmKeys(ctx)
    expect(out.status).toBe(404)
    expect(freellmapiRequestMock).toHaveBeenCalledTimes(1)
  })

  it('DELETE removes every row for the provider, not just the first match (RedHat F1, comment 25444)', async () => {
    // Simulates the state the F1 bug could leave behind: two rows for the same
    // provider from two POSTs that each appended instead of replacing.
    freellmapiRequestMock
      .mockResolvedValueOnce({
        status: 200,
        data: [
          { id: 5, platform: 'groq', maskedKey: '****9b2e' },
          { id: 9, platform: 'groq', maskedKey: '****xd07' },
        ],
      })
      .mockResolvedValueOnce({ status: 200, data: { deleted: true } })
      .mockResolvedValueOnce({ status: 200, data: { deleted: true } })
    const { ctx, out } = mkRequest('/api/freellm/keys/groq', 'DELETE')
    await tryHandleFreellmKeys(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ provider: 'groq', deleted: true })
    expect(freellmapiRequestMock).toHaveBeenNthCalledWith(2, 'DELETE', '/api/keys/5')
    expect(freellmapiRequestMock).toHaveBeenNthCalledWith(3, 'DELETE', '/api/keys/9')
    expect(freellmapiRequestMock).toHaveBeenCalledTimes(3)
  })

  it('DELETE with a malformed percent-escape in the provider segment answers 400, not 500 (RedHat F3)', async () => {
    const { ctx, out } = mkRequest('/api/freellm/keys/%E0%A4%A', 'DELETE')
    await tryHandleFreellmKeys(ctx)
    expect(out.status).toBe(400)
    expect(freellmapiRequestMock).not.toHaveBeenCalled()
  })

  it('POST does not reflect the upstream rejection message verbatim, but logs it (WhiteHat2 L2)', async () => {
    const UPSTREAM_DETAIL = 'upstream-internal-detail-should-not-reach-the-client'
    freellmapiRequestMock
      .mockResolvedValueOnce({ status: 200, data: [] }) // F1 pre-check
      .mockResolvedValueOnce({ status: 400, data: { error: { message: UPSTREAM_DETAIL } } })
    const { ctx, out } = mkRequest('/api/freellm/keys', 'POST', { provider: 'groq', key: SECRET_KEY })
    await tryHandleFreellmKeys(ctx)
    expect(out.status).toBe(400)
    expect(JSON.stringify(out.body)).not.toContain(UPSTREAM_DETAIL)
    expect(out.body.error).toBe('freellm_upstream_rejected')
    expect(JSON.stringify(logCalls)).toContain(UPSTREAM_DETAIL)
  })

  it('a stopped/unreachable freellmapi answers 503, not 500', async () => {
    freellmapiRequestMock.mockRejectedValueOnce(new FreellmapiUnavailableError('freellmapi is not reachable'))
    const { ctx, out } = mkRequest('/api/freellm/keys', 'GET')
    await tryHandleFreellmKeys(ctx)
    expect(out.status).toBe(503)
  })

  it('the planted secret never appears in any response body or logger call', async () => {
    freellmapiRequestMock
      .mockResolvedValueOnce({ status: 200, data: [] })
      .mockResolvedValueOnce({ status: 201, data: { maskedKey: '****3c7a' } })
    const { ctx, out } = mkRequest('/api/freellm/keys', 'POST', { provider: 'groq', key: SECRET_KEY })
    await tryHandleFreellmKeys(ctx)
    expect(JSON.stringify(out.body)).not.toContain(SECRET_KEY)
    expect(JSON.stringify(logCalls)).not.toContain(SECRET_KEY)
  })
})
