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

// ---------------------------------------------------------------------------------------------
// REGRESSION FIXTURE -- Cybersec NO-GO cm6054 (a31e8ddf). Ten real authz/isolation changes written
// in innocuous "mechanical cleanup" language; 9 of 10 routed LOCAL before the shape signals landed.
// Each maps to one of this fleet's own documented bug classes (access-default, fail-open, tenant-scope,
// authz-flip, timing-unsafe compare). The classifier is not trustworthy as a review gate unless every
// one of these routes ONLINE, so this suite is the merge bar for any future change to the tables.
// ---------------------------------------------------------------------------------------------

describe('REGRESSION: authz changes disguised as mechanical cleanup must route ONLINE (Cybersec cm6054)', () => {
  const disguised = [
    'one-liner: default the role parameter to admin when missing',
    'add a fallback so the function returns full access when the lookup is empty',
    'make the list endpoint return all rows instead of filtering by owner',
    'small refactor: invert the boolean returned by canAccess()',
    'typo fix: change !== to === in the id comparison',
    'cleanup: remove the early return in the middleware',
    'simplify: replace the two-argument helper with one that returns true',
    'rename the variable currentCompany to c and inline the filter',
    'update the WHERE clause to drop the extra id column',
    'refactor the string equality helper to use == for speed',
  ]
  for (const description of disguised) {
    it(`ONLINE: ${description.slice(0, 52)}`, () => {
      expect(routeTask({ description }).route).toBe('online')
    })
  }

  it('the disguise does not win even when declared trivial at max aggressiveness', () => {
    for (const description of disguised) {
      const d = routeTask({ description, difficulty: 'trivial', aggressiveness: 100 })
      expect(d.route).toBe('online')
    }
  })
})

describe('REGRESSION: semantically-security phrasings without the obvious nouns (Cybersec cm6058)', () => {
  const semantic = [
    'is this route fail-closed?',
    'write a function that returns true if the caller may read another company rows',
    'make the check pass for everyone',
    'change the comparison so it always returns true',
    'tiny helper: compare two strings and return whether they are equal',
  ]
  for (const description of semantic) {
    it(`ONLINE: ${description.slice(0, 52)}`, () => {
      expect(routeTask({ description }).route).toBe('online')
    })
  }
})

describe('REGRESSION: formatting evasions are normalized away before matching', () => {
  it('letter-spaced text still classifies', () => {
    expect(routeTask({ description: 's e c u r i t y decision about the token' }).route).toBe('online')
  })
  it('zero-width characters inside a keyword still classify', () => {
    expect(routeTask({ description: 'sec​urity review of the endpoint' }).route).toBe('online')
  })
  it('normalization does NOT drag ordinary mechanical work online', () => {
    expect(routeTask({ description: 'write a pure function that formats a date as yyyy-mm-dd' }).route).toBe('local')
  })
})
