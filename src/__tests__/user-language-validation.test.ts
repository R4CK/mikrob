// N3 config validation (card d4c89ff1, WhiteHat gap finding, comment 25661): config.ts's
// USER_LANGUAGE validation (BCP-47 basic, ^[a-z]{2}(-[A-Z]{2})?$, falls back to 'hu') had NO test
// -- the only test file mentioning USER_LANGUAGE (language-section.test.ts) mocks ../config.js
// entirely, so src/config.ts's own validation line never actually ran under any test. USER_LANGUAGE
// is a module-level const computed once at import time from readEnvFile(), so each case here needs
// its own fresh module instance (vi.resetModules() + dynamic re-import), not a single shared import.
import { describe, it, expect, vi } from 'vitest'

let envValues: Record<string, string> = {}
vi.mock('../env.js', () => ({ readEnvFile: () => ({ ...envValues }), updateEnvFile: vi.fn() }))

async function loadUserLanguage(value: string | undefined): Promise<string> {
  envValues = value === undefined ? {} : { USER_LANGUAGE: value }
  vi.resetModules()
  return (await import('../config.js')).USER_LANGUAGE
}

describe('config.ts USER_LANGUAGE validation', () => {
  const rejected = [
    '$&', "$'", '$`', '$1', 'x$&y', // replacer-injection shapes (the N3 vuln class)
    'en\n', '\nen', ' en', 'en ', // whitespace/newline
    'EN', 'en-us', // case
    'eng', 'english', '', 'e', 'en-USA', // shape
  ]
  for (const bad of rejected) {
    it(`falls back to hu for ${JSON.stringify(bad)}`, async () => {
      expect(await loadUserLanguage(bad)).toBe('hu')
    })
  }

  const accepted = ['en', 'de', 'hu', 'pt-BR', 'zh-CN']
  for (const ok of accepted) {
    it(`keeps a valid value: ${ok}`, async () => {
      expect(await loadUserLanguage(ok)).toBe(ok)
    })
  }

  it('absent env var falls back to hu', async () => {
    expect(await loadUserLanguage(undefined)).toBe('hu')
  })
})
