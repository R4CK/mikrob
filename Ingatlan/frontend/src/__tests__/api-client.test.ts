import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchMarketSummary, fetchTrend, fetchListings, ApiError } from '../api-client.js'

const jsonResponse = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api-client', () => {
  it('fetchMarketSummary GETs /api/market-summary and returns the parsed JSON', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ aktiv_db: 5 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchMarketSummary()
    expect(fetchMock).toHaveBeenCalledWith('/api/market-summary', { credentials: 'same-origin' })
    expect(result).toEqual({ aktiv_db: 5 })
  })

  it('fetchTrend GETs /api/trend', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([{ datum: '2026-01' }])))
    expect(await fetchTrend()).toEqual([{ datum: '2026-01' }])
  })

  it('fetchListings GETs /api/listings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([{ id: 'a' }])))
    expect(await fetchListings()).toEqual([{ id: 'a' }])
  })

  it('a 401 response throws ApiError with status 401 (caller can redirect to /login)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 401)))
    await expect(fetchMarketSummary()).rejects.toThrow(ApiError)
    await expect(fetchMarketSummary()).rejects.toMatchObject({ status: 401 })
  })

  it('a non-2xx, non-401 response throws ApiError with that status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 500)))
    await expect(fetchMarketSummary()).rejects.toMatchObject({ status: 500 })
  })

  it('a network failure (backend unreachable) throws ApiError with status 0 -- the OFFLINE case', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(fetchMarketSummary()).rejects.toMatchObject({ status: 0 })
  })
})
