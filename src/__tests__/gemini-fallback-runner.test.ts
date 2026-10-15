// Integration-light tests for gemini-fallback-runner (card 5f5409fd).
//
// Strategy: the pure decision logic is tested in gemini-fallback.test.ts (27 tests).
// Here we test only the runner's own logic: state reads/writes, key-validation
// caching, the claudeExhausted mapping from weekly-hard-stop.json, and the
// Telegram gate (key never in message, notify only on route change).
// We do NOT call the real Gemini API or write to the real store/ -- all I/O is
// replaced by in-memory fakes.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { GeminiFallbackState } from '../gemini-fallback-runner.js'
import type { GeminiKeyValidation } from '../gemini-client.js'

/** Mirrors the runner's own fingerprintKey() -- node:crypto is NOT mocked here. */
const sha256 = (key: string): string => createHash('sha256').update(key).digest('hex')

// --- Fakes ---------------------------------------------------------------

const fakeState: GeminiFallbackState = {
  route: 'claude',
  engagedAt: null,
  lastKeyCheck: null,
  keyValid: false,
  lastRun: null,
  keyFingerprint: null,
}
let writtenState: GeminiFallbackState | null = null
let telegramMessages: string[] = []
let weeklyActive = false
let weeklyNewDevStopActive = false
let sessionOutageActive = false
/** How old (ms) the marker's `heartbeat` field is, relative to "now" -- 0 by default (fresh). */
let sessionOutageHeartbeatAgoMs = 0
/** When set, overrides the entire marker body written to disk (H2: malformed/legacy shapes). */
let sessionOutageRawOverride: Record<string, unknown> | null = null
/** null = no config file on disk (real.readFileSync throws ENOENT) -> exercises the default. */
let engageConfigJson: string | null = null
let apiKey = 'fake-api-key-that-is-long-enough'
let keyValidResult: GeminiKeyValidation = { valid: true, modelCount: 50 }

vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return {
    ...real,
    readFileSync: vi.fn((path: string) => {
      const p = String(path)
      if (p.endsWith('gemini-fallback-state.json')) {
        return JSON.stringify(fakeState)
      }
      if (p.endsWith('weekly-hard-stop.json')) {
        return JSON.stringify({ active: weeklyActive, newDevStopActive: weeklyNewDevStopActive })
      }
      if (p.endsWith('mikrob-session-outage.json')) {
        if (!sessionOutageActive) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        if (sessionOutageRawOverride !== null) return JSON.stringify(sessionOutageRawOverride)
        const heartbeat = (Date.now() - sessionOutageHeartbeatAgoMs) / 1000
        return JSON.stringify({ active: true, since: Date.now(), heartbeat })
      }
      if (p.endsWith('gemini-fallback-config.json')) {
        if (engageConfigJson === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return engageConfigJson
      }
      return real.readFileSync(path)
    }),
    writeFileSync: vi.fn((_path: string, data: string) => {
      const p = String(_path)
      if (p.endsWith('gemini-fallback-state.json')) {
        writtenState = JSON.parse(data)
      }
    }),
    existsSync: real.existsSync,
  }
})

vi.mock('../gemini-client.js', () => ({
  validateGeminiKey: vi.fn(async () => keyValidResult),
  DEFAULT_GEMINI_MODEL: 'gemini-flash-latest',
  GEMINI_VAULT_KEY_ID: 'integration.gemini.apiKey',
  redactKey: (t: string) => t,
}))

vi.mock('../web/vault.js', () => ({
  getSecret: vi.fn(() => apiKey),
}))

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({
    TELEGRAM_BOT_TOKEN: 'fake-token',
    ALLOWED_CHAT_ID: '12345',
  })),
}))

// Capture Telegram sends without a real HTTP call
const realFetch = globalThis.fetch
beforeEach(() => {
  telegramMessages = []
  writtenState = null
  weeklyActive = false
  weeklyNewDevStopActive = false
  sessionOutageActive = false
  sessionOutageHeartbeatAgoMs = 0
  sessionOutageRawOverride = null
  engageConfigJson = null
  keyValidResult = { valid: true, modelCount: 50 }
  apiKey = 'fake-api-key-that-is-long-enough'
  fakeState.route = 'claude'
  fakeState.engagedAt = null
  fakeState.lastKeyCheck = null
  fakeState.keyValid = false
  fakeState.lastRun = null
  fakeState.keyFingerprint = null
  globalThis.fetch = vi.fn(async (url: string, opts: RequestInit) => {
    if (String(url).includes('api.telegram.org')) {
      const body = JSON.parse(String(opts.body))
      telegramMessages.push(body.text)
      return { ok: true, status: 200, text: async () => '' } as Response
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch
})

// ----- Tests --------------------------------------------------------------

import { runGeminiFallbackCheck } from '../gemini-fallback-runner.js'

describe('runGeminiFallbackCheck -- engage path', () => {
  it('engages when weekly is exhausted and key is valid', async () => {
    weeklyActive = true
    await runGeminiFallbackCheck()
    expect(writtenState?.route).toBe('gemini')
    expect(writtenState?.engagedAt).toBeTypeOf('number')
  })

  it('sends exactly ONE Telegram message on engage', async () => {
    weeklyActive = true
    await runGeminiFallbackCheck()
    expect(telegramMessages).toHaveLength(1)
  })

  it('Telegram message on engage NEVER contains the API key', async () => {
    weeklyActive = true
    apiKey = 'AQ.AVery-distinctive-secret-key-value-1234567890'
    await runGeminiFallbackCheck()
    expect(telegramMessages[0]).not.toContain(apiKey)
  })

  it('does NOT engage when key is invalid, even if Claude is exhausted', async () => {
    weeklyActive = true
    keyValidResult = { valid: false as const, reason: 'auth' as const, detail: 'PERMISSION_DENIED' }
    await runGeminiFallbackCheck()
    expect(writtenState?.route).toBe('claude')
    expect(telegramMessages).toHaveLength(0)
  })
})

describe('runGeminiFallbackCheck -- revert path', () => {
  it('reverts when on Gemini but Claude has recovered', async () => {
    fakeState.route = 'gemini'
    fakeState.engagedAt = Date.now() - 50 * 60 * 1000  // 50 min ago > 45 min anti-flap (F2)
    weeklyActive = false
    await runGeminiFallbackCheck()
    expect(writtenState?.route).toBe('claude')
    expect(writtenState?.engagedAt).toBeNull()
  })

  it('sends exactly ONE Telegram message on revert', async () => {
    fakeState.route = 'gemini'
    fakeState.engagedAt = Date.now() - 50 * 60 * 1000
    weeklyActive = false
    await runGeminiFallbackCheck()
    expect(telegramMessages).toHaveLength(1)
  })

  it('respects the anti-flap window: does NOT revert too quickly', async () => {
    fakeState.route = 'gemini'
    fakeState.engagedAt = Date.now() - 20 * 60 * 1000  // 20 min ago < 45 min (F2)
    weeklyActive = false
    await runGeminiFallbackCheck()
    expect(writtenState?.route).toBe('gemini')
    expect(telegramMessages).toHaveLength(0)
  })
})

describe('runGeminiFallbackCheck -- no-op path', () => {
  it('does nothing when Claude is fine and we are on Claude', async () => {
    weeklyActive = false
    await runGeminiFallbackCheck()
    expect(writtenState?.route).toBe('claude')
    expect(telegramMessages).toHaveLength(0)
  })

  it('updates lastRun even on no-op', async () => {
    weeklyActive = false
    await runGeminiFallbackCheck()
    expect(writtenState?.lastRun).toBeTypeOf('number')
  })
})

describe('key validation caching', () => {
  it('skips re-validation when lastKeyCheck is recent AND the key is unchanged', async () => {
    const { validateGeminiKey } = await import('../gemini-client.js')
    fakeState.keyValid = true
    fakeState.lastKeyCheck = Date.now() - 5 * 60 * 1000  // 5 min ago < 1h TTL
    fakeState.keyFingerprint = sha256(apiKey)  // same key as this run will read -- cache applies
    weeklyActive = false
    vi.clearAllMocks()  // reset call count
    await runGeminiFallbackCheck()
    expect(validateGeminiKey).not.toHaveBeenCalled()
  })

  it('re-validates when lastKeyCheck is stale (> 1h)', async () => {
    const { validateGeminiKey } = await import('../gemini-client.js')
    fakeState.lastKeyCheck = Date.now() - 70 * 60 * 1000  // 70 min ago
    weeklyActive = false
    vi.clearAllMocks()
    await runGeminiFallbackCheck()
    expect(validateGeminiKey).toHaveBeenCalledOnce()
  })
})

// Card 3de7d530: claudeExhausted also engages at the 85% newDevStop threshold, not just the
// 98% hard stop, gated by a configurable engageOn switch defaulting to "newDevStop".
describe('newDevStop engagement (card 3de7d530)', () => {
  it('engages on newDevStopActive alone (hard stop still false), default config', async () => {
    weeklyActive = false
    weeklyNewDevStopActive = true
    await runGeminiFallbackCheck()
    expect(writtenState?.route).toBe('gemini')
  })

  it('missing config file behaves like the default ("newDevStop") -- engages on newDevStopActive', async () => {
    engageConfigJson = null
    weeklyActive = false
    weeklyNewDevStopActive = true
    await runGeminiFallbackCheck()
    expect(writtenState?.route).toBe('gemini')
  })

  it('engageOn: "hardStopOnly" does NOT engage on newDevStopActive alone', async () => {
    engageConfigJson = JSON.stringify({ engageOn: 'hardStopOnly' })
    weeklyActive = false
    weeklyNewDevStopActive = true
    await runGeminiFallbackCheck()
    expect(writtenState?.route).toBe('claude')
  })

  it('engageOn: "hardStopOnly" still engages on the real hard stop (active)', async () => {
    engageConfigJson = JSON.stringify({ engageOn: 'hardStopOnly' })
    weeklyActive = true
    weeklyNewDevStopActive = false
    await runGeminiFallbackCheck()
    expect(writtenState?.route).toBe('gemini')
  })

  it('an invalid engageOn value in the config falls back to the "newDevStop" default', async () => {
    engageConfigJson = JSON.stringify({ engageOn: 'bogus' })
    weeklyActive = false
    weeklyNewDevStopActive = true
    await runGeminiFallbackCheck()
    expect(writtenState?.route).toBe('gemini')
  })

  it('reverts once both thresholds clear, same as the existing revert path', async () => {
    fakeState.route = 'gemini'
    fakeState.engagedAt = Date.now() - 50 * 60 * 1000  // > 45 min anti-flap (F2)
    weeklyActive = false
    weeklyNewDevStopActive = false
    await runGeminiFallbackCheck()
    expect(writtenState?.route).toBe('claude')
  })
})

// Card 612058c2: a Claude SESSION-level quota outage (quota-bridge.py's Ghost mode) is a harder
// signal than newDevStop and must engage Gemini regardless of the engageOn config -- unlike
// newDevStopActive, there is no "Claude can still finish in-flight work" case here.
describe('session-outage engagement (card 612058c2)', () => {
  it('engages on sessionOutageActive alone, both weekly flags false, default config', async () => {
    weeklyActive = false
    weeklyNewDevStopActive = false
    sessionOutageActive = true
    await runGeminiFallbackCheck()
    expect(writtenState?.route).toBe('gemini')
  })

  it('engages on sessionOutageActive even with engageOn: "hardStopOnly"', async () => {
    engageConfigJson = JSON.stringify({ engageOn: 'hardStopOnly' })
    weeklyActive = false
    weeklyNewDevStopActive = false
    sessionOutageActive = true
    await runGeminiFallbackCheck()
    expect(writtenState?.route).toBe('gemini')
  })

  it('does NOT engage when the session-outage marker is absent (default/healthy state)', async () => {
    weeklyActive = false
    weeklyNewDevStopActive = false
    sessionOutageActive = false
    await runGeminiFallbackCheck()
    expect(writtenState?.route).toBe('claude')
  })

  it('reverts once the session-outage marker clears, same as the existing revert path', async () => {
    fakeState.route = 'gemini'
    fakeState.engagedAt = Date.now() - 50 * 60 * 1000  // > 45 min anti-flap (F2)
    weeklyActive = false
    weeklyNewDevStopActive = false
    sessionOutageActive = false
    await runGeminiFallbackCheck()
    expect(writtenState?.route).toBe('claude')
  })

  it('does NOT engage when key is invalid, even during a session outage (fail-safe bias unchanged)', async () => {
    sessionOutageActive = true
    keyValidResult = { valid: false as const, reason: 'auth' as const, detail: 'PERMISSION_DENIED' }
    await runGeminiFallbackCheck()
    expect(writtenState?.route).toBe('claude')
  })

  // H2 regression (WhiteHat2 NO-GO, card 612058c2 delta-gate @c5e5ec28): quota-bridge.py's
  // outage_loop() only clears the marker in a `finally` block -- a SIGKILL/OOM/host-restart mid-
  // outage leaves `active: true` behind forever, with nothing left alive to clear it. A stale
  // heartbeat must therefore read as NOT outage, same fail-safe-toward-Claude direction as a
  // missing file.
  describe('H2: stale marker fail-safe', () => {
    it('a fresh heartbeat (a moment ago) still engages', async () => {
      sessionOutageActive = true
      sessionOutageHeartbeatAgoMs = 5_000 // 5s old
      await runGeminiFallbackCheck()
      expect(writtenState?.route).toBe('gemini')
    })

    it('a heartbeat exactly at the staleness boundary (15 min) still engages', async () => {
      sessionOutageActive = true
      sessionOutageHeartbeatAgoMs = 15 * 60 * 1000
      await runGeminiFallbackCheck()
      expect(writtenState?.route).toBe('gemini')
    })

    it('a heartbeat just past the staleness boundary (15 min + 1s) does NOT engage', async () => {
      sessionOutageActive = true
      sessionOutageHeartbeatAgoMs = 15 * 60 * 1000 + 1_000
      await runGeminiFallbackCheck()
      expect(writtenState?.route).toBe('claude')
    })

    it('a 3-day-old marker (the exact SIGKILL scenario measured in the NO-GO) does NOT engage', async () => {
      sessionOutageActive = true
      sessionOutageHeartbeatAgoMs = 3 * 24 * 60 * 60 * 1000
      await runGeminiFallbackCheck()
      expect(writtenState?.route).toBe('claude')
    })

    it('a legacy marker with no heartbeat field at all does NOT engage (fail-safe, not fail-open)', async () => {
      sessionOutageActive = true
      sessionOutageRawOverride = { active: true, since: Date.now() }
      await runGeminiFallbackCheck()
      expect(writtenState?.route).toBe('claude')
    })

    it('a non-numeric heartbeat does NOT engage', async () => {
      sessionOutageActive = true
      sessionOutageRawOverride = { active: true, since: Date.now(), heartbeat: 'yesterday' }
      await runGeminiFallbackCheck()
      expect(writtenState?.route).toBe('claude')
    })
  })
})

// CYBERED NO-GO on card 3de7d530 (comment 17031): F1 (key-validity cache not bound to which
// key was checked, future-dated timestamps never re-checked) and F2 (anti-flap window shorter
// than the run schedule) fixed in gemini-fallback-runner.ts. These tests pin the fix.
describe('CYBERED NO-GO fixes (comment 17031)', () => {
  it('S4: an EMPTY key (deleted from the vault) is invalid immediately, even though the 1h cache would otherwise still trust it', async () => {
    fakeState.keyValid = true
    fakeState.lastKeyCheck = Date.now() - 1 * 60 * 1000  // 1 min ago, well within the 1h TTL
    fakeState.keyFingerprint = 'fingerprint-of-a-key-that-is-now-gone'
    apiKey = ''  // the key was deleted from the vault
    weeklyActive = true  // Claude exhausted -- would otherwise engage
    await runGeminiFallbackCheck()
    expect(writtenState?.keyValid).toBe(false)
    expect(writtenState?.route).toBe('claude')
  })

  it('S4b: a ROTATED key (different fingerprint) is re-validated immediately, not trusted via the old key\'s cached verdict', async () => {
    const { validateGeminiKey } = await import('../gemini-client.js')
    fakeState.keyValid = true
    fakeState.lastKeyCheck = Date.now() - 1 * 60 * 1000  // 1 min ago, well within the 1h TTL
    fakeState.keyFingerprint = 'fingerprint-of-the-OLD-key'
    apiKey = 'a-brand-new-rotated-key-value'  // different key -> different fingerprint
    keyValidResult = { valid: false as const, reason: 'auth' as const, detail: 'PERMISSION_DENIED' }
    weeklyActive = true
    vi.clearAllMocks()
    await runGeminiFallbackCheck()
    expect(validateGeminiKey).toHaveBeenCalledOnce()
    expect(writtenState?.keyValid).toBe(false)
    expect(writtenState?.route).toBe('claude')
  })

  it('S6a: a FUTURE-dated lastKeyCheck (tampered state) does not suppress re-validation, even for the SAME key (isolates the timestamp fix from the fingerprint fix)', async () => {
    const { validateGeminiKey } = await import('../gemini-client.js')
    apiKey = 'currently-invalid-key'
    fakeState.keyValid = true
    fakeState.lastKeyCheck = Date.now() + 365 * 24 * 60 * 60 * 1000  // 1 year in the future
    fakeState.keyFingerprint = sha256(apiKey)  // SAME key -- a fingerprint mismatch would mask this
    keyValidResult = { valid: false as const, reason: 'auth' as const, detail: 'PERMISSION_DENIED' }
    weeklyActive = true
    vi.clearAllMocks()
    await runGeminiFallbackCheck()
    expect(validateGeminiKey).toHaveBeenCalledOnce()
    expect(writtenState?.keyValid).toBe(false)
    expect(writtenState?.route).toBe('claude')
  })

  it('S6b: a FUTURE-dated engagedAt (tampered state) does not block an otherwise-eligible revert', async () => {
    fakeState.route = 'gemini'
    fakeState.engagedAt = Date.now() + 365 * 24 * 60 * 60 * 1000  // 1 year in the future
    weeklyActive = false  // Claude has recovered
    await runGeminiFallbackCheck()
    expect(writtenState?.route).toBe('claude')
  })

  it('S7: a 15-minute-interval flap sequence around the threshold does not flip the route every run (F2)', async () => {
    // Simulate 2 consecutive runs 15 real minutes apart (the runner's own schedule) with weekly
    // usage oscillating around the threshold (exhausted, then clear). Before the F2 fix (10 min
    // anti-flap on a 15 min schedule) this flapped on every run; after it (45 min anti-flap), it
    // should not revert on the FIRST clear run that follows an engage. Must use fake timers:
    // without advancing simulated time, both real calls land within the same millisecond and
    // the anti-flap window binds regardless of MIN_ENGAGEMENT_MS, making the test vacuous.
    vi.useFakeTimers()
    try {
      weeklyActive = true
      await runGeminiFallbackCheck()  // run 1: engage
      expect(writtenState?.route).toBe('gemini')
      fakeState.route = writtenState!.route
      fakeState.engagedAt = writtenState!.engagedAt
      fakeState.keyValid = writtenState!.keyValid
      fakeState.lastKeyCheck = writtenState!.lastKeyCheck
      fakeState.keyFingerprint = writtenState!.keyFingerprint

      vi.advanceTimersByTime(15 * 60 * 1000)  // 15 min later, the runner's own schedule
      weeklyActive = false  // briefly clear -- must NOT revert yet
      await runGeminiFallbackCheck()
      expect(writtenState?.route).toBe('gemini')
    } finally {
      vi.useRealTimers()
    }
  })
})
