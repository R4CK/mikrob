// Unit tests for the Gemini API key probe-validator (card GEMINI-1).
// Fully hermetic: fetchImpl is injected, so NO real network call is ever made.
import { describe, it, expect, vi } from 'vitest'
import { validateGeminiKey } from '../web/gemini-validate.js'

function fakeFetch(status: number): typeof fetch {
  return vi.fn(async () => new Response('{}', { status })) as unknown as typeof fetch
}

describe('validateGeminiKey', () => {
  it('200 -> ok:true', async () => {
    const out = await validateGeminiKey('AIzaFAKEKEY', { fetchImpl: fakeFetch(200) })
    expect(out).toEqual({ ok: true })
  })

  it.each([400, 401, 403])('%d -> ok:false, error:invalid', async (status) => {
    const out = await validateGeminiKey('AIzaFAKEKEY', { fetchImpl: fakeFetch(status) })
    expect(out).toEqual({ ok: false, error: 'invalid' })
  })

  it('500 -> ok:false, error:unexpected (not "invalid" -- server fault, not a bad key)', async () => {
    const out = await validateGeminiKey('AIzaFAKEKEY', { fetchImpl: fakeFetch(500) })
    expect(out).toEqual({ ok: false, error: 'unexpected' })
  })

  it('fetch throws (network down) -> ok:false, error:network', async () => {
    const throwing = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const out = await validateGeminiKey('AIzaFAKEKEY', { fetchImpl: throwing })
    expect(out).toEqual({ ok: false, error: 'network' })
  })

  it('timeout aborts the request -> ok:false, error:network (fail-closed, not hung forever)', async () => {
    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    ) as unknown as typeof fetch
    const out = await validateGeminiKey('AIzaFAKEKEY', { fetchImpl: hanging, timeoutMs: 10 })
    expect(out).toEqual({ ok: false, error: 'network' })
  })

  it('NO-LEAK: the key is sent ONLY in the x-goog-api-key header, never the URL', async () => {
    const secret = 'AIzaSyTHIS-IS-THE-SECRET-KEY-VALUE'
    let seenUrl = ''
    let seenHeaders: Record<string, string> = {}
    const spy = vi.fn(async (url: string, init?: RequestInit) => {
      seenUrl = url
      seenHeaders = (init?.headers ?? {}) as Record<string, string>
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    await validateGeminiKey(secret, { fetchImpl: spy })
    expect(seenUrl).not.toContain(secret)
    expect(seenHeaders['x-goog-api-key']).toBe(secret)
  })

  it('NO-LEAK: no returned error string ever contains the raw key', async () => {
    const secret = 'AIzaSyTHIS-IS-THE-SECRET-KEY-VALUE'
    for (const status of [400, 401, 403, 500]) {
      const out = await validateGeminiKey(secret, { fetchImpl: fakeFetch(status) })
      expect(JSON.stringify(out)).not.toContain(secret)
    }
  })

  it('respects an injected baseUrl (test/self-host hook)', async () => {
    let seenUrl = ''
    const spy = vi.fn(async (url: string) => {
      seenUrl = url
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    await validateGeminiKey('k', { fetchImpl: spy, baseUrl: 'http://127.0.0.1:9999' })
    expect(seenUrl).toBe('http://127.0.0.1:9999/v1beta/models')
  })
})
