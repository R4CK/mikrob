// Card c116696f (AUTOUPDNODEENV905 half 2/2 -- half 1/2 landed as update.sh's own --include=dev on
// both npm ci sites, card 50af1a27). buildUpdateScriptEnv is the exact function spawnUpdateScript
// calls to build the env for update.sh: no parallel implementation, so this pins the real code
// path rather than a lookalike.
//
// Under NODE_ENV=production a plain `npm ci` prunes dev dependencies (the compiler included),
// measured on this host in card 50af1a27's own test (update-npm-ci-dev-deps.test.ts). If this
// process ever inherits NODE_ENV=production from whatever launched it, that pruning happens
// regardless of --include=dev being present in update.sh's own source, unless something strips the
// value before the child is spawned. This is that something.
import { describe, it, expect, afterEach } from 'vitest'
import { buildUpdateScriptEnv } from '../web/routes/updates.js'

describe('buildUpdateScriptEnv strips NODE_ENV before spawning update.sh (card c116696f)', () => {
  const original = process.env.NODE_ENV
  const marker = 'MARVEEN_TEST_MARKER_C116696F'

  afterEach(() => {
    if (original === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = original
    delete process.env[marker]
  })

  it('strips an inherited production NODE_ENV from the returned env', () => {
    process.env.NODE_ENV = 'production'
    const env = buildUpdateScriptEnv({})
    expect(env.NODE_ENV).toBeUndefined()
  })

  it('strips it from the REAL process.env, not only the returned copy -- update.sh spawns npm ci at multiple sites, each inheriting process.env independently', () => {
    process.env.NODE_ENV = 'production'
    buildUpdateScriptEnv({})
    expect(process.env.NODE_ENV).toBeUndefined()
  })

  it('is a no-op, not a throw, when NODE_ENV was never set', () => {
    delete process.env.NODE_ENV
    expect(() => buildUpdateScriptEnv({})).not.toThrow()
    expect(buildUpdateScriptEnv({}).NODE_ENV).toBeUndefined()
  })

  it('extraEnv is layered on top and still wins over anything inherited', () => {
    process.env.NODE_ENV = 'production'
    process.env[marker] = 'inherited'
    const env = buildUpdateScriptEnv({ [marker]: 'from-extraEnv', AUTO_STASH: '1' })
    expect(env[marker]).toBe('from-extraEnv')
    expect(env.AUTO_STASH).toBe('1')
    expect(env.NODE_ENV).toBeUndefined()
  })

  it('other inherited env vars survive untouched -- this deletes ONE key, not the whole environment', () => {
    process.env[marker] = 'still-here'
    const env = buildUpdateScriptEnv({})
    expect(env[marker]).toBe('still-here')
  })
})
