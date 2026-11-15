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
import { spawnSync } from 'node:child_process'
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

describe('buildUpdateScriptEnv: systemctl --user keeps working (RedHat NO-GO F1 on 1cc5be855)', () => {
  // RedHat's measurement: without XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS, `systemctl
  // --user` cannot reach the user session bus, and update.sh's own `daemon-reload`/unit-drift
  // calls swallow that failure (`2>/dev/null || true`), so the loss is silent. This test is
  // skipped if the test host has no running user session bus at all (CI containers often don't) --
  // the discriminating assertion is the SECOND one, which proves these two keys are what matters.
  const hasUserBus = !!process.env.XDG_RUNTIME_DIR && !!process.env.DBUS_SESSION_BUS_ADDRESS

  it.skipIf(!hasUserBus)('systemctl --user daemon-reload succeeds with the built env', () => {
    const env = buildUpdateScriptEnv({})
    const result = spawnSync('systemctl', ['--user', 'daemon-reload'], { env })
    expect(result.status).toBe(0)
  })

  it.skipIf(!hasUserBus)('dropping XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS from the built env is what breaks it (control)', () => {
    // Proves the PREVIOUS test is not vacuous (e.g. systemctl finding a bus some other way):
    // the exact same built env, minus these two keys, fails -- so they are load-bearing.
    const env = buildUpdateScriptEnv({})
    delete env.XDG_RUNTIME_DIR
    delete env.DBUS_SESSION_BUS_ADDRESS
    const result = spawnSync('systemctl', ['--user', 'daemon-reload'], { env })
    expect(result.status).not.toBe(0)
  })

  it('XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS, when set on this process, are carried over unchanged', () => {
    const original = { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }
    try {
      process.env.XDG_RUNTIME_DIR = '/run/user/9999'
      process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/user/9999/bus'
      const env = buildUpdateScriptEnv({})
      expect(env.XDG_RUNTIME_DIR).toBe('/run/user/9999')
      expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/9999/bus')
    } finally {
      if (original.XDG_RUNTIME_DIR === undefined) delete process.env.XDG_RUNTIME_DIR
      else process.env.XDG_RUNTIME_DIR = original.XDG_RUNTIME_DIR
      if (original.DBUS_SESSION_BUS_ADDRESS === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS
      else process.env.DBUS_SESSION_BUS_ADDRESS = original.DBUS_SESSION_BUS_ADDRESS
    }
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

describe('buildUpdateScriptEnv: prototype pollution does not reach the spawned child process (RedHat NO-GO F2 on 1cc5be855)', () => {
  // RedHat's measurement: node's spawn() copies the child env with a for...in loop, which walks
  // the prototype chain. Object.hasOwn(env, 'FOO') being false is true to the STATEMENT but not to
  // what the actual child process receives -- these tests check the real process boundary.
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (Object.prototype as any).FORCE_REBUILD
  })

  function readFromChild(childEnv: NodeJS.ProcessEnv, varName: string): string {
    const result = spawnSync(process.execPath, ['-e', `process.stdout.write(process.env.${varName} || '')`], { env: childEnv })
    return result.stdout.toString()
  }

  it('a polluted Object.prototype is NOT seen by the spawned child (null-prototype env)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(Object.prototype as any).FORCE_REBUILD = 'polluted'
    const env = buildUpdateScriptEnv({})
    expect(readFromChild(env, 'FORCE_REBUILD')).toBe('')
  })

  it('control: the same pollution DOES reach a child spawned with a plain (prototype-inheriting) env', () => {
    // Proves the previous assertion is not vacuous (e.g. node ignoring inherited props for some
    // other reason) -- the exact same pollution crosses the OS boundary for an ordinary {} env.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(Object.prototype as any).FORCE_REBUILD = 'polluted'
    const plainEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH }
    expect(readFromChild(plainEnv, 'FORCE_REBUILD')).toBe('polluted')
  })

  it('an extraEnv with an own "__proto__" key (e.g. from JSON.parse) cannot set env\'s prototype', () => {
    const extraEnv = JSON.parse('{"AUTO_STASH":"1","__proto__":{"FORCE_REBUILD":"viaproto"}}')
    expect(Object.hasOwn(extraEnv, '__proto__')).toBe(true) // control: a real own property, not literal-syntax proto-set
    const env = buildUpdateScriptEnv(extraEnv)
    expect(Object.getPrototypeOf(env)).toBeNull()
    expect(readFromChild(env, 'FORCE_REBUILD')).toBe('')
  })

  it('control: the same extraEnv shape DOES change a plain object\'s prototype via Object.assign', () => {
    const extraEnv = JSON.parse('{"AUTO_STASH":"1","__proto__":{"FORCE_REBUILD":"viaproto"}}')
    const plainEnv: Record<string, string> = {}
    Object.assign(plainEnv, extraEnv)
    expect(Object.getPrototypeOf(plainEnv)).toEqual({ FORCE_REBUILD: 'viaproto' })
  })
})
