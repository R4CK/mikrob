import { describe, it, expect } from 'vitest'
import { StateStore } from '../state-store.js'

describe('StateStore', () => {
  it('issue() returns a long, random-looking token', () => {
    const store = new StateStore()
    expect(store.issue()).toMatch(/^[0-9a-f]{48}$/)
  })

  it('two issued states are DIFFERENT', () => {
    const store = new StateStore()
    expect(store.issue()).not.toBe(store.issue())
  })

  it('consume() returns true for a freshly issued, unexpired state', () => {
    const store = new StateStore()
    const state = store.issue()
    expect(store.consume(state)).toBe(true)
  })

  it('consume() returns false for an unknown state', () => {
    const store = new StateStore()
    expect(store.consume('never-issued')).toBe(false)
  })

  it('a state can only be consumed ONCE -- replay is rejected', () => {
    const store = new StateStore()
    const state = store.issue()
    expect(store.consume(state)).toBe(true)
    expect(store.consume(state)).toBe(false) // second attempt, same state -> rejected
  })

  it('an expired state is rejected, using the injected clock', () => {
    let clock = 0
    const store = new StateStore(1000, () => clock)
    const state = store.issue()
    clock = 1000
    expect(store.consume(state)).toBe(false)
  })

  it('a state consumed exactly at the TTL boundary (not yet expired) still succeeds', () => {
    let clock = 0
    const store = new StateStore(1000, () => clock)
    const state = store.issue()
    clock = 999
    expect(store.consume(state)).toBe(true)
  })
})
