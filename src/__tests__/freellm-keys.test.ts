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
  it('POST stores a key upstream and returns only the masked value', async () => {
    freellmapiRequestMock.mockResolvedValueOnce({ status: 201, data: { maskedKey: '****3c7a' } })
    const { ctx, out } = mkRequest('/api/freellm/keys', 'POST', { provider: 'groq', key: SECRET_KEY })
    const handled = await tryHandleFreellmKeys(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(201)
    expect(out.body).toMatchObject({ provider: 'groq', masked: '****3c7a' })
    expect(freellmapiRequestMock).toHaveBeenCalledWith('POST', '/api/keys', { platform: 'groq', key: SECRET_KEY })
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

  it('GET lists keys with only the masked value, never the plaintext key', async () => {
    // createdAt arrives from freellmapi's SQLite driver as a "YYYY-MM-DD HH:MM:SS"
    // UTC string, not a unix epoch -- confirmed against the live service.
    freellmapiRequestMock.mockResolvedValueOnce({
      status: 200,
      data: [{ id: 1, platform: 'groq', maskedKey: '****3c7a', createdAt: '2026-10-29 14:42:33' }],
    })
    const { ctx, out } = mkRequest('/api/freellm/keys', 'GET')
    await tryHandleFreellmKeys(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual([
      { provider: 'groq', setBy: 'admin', since: Math.floor(Date.parse('2026-10-29T14:42:33Z') / 1000), masked: '****3c7a' },
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

  it('DELETE on an unknown provider returns 404 without calling upstream delete', async () => {
    freellmapiRequestMock.mockResolvedValueOnce({ status: 200, data: [] })
    const { ctx, out } = mkRequest('/api/freellm/keys/nosuch', 'DELETE')
    await tryHandleFreellmKeys(ctx)
    expect(out.status).toBe(404)
    expect(freellmapiRequestMock).toHaveBeenCalledTimes(1)
  })

  it('a stopped/unreachable freellmapi answers 503, not 500', async () => {
    freellmapiRequestMock.mockRejectedValueOnce(new FreellmapiUnavailableError('freellmapi is not reachable'))
    const { ctx, out } = mkRequest('/api/freellm/keys', 'GET')
    await tryHandleFreellmKeys(ctx)
    expect(out.status).toBe(503)
  })

  it('the planted secret never appears in any response body or logger call', async () => {
    freellmapiRequestMock.mockResolvedValueOnce({ status: 201, data: { maskedKey: '****3c7a' } })
    const { ctx, out } = mkRequest('/api/freellm/keys', 'POST', { provider: 'groq', key: SECRET_KEY })
    await tryHandleFreellmKeys(ctx)
    expect(JSON.stringify(out.body)).not.toContain(SECRET_KEY)
    expect(JSON.stringify(logCalls)).not.toContain(SECRET_KEY)
  })
})
