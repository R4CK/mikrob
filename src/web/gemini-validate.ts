// Gemini API key probe-validator (card GEMINI-1). Verifies a candidate key
// against the live Gemini API BEFORE it is stored, so an invalid/typo'd key is
// rejected fail-closed instead of being persisted and silently failing later.
//
// SECURITY (Cybersec, trust boundary): the key is sent ONLY in the
// `x-goog-api-key` request header -- NEVER in the URL (URLs leak into proxy /
// access logs) -- and NEVER appears in any returned error string (the errors
// are fixed codes). The caller maps the code to a user-facing message.
//
// Drafted via the local-LLM offload (proactive-offload directive) and reviewed
// here for the no-leak contract; `fetchImpl`/`baseUrl` are injectable so it is
// unit-testable without the network.

export type GeminiValidateError = 'invalid' | 'unexpected' | 'network'

export async function validateGeminiKey(
  apiKey: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; baseUrl?: string },
): Promise<{ ok: boolean; error?: GeminiValidateError }> {
  const doFetch = opts?.fetchImpl ?? fetch
  const base = opts?.baseUrl ?? 'https://generativelanguage.googleapis.com'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 10_000)
  try {
    const response = await doFetch(`${base}/v1beta/models`, {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey }, // key in header, NEVER in the URL
      signal: controller.signal,
    })
    if (response.status === 200) return { ok: true }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return { ok: false, error: 'invalid' }
    }
    return { ok: false, error: 'unexpected' }
  } catch {
    // AbortError (timeout) or any network failure -> not validated (fail-closed).
    // Deliberately swallow the error object so neither the key nor the URL can
    // surface in a message.
    return { ok: false, error: 'network' }
  } finally {
    clearTimeout(timer)
  }
}
