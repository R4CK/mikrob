// Card a31e8ddf: the offload AUTO-ROUTER. Local is the default; ONLINE is opt-in for the
// non-offloadable categories and above the difficulty threshold. These tests pin BOTH directions --
// the positive (mechanical work really does go local, or the card saves nothing) and the negative
// (a security/authz/isolation/architecture/wiring task NEVER goes local, and an unusable or hedged
// input fails closed to online).

import { describe, it, expect } from 'vitest'
import {
  routeTask,
  classifyCategory,
  NON_OFFLOADABLE_CATEGORIES,
} from '../local-llm-router.js'

describe('routeTask -- positive: mechanical work drafts LOCALLY (the token saving)', () => {
  const mechanical = [
    'Write a pure function that formats a date as yyyy-mm-dd',
    'Add a regex that validates a Hungarian postal code',
    'Generate the TypeScript interface for this DTO',
    'Write a unit test scaffold for the paginate helper',
    'Rewrite this docstring to be clearer',
    'Draft the German translation of "Save changes"',
  ]
  for (const description of mechanical) {
    it(`local: ${description.slice(0, 44)}`, () => {
      expect(routeTask({ description }).route).toBe('local')
    })
  }

  it('a declared difficulty at/below the threshold stays local', () => {
    const d = routeTask({ description: 'format a date string', difficulty: 'isolated', threshold: 'module' })
    expect(d.route).toBe('local')
    expect(d.difficulty).toBe('isolated')
  })

  it('local is the DEFAULT when nothing blocks (opt-in-online, not opt-out)', () => {
    const d = routeTask({ description: 'rename this variable consistently' })
    expect(d.route).toBe('local')
    expect(d.reason).toContain('default-local')
  })
})

describe('routeTask -- negative: non-offloadable categories NEVER go local', () => {
  const blocked: ReadonlyArray<readonly [string, string]> = [
    ['security-decision', 'Decide how to hash the reset token before storing it'],
    ['security-decision', 'Review this endpoint for injection vulnerabilities'],
    ['security-decision', 'Set the session cookie attributes for the admin app'],
    ['authz', 'Add an RBAC permission check to the invoice endpoint'],
    ['authz', 'Which roles should be allowed to approve a shift?'],
    ['isolation', 'Make sure the query is scoped so no cross-tenant data leaks'],
    ['isolation', 'Add an RLS policy for the new table'],
    ['architecture', 'Design the system boundary between billing and workforce'],
    ['architecture', 'Write the db schema migration for shift assignments'],
    ['multi-file-wiring', 'Wire the new store into main.ts and the router'],
    ['multi-file-wiring', 'Integrate this adapter end-to-end across files'],
  ]
  for (const [category, description] of blocked) {
    it(`online (${category}): ${description.slice(0, 40)}`, () => {
      const d = routeTask({ description })
      expect(d.route).toBe('online')
      expect(d.category).toBe(category)
    })
  }

  it('a blocked category wins even when the task LOOKS trivial and is declared trivial', () => {
    const d = routeTask({ description: 'just a tiny tweak to the authz guard', difficulty: 'trivial' })
    expect(d.route).toBe('online')
    expect(d.category).toBe('authz')
  })

  it('every declared category is reachable by the classifier', () => {
    const seen = new Set(blocked.map(([c]) => c))
    for (const c of NON_OFFLOADABLE_CATEGORIES) expect(seen.has(c)).toBe(true)
  })
})

describe('routeTask -- fail-closed behaviour', () => {
  it('empty / whitespace description routes ONLINE (never guess from nothing)', () => {
    expect(routeTask({ description: '' }).route).toBe('online')
    expect(routeTask({ description: '   ' }).route).toBe('online')
  })

  it('non-string description routes ONLINE', () => {
    expect(routeTask({ description: undefined as unknown as string }).route).toBe('online')
  })

  it('a hedged/ambiguous request routes ONLINE', () => {
    expect(routeTask({ description: 'not sure what this helper should do, figure out the shape' }).route).toBe(
      'online',
    )
  })

  it('difficulty above the threshold routes ONLINE', () => {
    const d = routeTask({ description: 'rework the whole reporting flow', difficulty: 'feature', threshold: 'module' })
    expect(d.route).toBe('online')
    expect(d.reason).toContain('exceeds threshold')
  })

  it('feature/architecture never draft locally even at max aggressiveness (reliable ceiling)', () => {
    for (const difficulty of ['feature', 'architecture']) {
      expect(routeTask({ description: 'a big change', difficulty, aggressiveness: 100 }).route).toBe('online')
    }
  })

  it('classifyCategory is case-insensitive (no trivial bypass)', () => {
    expect(classifyCategory('ADD AN RBAC PERMISSION CHECK')).toBe('authz')
    expect(classifyCategory('Fix The XSS Sanitization')).toBe('security-decision')
  })
})
