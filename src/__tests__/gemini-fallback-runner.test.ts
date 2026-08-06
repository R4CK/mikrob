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
import type { GeminiFallbackState } from '../gemini-fallback-runner.js'
import type { GeminiKeyValidation } from '../gemini-client.js'

// --- Fakes ---------------------------------------------------------------

const fakeState: GeminiFallbackState = {
  route: 'claude',
  engagedAt: null,
  lastKeyCheck: null,
  keyValid: false,
  lastRun: null,
}
let writtenState: GeminiFallbackState | null = null
let telegramMessages: string[] = []
let weeklyActive = false
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
        return JSON.stringify({ active: weeklyActive })
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
  keyValidResult = { valid: true, modelCount: 50 }
  apiKey = 'fake-api-key-that-is-long-enough'
  fakeState.route = 'claude'
  fakeState.engagedAt = null
  fakeState.lastKeyCheck = null
  fakeState.keyValid = false
  fakeState.lastRun = null
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
    fakeState.engagedAt = Date.now() - 20 * 60 * 1000  // 20 min ago > 10 min anti-flap
    weeklyActive = false
    await runGeminiFallbackCheck()
    expect(writtenState?.route).toBe('claude')
    expect(writtenState?.engagedAt).toBeNull()
  })

  it('sends exactly ONE Telegram message on revert', async () => {
    fakeState.route = 'gemini'
    fakeState.engagedAt = Date.now() - 20 * 60 * 1000
    weeklyActive = false
    await runGeminiFallbackCheck()
    expect(telegramMessages).toHaveLength(1)
  })

  it('respects the anti-flap window: does NOT revert too quickly', async () => {
    fakeState.route = 'gemini'
    fakeState.engagedAt = Date.now() - 2 * 60 * 1000  // only 2 min ago < 10 min
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
  it('skips re-validation when lastKeyCheck is recent', async () => {
    const { validateGeminiKey } = await import('../gemini-client.js')
    fakeState.keyValid = true
    fakeState.lastKeyCheck = Date.now() - 5 * 60 * 1000  // 5 min ago < 1h TTL
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
