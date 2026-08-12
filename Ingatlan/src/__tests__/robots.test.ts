import { describe, it, expect } from 'vitest'
import { parseRobotsTxt, isPathAllowed, isAllowedByRobots } from '../robots.js'

describe('parseRobotsTxt + isPathAllowed (RFC 9309)', () => {
  it('a plain Disallow prefix blocks matching paths', () => {
    const groups = parseRobotsTxt('User-agent: *\nDisallow: /admin')
    const rules = groups.get('*')!
    expect(isPathAllowed(rules, '/admin')).toBe(false)
    expect(isPathAllowed(rules, '/admin/settings')).toBe(false)
    expect(isPathAllowed(rules, '/other')).toBe(true)
  })

  it('no matching rule at all means allowed (default-allow)', () => {
    const groups = parseRobotsTxt('User-agent: *\nDisallow: /admin')
    expect(isPathAllowed(groups.get('*')!, '/szukites/lakas')).toBe(true)
  })

  it('an empty Disallow value is a no-op (allows everything, not a vacuous block-all)', () => {
    const groups = parseRobotsTxt('User-agent: *\nDisallow:')
    expect(isPathAllowed(groups.get('*')!, '/anything')).toBe(true)
  })

  it('longest matching rule wins even when it is the Allow carving an exception out of a broader Disallow', () => {
    const groups = parseRobotsTxt('User-agent: *\nDisallow: /szukites\nAllow: /szukites/nyilvanos')
    const rules = groups.get('*')!
    expect(isPathAllowed(rules, '/szukites/privat')).toBe(false)
    expect(isPathAllowed(rules, '/szukites/nyilvanos')).toBe(true)
    expect(isPathAllowed(rules, '/szukites/nyilvanos/reszlet')).toBe(true)
  })

  it('an equal-length Allow and Disallow tie -> Allow wins', () => {
    const groups = parseRobotsTxt('User-agent: *\nDisallow: /abc\nAllow: /abc')
    expect(isPathAllowed(groups.get('*')!, '/abc')).toBe(true)
  })

  it('supports "*" wildcard mid-pattern', () => {
    const groups = parseRobotsTxt('User-agent: *\nDisallow: /szukites/*/edit')
    const rules = groups.get('*')!
    expect(isPathAllowed(rules, '/szukites/123/edit')).toBe(false)
    expect(isPathAllowed(rules, '/szukites/123/view')).toBe(true)
  })

  it('supports "$" end-anchor', () => {
    const groups = parseRobotsTxt('User-agent: *\nDisallow: /szukites$')
    const rules = groups.get('*')!
    expect(isPathAllowed(rules, '/szukites')).toBe(false)
    expect(isPathAllowed(rules, '/szukites/lakas')).toBe(true) // anchor means exact path only
  })

  it('multiple User-agent lines in a row share the same directive block', () => {
    const groups = parseRobotsTxt('User-agent: Googlebot\nUser-agent: Bingbot\nDisallow: /private')
    expect(isPathAllowed(groups.get('googlebot')!, '/private')).toBe(false)
    expect(isPathAllowed(groups.get('bingbot')!, '/private')).toBe(false)
  })

  it('a new User-agent line AFTER directives starts a separate group (does not merge rules)', () => {
    const groups = parseRobotsTxt(
      'User-agent: Googlebot\nDisallow: /only-google\nUser-agent: *\nDisallow: /everyone',
    )
    expect(groups.get('googlebot')).toEqual([{ path: '/only-google', allow: false }])
    expect(groups.get('*')).toEqual([{ path: '/everyone', allow: false }])
  })

  it('comments and blank lines are ignored', () => {
    const groups = parseRobotsTxt('# comment\nUser-agent: *\n\n# another comment\nDisallow: /x # trailing comment')
    expect(groups.get('*')).toEqual([{ path: '/x', allow: false }])
  })

  it('isAllowedByRobots: a specific user-agent group is preferred over the wildcard group', () => {
    const content = 'User-agent: *\nDisallow: /\nUser-agent: MyBot\nDisallow:\n'
    expect(isAllowedByRobots(content, 'MyBot', '/anything')).toBe(true)
    expect(isAllowedByRobots(content, 'SomeOtherBot', '/anything')).toBe(false)
  })

  it('isAllowedByRobots: falls back to "*" when no group matches the given user-agent', () => {
    const content = 'User-agent: *\nDisallow: /admin\n'
    expect(isAllowedByRobots(content, 'MyBot', '/admin')).toBe(false)
    expect(isAllowedByRobots(content, 'MyBot', '/public')).toBe(true)
  })
})
