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

  it('architecture never drafts locally even at max aggressiveness (reliable ceiling)', () => {
    expect(routeTask({ description: 'a big change', difficulty: 'architecture', aggressiveness: 100 }).route).toBe(
      'online',
    )
  })

  it('feature drafts locally at max aggressiveness (ceiling raised 2026-08-07, Peti)', () => {
    expect(routeTask({ description: 'a big change', difficulty: 'feature', aggressiveness: 100 }).route).toBe(
      'local',
    )
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

// ---------------------------------------------------------------------------------------------
// REGRESSION FIXTURE 2 -- Cybersec 2nd NO-GO. The OUTCOME/POLICY family: a control change stated by
// its EFFECT ("grant access", "treat a missing role as owner", "return results unfiltered") instead
// of by the artifact being modified, so the guard-noun rule never fired. 6/6 routed LOCAL in natural
// task form. These are the fleet's highest-frequency defect classes: fail-open, access-default,
// tenant-scope-drop, validation-moved-to-client. Cybersec's completion criterion is NO SYSTEMATIC
// FAMILY failing, so this set covers all five patterns, not just the six reported strings.
// ---------------------------------------------------------------------------------------------

describe('REGRESSION: outcome/policy phrasing without a guard noun must route ONLINE (Cybersec 2nd NO-GO)', () => {
  const outcome = [
    // (1) granting access / letting a request through -- fail-open
    'grant access when the lookup fails',
    'allow the request through on timeout',
    'permit the caller when the permission service is unreachable',
    // (2) treating one thing AS a more privileged thing -- access-default
    'treat a missing role as owner',
    'consider an unknown user as public and continue',
    // (3) ceasing to apply a control
    'stop applying the site filter on the read path',
    'skip validating the payload for internal callers',
    'no longer check the company on the detail endpoint',
    // (4) explicitly unscoped result set -- tenant-scope drop
    'return results unfiltered when no site is selected',
    'list the records across all tenants for the dashboard',
    // (5) moving a server-side control to an untrusted client
    'move the validation to the client from now on',
    'shift the permission check to the frontend to save a round trip',
  ]
  it('covers 12 cases (Cybersec completion criterion)', () => {
    expect(outcome).toHaveLength(12)
  })
  for (const description of outcome) {
    it(`ONLINE: ${description.slice(0, 52)}`, () => {
      expect(routeTask({ description }).route).toBe('online')
    })
  }
  it('still ONLINE when declared trivial at max aggressiveness', () => {
    for (const description of outcome) {
      expect(routeTask({ description, difficulty: 'trivial', aggressiveness: 100 }).route).toBe('online')
    }
  })
})

describe('REGRESSION: WIDENING-grammar authz/isolation changes must route ONLINE (card c1661fff, Cybered)', () => {
  // Every prior family is tuned to the REMOVAL grammar (remove/skip/bypass a check). These three,
  // reproduced from real cards, describe the SAME row-scope-widening defect as an EXPANSION instead
  // -- nothing is named as removed, so the removal-grammar rules miss all three.
  const widening = [
    'update listWorkOrders to return rows for every company, not just the current one',
    'in the crew endpoint, widen the query so a foreman sees all crews in the database',
    'the dispatcher should be able to open any work order, not only their own',
  ]
  it('covers 3 cases (the card\'s own reproduced examples)', () => {
    expect(widening).toHaveLength(3)
  })
  for (const description of widening) {
    it(`ONLINE: ${description.slice(0, 52)}`, () => {
      expect(routeTask({ description }).route).toBe('online')
    })
  }
  it('still ONLINE when declared trivial at max aggressiveness', () => {
    for (const description of widening) {
      expect(routeTask({ description, difficulty: 'trivial', aggressiveness: 100 }).route).toBe('online')
    }
  })
  it('the missing tenant synonyms (org/organisation/company/account) are now recognized directly', () => {
    expect(classifyCategory('cross-organization data leak in the reports endpoint')).toBe('isolation')
    expect(classifyCategory('the account-scoped filter needs a review')).toBe('isolation')
  })
})

describe('REGRESSION: "companies" (irregular plural) must not bypass the "company" keyword (Cybered NO-GO on c1661fff, comment 10714)', () => {
  // Plain keyword matching is substring-based, so a REGULAR plural (organizations, accounts)
  // already contains its singular for free -- "company" -> "companies" does not (y -> ies), and
  // Cybered's own adversarial probe found three real bypasses this shape opened, one of them a
  // close paraphrase of this card's own reproduced example #2 with the widening verb removed.
  const bypasses = [
    'let a foreman see crews from other companies too',
    'a report visible across companies',
    'sharing data between companies now allowed',
  ]
  it('covers 3 cases (Cybered\'s own adversarial probe)', () => {
    expect(bypasses).toHaveLength(3)
  })
  for (const description of bypasses) {
    it(`ONLINE: ${description.slice(0, 52)}`, () => {
      expect(routeTask({ description }).route).toBe('online')
    })
  }
  it('the singular "company" control case still routes online too', () => {
    expect(routeTask({ description: 'let a foreman see crews from other company too' }).route).toBe(
      'online',
    )
  })
})

describe('REGRESSION: auth-implementation primitives (TOTP/step-up/burn/login-rate-limit) must route ONLINE (card 7a23c045, Cybersec)', () => {
  // Card 7a23c045: these four terms are named explicitly in the fleet's own local-LLM-offload
  // exclusion policy as security-critical, but none of them was a keyword before this fix --
  // confirmed by directly probing routeTask, all four routed LOCAL.
  it('TOTP generation/verification routes online (no prior keyword matched "totp")', () => {
    expect(
      routeTask({ description: 'implement TOTP generation and verification for the login flow' })
        .route,
    ).toBe('online')
  })

  it('step-up, WITHOUT the word "authentication" co-occurring, still routes online', () => {
    // Before this fix, "step-up authentication" only routed online by accident, via the unrelated
    // "authentic" keyword already in the sentence -- this phrasing has no such lucky co-occurrence.
    expect(
      routeTask({ description: 'add step-up verification for high-risk admin actions' }).route,
    ).toBe('online')
  })

  it('login rate-limiting / throttling / brute-force protection routes online', () => {
    for (const description of [
      'add login rate-limiting to slow down repeated failed attempts',
      'add throttling on repeated failed login attempts',
      'add brute-force protection on the login endpoint',
    ]) {
      expect(routeTask({ description }).route, description).toBe('online')
    }
  })

  it('burn/single-use semantics route online in BOTH word orders, without the word "token"', () => {
    // Before this fix these only routed online when "token" happened to appear too -- bare "burn"
    // is deliberately NOT a keyword (burn rate, burndown), so the shape needs the noun nearby.
    for (const description of [
      'mark the one-time login code as burned after it is used',
      'burn the magic link after first use so it cannot fire twice',
      'implement single-use burn semantics for the recovery flow',
    ]) {
      expect(routeTask({ description }).route, description).toBe('online')
    }
  })

  it('CONTROL: unrelated uses of "burn" stay local (the word alone is not the signal)', () => {
    expect(routeTask({ description: 'update the burn rate chart on the finance dashboard' }).route).toBe(
      'local',
    )
  })
})
