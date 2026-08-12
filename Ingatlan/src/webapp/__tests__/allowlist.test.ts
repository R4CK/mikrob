import { describe, it, expect } from 'vitest'
import { isAllowedEmail } from '../allowlist.js'

describe('isAllowedEmail', () => {
  it('allows an exact match', () => {
    expect(isAllowedEmail('peti@gmail.com', ['peti@gmail.com'])).toBe(true)
  })
  it('is case-insensitive', () => {
    expect(isAllowedEmail('Peti@Gmail.com', ['peti@gmail.com'])).toBe(true)
    expect(isAllowedEmail('peti@gmail.com', ['PETI@GMAIL.COM'])).toBe(true)
  })
  it('tolerates surrounding whitespace on either side', () => {
    expect(isAllowedEmail('  peti@gmail.com  ', ['peti@gmail.com'])).toBe(true)
    expect(isAllowedEmail('peti@gmail.com', ['  peti@gmail.com  '])).toBe(true)
  })
  it('rejects an email not on the list', () => {
    expect(isAllowedEmail('valaki-mas@gmail.com', ['peti@gmail.com'])).toBe(false)
  })
  it('rejects null/undefined/empty input', () => {
    expect(isAllowedEmail(null, ['peti@gmail.com'])).toBe(false)
    expect(isAllowedEmail(undefined, ['peti@gmail.com'])).toBe(false)
    expect(isAllowedEmail('', ['peti@gmail.com'])).toBe(false)
    expect(isAllowedEmail('   ', ['peti@gmail.com'])).toBe(false)
  })
  it('rejects everything against an empty allowlist (fail-closed, not open)', () => {
    expect(isAllowedEmail('peti@gmail.com', [])).toBe(false)
  })
  it('does NOT match a substring/lookalike -- must be an exact match', () => {
    expect(isAllowedEmail('peti@gmail.com.evil.com', ['peti@gmail.com'])).toBe(false)
    expect(isAllowedEmail('notpeti@gmail.com', ['peti@gmail.com'])).toBe(false)
  })
  it('supports multiple allowed addresses', () => {
    const allowlist = ['peti@gmail.com', 'peti.masik@gmail.com']
    expect(isAllowedEmail('peti.masik@gmail.com', allowlist)).toBe(true)
    expect(isAllowedEmail('harmadik@gmail.com', allowlist)).toBe(false)
  })
})
