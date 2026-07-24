// Integration tests for the GEMINI-1 probe-validation wired into the
// PUT /api/settings/integrations/gemini handler.
//
// The vault module is FULLY MOCKED (vi.mock) so no test ever touches the real
// store/vault.json / store/.vault-key -- this proves the fail-closed contract
// (setSecret must NOT be called when validation fails) without any real I/O.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'

const vaultMock = {
  getSecret: vi.fn<(id: string) => string | null>(() => null),
  setSecret: vi.fn<(id: string, label: string, value: string) => void>(),
  deleteSecret: vi.fn<(id: string) => boolean>(() => false),
}
vi.mock('../web/vault.js', () => vaultMock)

const validateMock = vi.fn<(key: string) => Promise<{ ok: boolean; error?: string }>>()
vi.mock('../web/gemini-validate.js', () => ({ validateGeminiKey: validateMock }))

const { tryHandleIntegrations } = await import('../web/routes/integrations.js')

function fakeReq(body: unknown): http.IncomingMessage {
  const req = new EventEmitter() as unknown as http.IncomingMessage
  queueMicrotask(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  return req
}
function fakeRes(): { res: http.ServerResponse; status: () => number; body: () => unknown } {
  let status = 0
  let written = ''
  const res = {
    writeHead: (code: number) => {
      status = code
    },
    end: (chunk?: string) => {
      written = chunk ?? ''
    },
  } as unknown as http.ServerResponse
  return { res, status: () => status, body: () => JSON.parse(written || '{}') }
}

beforeEach(() => {
  vaultMock.getSecret.mockReset().mockReturnValue(null)
  vaultMock.setSecret.mockReset()
  vaultMock.deleteSecret.mockReset().mockReturnValue(false)
  validateMock.mockReset()
})

describe('PUT /api/settings/integrations/gemini -- GEMINI-1 fail-closed validation', () => {
  it('an INVALID key is rejected: setSecret is NEVER called, a speaking (rule-12) message returns', async () => {
    validateMock.mockResolvedValue({ ok: false, error: 'invalid' })
    const { res, status, body } = fakeRes()
    const ok = await tryHandleIntegrations({
      req: fakeReq({ apiKey: 'bad-key' }),
      res,
      path: '/api/settings/integrations/gemini',
      method: 'PUT',
      url: new URL('http://x/api/settings/integrations/gemini'),
    })
    expect(ok).toBe(true)
    expect(vaultMock.setSecret).not.toHaveBeenCalled()
    expect(status()).toBe(400)
    expect(String((body() as { error: string }).error)).not.toContain('bad-key')
    expect((body() as { error: string }).error.length).toBeGreaterThan(0) // beszédes, not empty/generic-only
  })

  it('a VALID key is validated THEN stored, and the response never carries the raw key', async () => {
    validateMock.mockResolvedValue({ ok: true })
    const { res, status, body } = fakeRes()
    const ok = await tryHandleIntegrations({
      req: fakeReq({ apiKey: 'AIzaGoodKeyValue12345' }),
      res,
      path: '/api/settings/integrations/gemini',
      method: 'PUT',
      url: new URL('http://x/api/settings/integrations/gemini'),
    })
    expect(ok).toBe(true)
    expect(vaultMock.setSecret).toHaveBeenCalledWith(
      'integration.gemini.apiKey',
      'Gemini API Key',
      'AIzaGoodKeyValue12345',
    )
    expect(status()).toBe(200)
    const responded = body() as { ok: boolean; masked: string }
    expect(responded.ok).toBe(true)
    expect(responded.masked).not.toBe('AIzaGoodKeyValue12345')
    expect(responded.masked.endsWith('2345')).toBe(true) // last 4 chars per maskKey
  })

  it('a NETWORK-error validation result is a distinct status from an INVALID key (504 vs 400)', async () => {
    validateMock.mockResolvedValue({ ok: false, error: 'network' })
    const { res, status } = fakeRes()
    await tryHandleIntegrations({
      req: fakeReq({ apiKey: 'some-key' }),
      res,
      path: '/api/settings/integrations/gemini',
      method: 'PUT',
      url: new URL('http://x/api/settings/integrations/gemini'),
    })
    expect(status()).toBe(504)
    expect(vaultMock.setSecret).not.toHaveBeenCalled()
  })

  it('validation is skipped (fail-closed pre-check) for an empty apiKey -- 400, validator never called', async () => {
    const { res, status } = fakeRes()
    await tryHandleIntegrations({
      req: fakeReq({ apiKey: '   ' }),
      res,
      path: '/api/settings/integrations/gemini',
      method: 'PUT',
      url: new URL('http://x/api/settings/integrations/gemini'),
    })
    expect(status()).toBe(400)
    expect(validateMock).not.toHaveBeenCalled()
    expect(vaultMock.setSecret).not.toHaveBeenCalled()
  })
})

describe('GET/DELETE /api/settings/integrations/gemini -- unchanged contract (regression)', () => {
  it('GET never returns the raw key, only configured+masked', async () => {
    vaultMock.getSecret.mockReturnValue('AIzaSecretRawValue999')
    const { res, body } = fakeRes()
    await tryHandleIntegrations({
      req: fakeReq({}),
      res,
      path: '/api/settings/integrations/gemini',
      method: 'GET',
      url: new URL('http://x/api/settings/integrations/gemini'),
    })
    const out = body() as { configured: boolean; masked: string }
    expect(out.configured).toBe(true)
    expect(out.masked).not.toBe('AIzaSecretRawValue999')
    expect(JSON.stringify(out)).not.toContain('AIzaSecretRawValue999')
  })

  it('DELETE removes the secret and never re-validates', async () => {
    vaultMock.deleteSecret.mockReturnValue(true)
    const { res, status } = fakeRes()
    await tryHandleIntegrations({
      req: fakeReq({}),
      res,
      path: '/api/settings/integrations/gemini',
      method: 'DELETE',
      url: new URL('http://x/api/settings/integrations/gemini'),
    })
    expect(status()).toBe(200)
    expect(validateMock).not.toHaveBeenCalled()
  })
})
