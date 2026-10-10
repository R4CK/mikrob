// Card f1800242: the customProvider registry. Peti's decision (Telegram 10874, 2026-10-10):
// loopback-only base-url, no external/paid API endpoint may be registered.
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import {
  assertLoopbackBaseUrl,
  listCustomProviders,
  writeCustomProviders,
  getCustomProviderOrThrow,
  CustomProviderValidationError,
  type CustomProviderDef,
} from '../web/custom-providers.js'

const REGISTRY_PATH = join(PROJECT_ROOT, 'store', 'custom-providers.json')
const EXISTED_BEFORE = existsSync(REGISTRY_PATH)

afterEach(() => {
  if (!EXISTED_BEFORE) { try { rmSync(REGISTRY_PATH) } catch { /* best-effort */ } }
})

describe('assertLoopbackBaseUrl: fail-closed, no DNS resolution', () => {
  it('accepts literal loopback forms', () => {
    for (const url of [
      'http://127.0.0.1:11434',
      'http://127.255.255.254:8080',
      'http://localhost:1234',
      'http://LOCALHOST:1234', // case-insensitive
      'http://[::1]:11434',
      'http://[::ffff:127.0.0.1]:11434',
      'https://127.0.0.1',
    ]) {
      expect(() => assertLoopbackBaseUrl(url), url).not.toThrow()
    }
  })

  it('rejects every non-loopback and malformed form (DNS-rebinding, 0.0.0.0, scheme)', () => {
    for (const url of [
      'http://localhost.evil.com:11434', // substring trick, not the literal host
      'http://evil-localhost:11434',
      'http://0.0.0.0:11434',
      'http://10.0.0.5:11434', // private but not loopback
      'http://93.184.216.34', // public IP
      'http://[::2]',
      'http://[::ffff:10.0.0.1]', // IPv4-mapped but not 127.x
      'ftp://127.0.0.1',
      'not a url at all',
      '',
    ]) {
      expect(() => assertLoopbackBaseUrl(url), url).toThrow(CustomProviderValidationError)
    }
  })
})

describe('writeCustomProviders / listCustomProviders: round-trip + fail-closed save', () => {
  it('round-trips a valid entry', () => {
    const def: CustomProviderDef = { id: 'my-ollama', baseUrl: 'http://127.0.0.1:11434', secretId: 'my-ollama-key' }
    writeCustomProviders([def])
    expect(listCustomProviders()).toEqual([def])
  })

  it('no file yet -> empty list, never a throw', () => {
    expect(listCustomProviders()).toEqual([])
  })

  it('rejects a non-loopback baseUrl at SAVE time -- nothing is written', () => {
    expect(() => writeCustomProviders([
      { id: 'bad', baseUrl: 'https://api.example.com', secretId: 'x' },
    ])).toThrow(CustomProviderValidationError)
    expect(existsSync(REGISTRY_PATH)).toBe(false)
  })

  it('a bad entry refuses the WHOLE write, not just that entry', () => {
    writeCustomProviders([{ id: 'good', baseUrl: 'http://127.0.0.1:1', secretId: 'g' }])
    expect(() => writeCustomProviders([
      { id: 'good', baseUrl: 'http://127.0.0.1:1', secretId: 'g' },
      { id: 'bad', baseUrl: 'https://api.example.com', secretId: 'x' },
    ])).toThrow()
    // The earlier, valid write is untouched (atomic write never ran for the bad call).
    expect(listCustomProviders()).toEqual([{ id: 'good', baseUrl: 'http://127.0.0.1:1', secretId: 'g' }])
  })

  it('rejects duplicate ids', () => {
    expect(() => writeCustomProviders([
      { id: 'dup', baseUrl: 'http://127.0.0.1:1', secretId: 'a' },
      { id: 'dup', baseUrl: 'http://127.0.0.1:2', secretId: 'b' },
    ])).toThrow(CustomProviderValidationError)
  })

  // WhiteHat L3 (card f1800242): the stored file is reachable via fleet-transfer import,
  // which bypasses writeCustomProviders' own validation -- listCustomProviders must re-validate
  // at READ time too, mutation-verified: a hand-written non-loopback entry must throw on read.
  it('re-validates at READ time -- a hand-tampered file with a non-loopback baseUrl throws on list()', async () => {
    const fs = await import('node:fs')
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify({
      providers: [{ id: 'tampered', baseUrl: 'https://api.example.com', secretId: 'x' }],
    }))
    expect(() => listCustomProviders()).toThrow(CustomProviderValidationError)
  })

  it('a corrupt file throws rather than silently returning an empty/partial list', async () => {
    const fs = await import('node:fs')
    fs.writeFileSync(REGISTRY_PATH, '{ not json')
    expect(() => listCustomProviders()).toThrow(CustomProviderValidationError)
  })
})

describe('getCustomProviderOrThrow: fail-closed lookup', () => {
  it('returns the matching entry', () => {
    writeCustomProviders([{ id: 'found-me', baseUrl: 'http://127.0.0.1:9', secretId: 's' }])
    expect(getCustomProviderOrThrow('found-me')).toEqual({ id: 'found-me', baseUrl: 'http://127.0.0.1:9', secretId: 's' })
  })

  it('throws (never null/undefined) for an unregistered id', () => {
    writeCustomProviders([{ id: 'other', baseUrl: 'http://127.0.0.1:9', secretId: 's' }])
    expect(() => getCustomProviderOrThrow('not-registered')).toThrow(CustomProviderValidationError)
  })

  it('throws when the registry file does not exist at all', () => {
    expect(existsSync(REGISTRY_PATH)).toBe(false)
    expect(() => getCustomProviderOrThrow('anything')).toThrow(CustomProviderValidationError)
  })
})
