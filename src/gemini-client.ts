// Gemini API client for the model-fallback path (card 2a418584).
//
// WHY THIS EXISTS: when every Claude model in the fallback chain is quota-frozen, the fleet is deaf
// until the plan window resets. Gemini runs on a SEPARATE budget, so it can answer in the meantime.
//
// SECRET HANDLING (card requirement: "kulcs a vaultbol, sosem kodba/logba/URL-be"):
//   * The key is NEVER hardcoded -- it is resolved at call time from the vault entry
//     `integration.gemini.apiKey` and passed in by the caller.
//   * The key goes in the `x-goog-api-key` HEADER, never in the query string. Google's docs show a
//     `?key=` form; that is deliberately NOT used here, because URLs land in access logs, proxy logs
//     and error traces, which would leak the secret.
//   * No log line in this module ever includes the key, and `redactKey()` scrubs it from any error
//     text before it can reach a log (an upstream error body can echo the request).
//
// MODEL CHOICE (validated empirically 2026-07-30 against the real key, NOT assumed from docs):
//   gemini-flash-latest  -> 200 OK          <- the default below
//   gemini-2.5-flash     -> 404 "no longer available to new users"
//   gemini-2.5-flash-lite-> 404
//   gemini-2.0-flash(-001)-> 429 RESOURCE_EXHAUSTED (free-tier quota)
// The model is therefore configurable, with the one verified-working id as the default.

/** Verified-working default (see the header). Overridable via config. */
export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest'
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'
export const DEFAULT_GEMINI_TIMEOUT_MS = 60_000

/** The vault entry id holding the API key. Never the key itself. */
export const GEMINI_VAULT_KEY_ID = 'integration.gemini.apiKey'

export interface GeminiResult {
  ok: boolean
  /** Model text on success. */
  text?: string
  /** Machine-readable failure class -- what the caller branches on. */
  reason?: 'no_key' | 'auth' | 'quota' | 'model_missing' | 'network' | 'bad_response' | 'http'
  /** Human-readable detail, ALWAYS key-redacted. */
  detail?: string
  httpStatus?: number
  /** Total tokens, when the API reports them (metering only). */
  totalTokens?: number
}

/**
 * Remove anything that looks like the API key from a string before it is logged or surfaced.
 * Defence in depth: an upstream error body can echo the request that contained the key.
 */
export function redactKey(text: string, key?: string): string {
  let out = text
  if (key && key.length >= 8) out = out.split(key).join('***REDACTED***')
  // Also scrub key-shaped tokens generically (classic AIza... and the newer AQ.A... form).
  out = out.replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '***REDACTED***')
  out = out.replace(/\bAQ\.[0-9A-Za-z_.-]{20,}/g, '***REDACTED***')
  return out
}

/** Map an HTTP status + API status string onto our failure classes. */
export function classifyGeminiFailure(
  httpStatus: number,
  apiStatus?: string,
): NonNullable<GeminiResult['reason']> {
  if (httpStatus === 401 || httpStatus === 403 || apiStatus === 'PERMISSION_DENIED') return 'auth'
  if (httpStatus === 429 || apiStatus === 'RESOURCE_EXHAUSTED') return 'quota'
  if (httpStatus === 404 || apiStatus === 'NOT_FOUND') return 'model_missing'
  return 'http'
}

/** Injected so tests never touch the network and prod uses global fetch. */
export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}>

export interface GeminiCallOptions {
  apiKey: string | null | undefined
  prompt: string
  model?: string
  timeoutMs?: number
  fetchImpl?: FetchLike
}

/**
 * One generateContent call. Returns a RESULT object rather than throwing, so the fallback runner can
 * branch on `reason` without try/catch around every call site. Never throws for an API-level failure.
 */
export async function geminiGenerate(opts: GeminiCallOptions): Promise<GeminiResult> {
  const key = (opts.apiKey || '').trim()
  if (!key) return { ok: false, reason: 'no_key', detail: 'no Gemini API key in the vault' }

  const model = opts.model || DEFAULT_GEMINI_MODEL
  const doFetch = (opts.fetchImpl || (globalThis.fetch as unknown as FetchLike))
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`

  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await doFetch(url, {
      method: 'POST',
      // Key in the HEADER, never the URL -- see the module header.
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: opts.prompt }] }] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_GEMINI_TIMEOUT_MS),
    })
  } catch (err) {
    return {
      ok: false,
      reason: 'network',
      detail: redactKey(String(err instanceof Error ? err.message : err), key).slice(0, 200),
    }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, reason: 'bad_response', httpStatus: res.status, detail: 'non-JSON response' }
  }

  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const apiErr = b.error as { status?: string; message?: string } | undefined
  if (res.status !== 200 || apiErr) {
    return {
      ok: false,
      reason: classifyGeminiFailure(res.status, apiErr?.status),
      httpStatus: res.status,
      detail: redactKey(String(apiErr?.message ?? `HTTP ${res.status}`), key).slice(0, 200),
    }
  }

  const cands = b.candidates as Array<Record<string, unknown>> | undefined
  const parts = ((cands?.[0]?.content as Record<string, unknown> | undefined)?.parts) as
    | Array<{ text?: string }>
    | undefined
  const text = parts?.map((p) => p.text ?? '').join('') ?? ''
  if (!text) return { ok: false, reason: 'bad_response', httpStatus: res.status, detail: 'empty candidate text' }

  const usage = b.usageMetadata as { totalTokenCount?: number } | undefined
  return { ok: true, text, httpStatus: res.status, totalTokens: usage?.totalTokenCount }
}

export interface GeminiKeyValidation {
  valid: boolean
  reason?: NonNullable<GeminiResult['reason']>
  detail?: string
  /** Models the key can actually see (names only) -- useful when picking a working model. */
  modelCount?: number
}

/**
 * Validate the key with a REAL API call (card step 1 -- the key's format is unusual: the live key is
 * `AQ.A…`, 53 chars, not the classic 39-char `AIza…`, so a format regex would REJECT a working key.
 * Only a real call can tell us). Uses the cheap models-list endpoint, header auth, no generation cost.
 */
export async function validateGeminiKey(
  apiKey: string | null | undefined,
  fetchImpl?: FetchLike,
  timeoutMs = 20_000,
): Promise<GeminiKeyValidation> {
  const key = (apiKey || '').trim()
  if (!key) return { valid: false, reason: 'no_key', detail: 'no Gemini API key in the vault' }
  const doFetch = fetchImpl || (globalThis.fetch as unknown as FetchLike)
  try {
    const res = await doFetch(`${GEMINI_API_BASE}/models`, {
      method: 'GET',
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = (await res.json()) as Record<string, unknown>
    const apiErr = body.error as { status?: string; message?: string } | undefined
    if (res.status !== 200 || apiErr) {
      return {
        valid: false,
        reason: classifyGeminiFailure(res.status, apiErr?.status),
        detail: redactKey(String(apiErr?.message ?? `HTTP ${res.status}`), key).slice(0, 200),
      }
    }
    const models = (body.models as unknown[] | undefined) ?? []
    return { valid: true, modelCount: models.length }
  } catch (err) {
    return {
      valid: false,
      reason: 'network',
      detail: redactKey(String(err instanceof Error ? err.message : err), key).slice(0, 200),
    }
  }
}
