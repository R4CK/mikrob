import { describe, it, expect } from 'vitest'
import { normalizeAggressiveness } from '../web/routes/local-llm.js'

// Card 48f3b675: the offload-aggressiveness slider value must be a clean integer in [0,100] no matter
// what the client sends (the config is read by fleet agents + the offload skill). The validator was
// drafted via the local-llm offload and is re-verified here (mandatory recheck).
describe('normalizeAggressiveness', () => {
  it('passes through an in-range integer', () => {
    expect(normalizeAggressiveness(0)).toBe(0)
    expect(normalizeAggressiveness(50)).toBe(50)
    expect(normalizeAggressiveness(100)).toBe(100)
  })

  it('rounds a fractional number to the nearest integer', () => {
    expect(normalizeAggressiveness(74.4)).toBe(74)
    expect(normalizeAggressiveness(74.6)).toBe(75)
  })

  it('clamps out-of-range values to [0,100]', () => {
    expect(normalizeAggressiveness(-10)).toBe(0)
    expect(normalizeAggressiveness(9999)).toBe(100)
    expect(normalizeAggressiveness(Infinity)).toBe(50) // non-finite -> default, never NaN/overflow
  })

  it('parses numeric strings (a range input POSTs a string)', () => {
    expect(normalizeAggressiveness('75')).toBe(75)
    expect(normalizeAggressiveness(' 42 ')).toBe(42)
  })

  it('falls back to the default (50) for non-numeric / missing input', () => {
    expect(normalizeAggressiveness('abc')).toBe(50)
    expect(normalizeAggressiveness('')).toBe(50)
    expect(normalizeAggressiveness(null)).toBe(50)
    expect(normalizeAggressiveness(undefined)).toBe(50)
    expect(normalizeAggressiveness({})).toBe(50)
    expect(normalizeAggressiveness(NaN)).toBe(50)
  })
})
