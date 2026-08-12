// A rate-limited HTTP fetch layer -- "eszszeru rate-limit" per the card. The clock and sleep
// are injectable so the spacing logic itself is unit-testable without real delays or a network.

export interface RateLimiterDeps {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type RateLimiter = () => Promise<void>

export function createRateLimiter(minIntervalMs: number, deps: RateLimiterDeps = {}): RateLimiter {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let lastCallAt: number | null = null

  return async function wait(): Promise<void> {
    if (lastCallAt !== null) {
      const remaining = minIntervalMs - (now() - lastCallAt)
      if (remaining > 0) await sleep(remaining)
    }
    lastCallAt = now()
  }
}

export interface FetchTextResult {
  status: number
  body: string
}

export interface RateLimitedFetcherOptions extends RateLimiterDeps {
  userAgent: string
  minIntervalMs: number
  fetchImpl?: typeof fetch
}

export type TextFetcher = (url: string) => Promise<FetchTextResult>

export function createRateLimitedFetcher(opts: RateLimitedFetcherOptions): TextFetcher {
  const wait = createRateLimiter(opts.minIntervalMs, opts)
  const fetchImpl = opts.fetchImpl ?? fetch

  return async function fetchText(url: string): Promise<FetchTextResult> {
    await wait()
    const res = await fetchImpl(url, { headers: { 'User-Agent': opts.userAgent } })
    const body = await res.text()
    return { status: res.status, body }
  }
}
