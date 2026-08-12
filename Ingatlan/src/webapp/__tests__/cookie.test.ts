import { describe, it, expect } from 'vitest'
import { parseCookies, serializeCookie, clearCookie } from '../cookie.js'

describe('parseCookies', () => {
  it('parses a single cookie', () => {
    expect(parseCookies('sid=abc123')).toEqual({ sid: 'abc123' })
  })
  it('parses multiple cookies separated by "; "', () => {
    expect(parseCookies('sid=abc123; theme=dark')).toEqual({ sid: 'abc123', theme: 'dark' })
  })
  it('decodes a URI-encoded value', () => {
    expect(parseCookies('name=Pe%20ti')).toEqual({ name: 'Pe ti' })
  })
  it('returns an empty object for no header', () => {
    expect(parseCookies(undefined)).toEqual({})
    expect(parseCookies(null)).toEqual({})
    expect(parseCookies('')).toEqual({})
  })
  it('ignores a malformed segment with no "="', () => {
    expect(parseCookies('sid=abc123; garbage; theme=dark')).toEqual({ sid: 'abc123', theme: 'dark' })
  })
})

describe('serializeCookie', () => {
  it('always includes HttpOnly, Path=/, and a SameSite default of Lax', () => {
    const header = serializeCookie('sid', 'abc123')
    expect(header).toContain('sid=abc123')
    expect(header).toContain('HttpOnly')
    expect(header).toContain('Path=/')
    expect(header).toContain('SameSite=Lax')
  })
  it('never includes a Secure attribute (plain-HTTP localhost by design)', () => {
    expect(serializeCookie('sid', 'abc123')).not.toContain('Secure')
  })
  it('URI-encodes the value', () => {
    expect(serializeCookie('name', 'Pe ti')).toContain('name=Pe%20ti')
  })
  it('includes Max-Age when provided', () => {
    expect(serializeCookie('sid', 'abc123', { maxAgeSeconds: 3600 })).toContain('Max-Age=3600')
  })
  it('respects a custom SameSite', () => {
    expect(serializeCookie('sid', 'abc123', { sameSite: 'Strict' })).toContain('SameSite=Strict')
  })
})

describe('clearCookie', () => {
  it('produces a Max-Age=0 cookie for the given name', () => {
    const header = clearCookie('sid')
    expect(header).toContain('sid=;')
    expect(header).toContain('Max-Age=0')
  })
})
