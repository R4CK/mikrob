// Card 651ee11f (WhiteHat2 CYBERSEC GO on 758e06dd, L3): buildUpdateScriptEnv moved from a
// denylist (full inherited process.env, specific bad keys deleted) to an ALLOWLIST (known-safe
// base login keys + whatever extraEnv explicitly names). The root problem: update.sh reads
// several control switches straight from its own environment, with no CLI-flag equivalent --
// FORCE_REBUILD, UPDATE_AUTO_REBASE, RESEED_FLEET, REGEN_CLAUDEMD, POST_MERGE_OLD_SHA. Under the
// old denylist, any of these inherited from whatever launched this dashboard process (a debug
// run, a systemd unit, an operator shell) silently rode along into every ordinary fork-pull
// update, not just the one invocation that meant to set it.
//
// buildUpdateScriptEnv is the exact function spawnUpdateScript calls to build the env for
// update.sh: no parallel implementation, so these pin the real code path, not a lookalike.
import { describe, it, expect, afterEach } from 'vitest'
import { buildUpdateScriptEnv } from '../web/routes/updates.js'

// Every switch update.sh reads straight from its environment, named in the card itself.
const CONTROL_SWITCHES = ['FORCE_REBUILD', 'UPDATE_AUTO_REBASE', 'RESEED_FLEET', 'REGEN_CLAUDEMD', 'POST_MERGE_OLD_SHA']

describe('buildUpdateScriptEnv: control switches NOT from inherited env, YES from extraEnv (card 651ee11f)', () => {
  afterEach(() => {
    for (const key of CONTROL_SWITCHES) delete process.env[key]
  })

  for (const key of CONTROL_SWITCHES) {
    it(`${key}: an inherited value does not cross over`, () => {
      process.env[key] = '1'
      const env = buildUpdateScriptEnv({})
      expect(env[key]).toBeUndefined()
    })

    it(`${key}: an explicit extraEnv value does cross over, even with nothing inherited`, () => {
      delete process.env[key]
      const env = buildUpdateScriptEnv({ [key]: '1' })
      expect(env[key]).toBe('1')
    })
  }
})

describe('buildUpdateScriptEnv: base login keys survive, everything else does not (card 651ee11f)', () => {
  const marker = 'MARVEEN_TEST_MARKER_651EE11F'
  const original = { PATH: process.env.PATH, HOME: process.env.HOME }

  afterEach(() => {
    delete process.env[marker]
    if (original.PATH === undefined) delete process.env.PATH
    else process.env.PATH = original.PATH
    if (original.HOME === undefined) delete process.env.HOME
    else process.env.HOME = original.HOME
  })

  it('PATH and HOME, when set on this process, are carried over unchanged', () => {
    process.env.PATH = '/test/bin:/usr/bin'
    process.env.HOME = '/test/home'
    const env = buildUpdateScriptEnv({})
    expect(env.PATH).toBe('/test/bin:/usr/bin')
    expect(env.HOME).toBe('/test/home')
  })

  it('an arbitrary non-base inherited var is excluded entirely, not just a hand-picked denylist of bad names', () => {
    process.env[marker] = 'inherited'
    const env = buildUpdateScriptEnv({})
    expect(env[marker]).toBeUndefined()
  })

  it('that same var DOES cross over when the call explicitly names it in extraEnv', () => {
    process.env[marker] = 'inherited'
    const env = buildUpdateScriptEnv({ [marker]: 'from-extraEnv' })
    expect(env[marker]).toBe('from-extraEnv')
  })
})

describe('buildUpdateScriptEnv: prototype-pollution class is closed (card 651ee11f L2)', () => {
  // The OLD code used `'POST_MERGE_MODE' in extraEnv`, which walks the prototype chain: a
  // polluted Object.prototype makes `in` true for a plain {} that never owns the key, so the old
  // strip-unless-extraEnv-set-it logic would have wrongly treated an INHERITED value as
  // caller-provided and let it survive. The new code never special-cases this key at all --
  // Object.assign(env, extraEnv) only ever copies extraEnv's OWN enumerable properties -- so this
  // discriminates the fix from the old `in`-based shape directly, not just from a cosmetic rename.
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (Object.prototype as any).POST_MERGE_MODE
    delete process.env.POST_MERGE_MODE
  })

  it('a polluted Object.prototype does not make an inherited switch survive', () => {
    delete process.env.POST_MERGE_MODE
    process.env.POST_MERGE_MODE = '1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(Object.prototype as any).POST_MERGE_MODE = '1'
    const extraEnv = {} // owns nothing; 'POST_MERGE_MODE' in extraEnv is true ONLY via the pollution
    expect('POST_MERGE_MODE' in extraEnv).toBe(true) // control: the pollution itself is real
    expect(Object.hasOwn(extraEnv, 'POST_MERGE_MODE')).toBe(false) // control: but extraEnv owns nothing
    const env = buildUpdateScriptEnv(extraEnv)
    // Object.hasOwn, not `env.POST_MERGE_MODE` -- the same polluted Object.prototype this test
    // just set would make a PLAIN property read on ANY object return '1' regardless of what
    // buildUpdateScriptEnv did, so that read would not discriminate the fix from the bug at all.
    // The actual property under test is whether the function's own Object.assign(env, extraEnv)
    // copied an inherited-only property onto env as its OWN property.
    expect(Object.hasOwn(env, 'POST_MERGE_MODE')).toBe(false)
  })
})
