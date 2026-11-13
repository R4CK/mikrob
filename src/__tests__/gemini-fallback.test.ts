import { describe, it, expect } from 'vitest'
import {
  decideGeminiFallback,
  switchNotification,
  confirmSwitchback,
  recordProbe,
  loadHysteresisConfigSync,
  type GeminiFallbackFacts,
  type SwitchbackProbe,
} from '../gemini-fallback.js'
import {
  classifyGeminiFailure,
  geminiGenerate,
  redactKey,
  validateGeminiKey,
  DEFAULT_GEMINI_MODEL,
  type FetchLike,
} from '../gemini-client.js'

// Card 2a418584. The security-relevant claims (key never in the URL, key never in an error string)
// each get a test that can FAIL -- those are the ones a Cybersec gate cares about.

const facts = (o: Partial<GeminiFallbackFacts> = {}): GeminiFallbackFacts => ({
  enabled: true,
  keyValid: true,
  claudeExhausted: false,
  route: 'claude',
  engagedAt: null,
  now: 1_000_000,
  minEngagementMs: 60_000,
  ...o,
})

describe('decideGeminiFallback -- engage', () => {
  it('engages when the Claude chain is exhausted', () => {
    expect(decideGeminiFallback(facts({ claudeExhausted: true }))).toEqual({
      kind: 'engage',
      reason: 'claude_exhausted',
    })
  })

  it('does NOT engage while Claude still has room', () => {
    expect(decideGeminiFallback(facts({ claudeExhausted: false })).kind).toBe('none')
  })

  it('FAIL-SAFE: never engages on an INVALID key -- a fleet that looks covered but is deaf is worse', () => {
    expect(decideGeminiFallback(facts({ claudeExhausted: true, keyValid: false })).kind).toBe('none')
  })

  it('FAIL-SAFE: never engages when disabled', () => {
    expect(decideGeminiFallback(facts({ claudeExhausted: true, enabled: false })).kind).toBe('none')
  })

  it('does not engage when Gemini itself is known-unavailable', () => {
    expect(
      decideGeminiFallback(facts({ claudeExhausted: true, geminiUnavailable: true })).kind,
    ).toBe('none')
  })
})

describe('decideGeminiFallback -- auto-revert (card requirement 4)', () => {
  const engaged = (o: Partial<GeminiFallbackFacts> = {}) =>
    facts({ route: 'gemini', engagedAt: 900_000, claudeExhausted: true, ...o })

  it('reverts to Claude once the limit clears AND the anti-flap window has passed', () => {
    // engagedAt 900_000, now 1_000_000 -> 100s elapsed >= 60s window
    expect(decideGeminiFallback(engaged({ claudeExhausted: false }))).toEqual({
      kind: 'revert',
      reason: 'claude_recovered',
    })
  })

  it('ANTI-FLAP: does NOT revert immediately when the limit clears inside the window', () => {
    expect(
      decideGeminiFallback(engaged({ claudeExhausted: false, now: 930_000 })).kind,
    ).toBe('none') // only 30s elapsed
  })

  it('stays on Gemini while Claude is still exhausted', () => {
    expect(decideGeminiFallback(engaged()).kind).toBe('none')
  })

  it('reverts IMMEDIATELY when Gemini itself fails, ignoring the anti-flap window', () => {
    expect(
      decideGeminiFallback(engaged({ geminiUnavailable: true, now: 900_001 })),
    ).toEqual({ kind: 'revert', reason: 'gemini_unavailable' })
  })

  it('reverts if the key stops validating while engaged', () => {
    expect(decideGeminiFallback(engaged({ keyValid: false })).kind).toBe('revert')
  })

  it('reverts if the feature is disabled while engaged', () => {
    expect(decideGeminiFallback(engaged({ enabled: false })).kind).toBe('revert')
  })
})

describe('switchNotification (card requirement 3)', () => {
  it('engage message names the model and flags the output as DRAFT (gate still applies)', () => {
    const msg = switchNotification({ kind: 'engage', reason: 'claude_exhausted' }, 'gemini-flash-latest')!
    expect(msg).toContain('GEMINI')
    expect(msg).toContain('gemini-flash-latest')
    expect(msg.toUpperCase()).toContain('DRAFT')
  })

  it('recovered vs unavailable revert produce DIFFERENT messages', () => {
    const a = switchNotification({ kind: 'revert', reason: 'claude_recovered' }, 'm')!
    const b = switchNotification({ kind: 'revert', reason: 'gemini_unavailable' }, 'm')!
    expect(a).not.toBe(b)
    expect(a).toContain('visszaallt')
  })

  it('no message for a no-op (we never spam Peti on a non-switch)', () => {
    expect(switchNotification({ kind: 'none' }, 'm')).toBeNull()
  })
})

// SWITCHBACK-HYSTERESIS-V1 (card 7f112c2f): the same rule store/quota-switchback.py's
// confirm_switchback() implements (grep SWITCHBACK-HYSTERESIS-V1 for both sides). Fixes the
// 23:15:41 OUTAGE -> 23:15:53 recovered 12s flap: a single clear probe must not switch back.
describe('confirmSwitchback (card 7f112c2f)', () => {
  const probe = (ok: boolean, ts: number): SwitchbackProbe => ({ ok, ts })

  it('requires at least confirmProbes entries', () => {
    expect(confirmSwitchback([probe(true, 0)], 2, 300)).toBe(false)
  })

  it('a single non-ok probe inside the trailing window breaks the run (the 12s-flap case)', () => {
    const log = [probe(true, 0), probe(false, 6_000), probe(true, 12_000)]
    expect(confirmSwitchback(log, 2, 300)).toBe(false)
  })

  it('two consecutive ok probes that are too close in time do not confirm', () => {
    const log = [probe(true, 0), probe(true, 12_000)]
    expect(confirmSwitchback(log, 2, 300)).toBe(false)
  })

  it('two consecutive ok probes >= minGapSec apart DO confirm', () => {
    const log = [probe(true, 0), probe(true, 301_000)]
    expect(confirmSwitchback(log, 2, 300)).toBe(true)
  })

  it('confirmProbes < 1 never confirms', () => {
    expect(confirmSwitchback([probe(true, 0), probe(true, 999_000)], 0, 300)).toBe(false)
  })

  // M3 (Cybersec NO-GO f859c361b): the 12s-flap case above is rejected by the gap check alone
  // (span < minGapSec either way) -- this case's span is >=300s, so only "a non-ok probe resets
  // the trailing run" rejects it. A mutant that lets a non-ok probe not reset the run would wrongly
  // confirm here.
  it('a non-ok probe straddling a >=minGapSec span still breaks the run', () => {
    const log = [probe(true, 0), probe(false, 150_000), probe(true, 310_000)]
    expect(confirmSwitchback(log, 2, 300)).toBe(false)
  })
})

describe('recordProbe (card 7f112c2f)', () => {
  it('appends without mutating the input array', () => {
    const log: SwitchbackProbe[] = [{ ok: true, ts: 1 }]
    const next = recordProbe(log, false, 2)
    expect(log).toHaveLength(1)
    expect(next).toEqual([{ ok: true, ts: 1 }, { ok: false, ts: 2 }])
  })

  it('trims to maxLen, keeping the newest entries', () => {
    const log: SwitchbackProbe[] = [{ ok: true, ts: 1 }, { ok: true, ts: 2 }]
    const next = recordProbe(log, true, 3, 2)
    expect(next).toEqual([{ ok: true, ts: 2 }, { ok: true, ts: 3 }])
  })
})

describe('loadHysteresisConfigSync (card 7f112c2f)', () => {
  it('reads valid confirmProbes/minGapSec from the file', () => {
    const cfg = loadHysteresisConfigSync(() => JSON.stringify({ confirmProbes: 3, minGapSec: 120 }), 'x')
    expect(cfg).toEqual({ confirmProbes: 3, minGapSec: 120 })
  })

  it('missing/unreadable file falls back to the documented defaults', () => {
    const cfg = loadHysteresisConfigSync(() => { throw new Error('ENOENT') }, 'x')
    expect(cfg).toEqual({ confirmProbes: 2, minGapSec: 300 })
  })

  it('out-of-range values fall back to the defaults rather than being trusted', () => {
    const cfg = loadHysteresisConfigSync(() => JSON.stringify({ confirmProbes: 0, minGapSec: -1 }), 'x')
    expect(cfg).toEqual({ confirmProbes: 2, minGapSec: 300 })
  })
})

describe('redactKey -- the key must never reach a log', () => {
  it('scrubs the exact key from an error string', () => {
    const k = 'AQ.Ab8RN6JnotarealkeyXXXXXXXXXXXXXXXXXXXXXXXX'
    expect(redactKey(`failed for key=${k} end`, k)).not.toContain(k)
    expect(redactKey(`failed for key=${k} end`, k)).toContain('***REDACTED***')
  })
  it('scrubs key-SHAPED tokens even when the key is not supplied (upstream echo)', () => {
    expect(redactKey('bad AIzaSyD1234567890abcdefghijklmnopqrs token')).toContain('***REDACTED***')
    expect(redactKey('bad AQ.Ab8RN6Jabcdefghijklmnopqrstuvwxyz012 token')).toContain('***REDACTED***')
  })
})

describe('classifyGeminiFailure', () => {
  it('maps the statuses we actually observed against the live API', () => {
    expect(classifyGeminiFailure(429, 'RESOURCE_EXHAUSTED')).toBe('quota')
    expect(classifyGeminiFailure(404, 'NOT_FOUND')).toBe('model_missing')
    expect(classifyGeminiFailure(403, 'PERMISSION_DENIED')).toBe('auth')
    expect(classifyGeminiFailure(500)).toBe('http')
  })
})

// A scripted fetch that RECORDS the request, so we can assert on how the key was transmitted.
function scriptedFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = []
  const f: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return { status, json: async () => body, text: async () => JSON.stringify(body) }
  }
  return { f, calls }
}

describe('geminiGenerate -- transport + security', () => {
  const KEY = 'AQ.Ab8RN6JsecretkeyvalueXXXXXXXXXXXXXXXXXXX'

  it('SECURITY: sends the key in the x-goog-api-key HEADER and NEVER in the URL', async () => {
    const { f, calls } = scriptedFetch(200, {
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
    })
    await geminiGenerate({ apiKey: KEY, prompt: 'p', fetchImpl: f })
    const call = calls[0]!
    expect(call.url).not.toContain(KEY)
    expect(call.url).not.toContain('key=') // no ?key= query form at all
    expect((call.init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY)
  })

  it('returns the joined candidate text and token usage on success', async () => {
    const { f } = scriptedFetch(200, {
      candidates: [{ content: { parts: [{ text: 'GEM' }, { text: 'INI' }] } }],
      usageMetadata: { totalTokenCount: 7 },
    })
    const r = await geminiGenerate({ apiKey: KEY, prompt: 'p', fetchImpl: f })
    expect(r.ok).toBe(true)
    expect(r.text).toBe('GEMINI')
    expect(r.totalTokens).toBe(7)
  })

  it('classifies a 429 as quota WITHOUT throwing (the runner branches on reason)', async () => {
    const { f } = scriptedFetch(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'out' } })
    const r = await geminiGenerate({ apiKey: KEY, prompt: 'p', fetchImpl: f })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('quota')
  })

  it('SECURITY: a key echoed back in an upstream error is redacted from `detail`', async () => {
    const { f } = scriptedFetch(400, { error: { status: 'INVALID', message: `bad key ${KEY}` } })
    const r = await geminiGenerate({ apiKey: KEY, prompt: 'p', fetchImpl: f })
    expect(r.detail).not.toContain(KEY)
    expect(r.detail).toContain('***REDACTED***')
  })

  it('missing key -> no_key, and no request is made at all', async () => {
    const { f, calls } = scriptedFetch(200, {})
    const r = await geminiGenerate({ apiKey: '', prompt: 'p', fetchImpl: f })
    expect(r.reason).toBe('no_key')
    expect(calls).toHaveLength(0)
  })

  it('uses the empirically-verified default model when none is given', async () => {
    const { f, calls } = scriptedFetch(200, { candidates: [{ content: { parts: [{ text: 'x' }] } }] })
    await geminiGenerate({ apiKey: KEY, prompt: 'p', fetchImpl: f })
    expect(calls[0]!.url).toContain(DEFAULT_GEMINI_MODEL)
  })
})

describe('validateGeminiKey', () => {
  it('valid key -> reports the model count', async () => {
    const { f } = scriptedFetch(200, { models: [{ name: 'models/a' }, { name: 'models/b' }] })
    const v = await validateGeminiKey('AQ.Akey', f)
    expect(v.valid).toBe(true)
    expect(v.modelCount).toBe(2)
  })

  it('rejects an empty key without a network call', async () => {
    const { f, calls } = scriptedFetch(200, {})
    expect((await validateGeminiKey('', f)).reason).toBe('no_key')
    expect(calls).toHaveLength(0)
  })

  it('403 -> auth failure (not a generic http error)', async () => {
    const { f } = scriptedFetch(403, { error: { status: 'PERMISSION_DENIED', message: 'nope' } })
    const v = await validateGeminiKey('AQ.Akey', f)
    expect(v.valid).toBe(false)
    expect(v.reason).toBe('auth')
  })

  it('SECURITY: validation uses header auth, never a ?key= URL', async () => {
    const { f, calls } = scriptedFetch(200, { models: [] })
    await validateGeminiKey('AQ.AsecretXXXXXXXXXXXXXXXXXXXXXXXXXXXX', f)
    expect(calls[0]!.url).not.toContain('key=')
    expect((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBeTruthy()
  })
})
