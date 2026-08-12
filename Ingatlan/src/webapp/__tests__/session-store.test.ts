import { describe, it, expect } from 'vitest'
import { SessionStore } from '../session-store.js'

describe('SessionStore', () => {
  it('create() returns a long, random-looking session id', () => {
    const store = new SessionStore(1000)
    const id = store.create('peti@gmail.com')
    expect(id).toMatch(/^[0-9a-f]{64}$/)
  })

  it('two sessions get DIFFERENT ids', () => {
    const store = new SessionStore(1000)
    const a = store.create('peti@gmail.com')
    const b = store.create('peti@gmail.com')
    expect(a).not.toBe(b)
  })

  it('get() returns the email for a valid session', () => {
    const store = new SessionStore(1000)
    const id = store.create('peti@gmail.com')
    expect(store.get(id)?.email).toBe('peti@gmail.com')
  })

  it('get() returns null for an unknown session id', () => {
    const store = new SessionStore(1000)
    expect(store.get('does-not-exist')).toBeNull()
  })

  it('a session EXPIRES after its TTL, using the injected clock', () => {
    let clock = 0
    const store = new SessionStore(1000, () => clock)
    const id = store.create('peti@gmail.com')
    clock = 999
    expect(store.get(id)).not.toBeNull() // just inside the TTL
    clock = 1000
    expect(store.get(id)).toBeNull() // exactly at expiry -> expired
  })

  it('an expired session is evicted (a second get() after expiry still returns null, not a stale hit)', () => {
    let clock = 0
    const store = new SessionStore(100, () => clock)
    const id = store.create('peti@gmail.com')
    clock = 200
    expect(store.get(id)).toBeNull()
    expect(store.get(id)).toBeNull()
  })

  it('destroy() invalidates a session immediately (logout)', () => {
    const store = new SessionStore(1000)
    const id = store.create('peti@gmail.com')
    store.destroy(id)
    expect(store.get(id)).toBeNull()
  })

  it('destroy() on an unknown id is a harmless no-op', () => {
    const store = new SessionStore(1000)
    expect(() => store.destroy('does-not-exist')).not.toThrow()
  })
})
