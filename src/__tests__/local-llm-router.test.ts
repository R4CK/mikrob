// Card a31e8ddf: the offload AUTO-ROUTER. Local is the default; ONLINE is opt-in for the
// non-offloadable categories and above the difficulty threshold. These tests pin BOTH directions --
// the positive (mechanical work really does go local, or the card saves nothing) and the negative
// (a security/authz/isolation/architecture/wiring task NEVER goes local, and an unusable or hedged
// input fails closed to online).

import { describe, it, expect } from 'vitest'
import {
  routeTask,
  classifyCategory,
  stripGateLine,
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
    // DECISION-VERB regressions (card 6fbf42bb). Before the verb list gained approve/reject/deny/
    // grant/revoke, the first of these routed LOCAL -- a genuine RBAC design question, protected
    // only by the accident that the OTHER phrasing happens to contain the word "roles". Measured on
    // the real router, not inferred. These pin the SEMANTIC route so the protection cannot go back
    // to depending on one vocabulary choice.
    ['authz', 'Which user groups should be allowed to approve a shift?'],
    ['authz', 'Decide which admins may revoke a membership.'],
    ['authz', 'Which team leads can deny a leave request?'],
    // QUALIFIER regressions (card c26a9064). Narrowing the ambiguous needles to a qualifier window
    // is only safe if the REAL uses still fire. Each of these carries an ambiguous needle WITH its
    // domain qualifier nearby, which is exactly the shape the narrowing must keep catching.
    // 'token-login' is here because the manual-read control caught it escaping: the qualifier list
    // had no `login`, so a genuine auth-flow card was reclaimed to local.
    ['security-decision', 'Dashboard token-login overlay: flow and copy verification'],
    ['security-decision', 'Rotate the refresh token and invalidate the old session on logout.'],
    ['security-decision', 'Store only the hash of the password, never the password itself.'],
    // OPERATOR-SHAPE regressions (card d1027d5a). The rule now needs a SENSITIVE value beside the
    // comparison; these are the shape it exists for -- a timing-unsafe check of a secret.
    ['security-decision', 'Compare the provided token === the stored one before granting access.'],
    ['security-decision', 'The digest check uses == instead of a constant-time compare.'],
    // PREDICTABILITY/STRENGTH axis (Cybered NO-GO on c26a9064). None of these carries an auth or
    // isolation word -- "is this secret hard to guess" is a security decision on its own axis, and
    // the qualifier lists had no vocabulary for it at all.
    ['security-decision', 'the invite token is guessable'],
    ['security-decision', 'token entropy is too low, make it 32 bytes'],
    ['security-decision', 'the session id is sequential'],
    // Found by the FULL manual read of the reclaimed set, not by any probe:
    // (a) `\b` does not fire inside snake_case -- `has_table_privilege` hid the `privilege` needle
    ['authz', 'derivalt privilegium-guard: has_table_privilege(SELECT/INSERT) + SET ROLE cleancore_app'],
    // (b) the axes were English-only, and this fleet writes Hungarian as often as not
    ['security-decision', 'Futasideju token-in-argv ellenorzes -- elo szivargas van a lemezen'],
    // CHANGE axis (Cybersec, 6 measured sentences). The security NOUN was covered; the VERB applied
    // to it was not, so "make it weaker / shorter-lived / owned by someone else / gone" was invisible.
    ['security-decision', 'Switch the hash to something stronger.'],
    ['isolation', 'Delete the account and everything attached to it.'],
    ['isolation', 'Merge two accounts that belong to the same person.'],
    ['isolation', 'Move a user to a different organization.'],
    ['security-decision', 'Make the session last longer.'],
    ['security-decision', 'Shorten how long the token stays valid.'],
    // CRYPTO WEAKNESS != CRYPTO CONSTRUCTION (Cybered's fifth same-shape case). Before the fix these
    // two identical decisions took opposite routes, because `sha[0-9]` matched sha1 by accident.
    ['security-decision', 'we use md5 for the hash'],
    ['security-decision', 'we use sha1 for the hash'],
    // camelCase: normalizeForMatch lowercases, so `userToken` arrives as `usertoken` and a leading
    // \b never fires -- the codebase's own naming convention hid the secret (Cybered on d1027d5a).
    ['security-decision', 'if (userToken !== provided) return 401'],
    ['security-decision', 'if (apiKey === suppliedValue) allow'],
  ]
  for (const [category, description] of blocked) {
    it(`online (${category}): ${description.slice(0, 40)}`, () => {
      const d = routeTask({ description })
      expect(d.route).toBe('online')
      expect(d.category).toBe(category)
    })
  }

  // The other half of the same change: widening a signal is only safe if it did not start catching
  // ordinary work. Each of these CONTAINS a decision verb and must still route LOCAL, because none
  // of them asks WHO MAY do it -- the permission modal is what makes it an authz question.
  const stillLocal = [
    'Rename the approve button label to Accept.',
    'Fix the toast that appears after a user rejects a draft.',
    'Add a helper that formats a duration in minutes as h:mm.',
    // FLEET-DIALECT controls (card c26a9064). Measured on the live board: of the 40 cards whose
    // `token` matched, 32 had no auth word within +/-60 chars, and of 28 `session` matches, 21 meant
    // a tmux or Claude session. These three are that class, and routing them online starved the
    // local model of exactly the mechanical work it should draft.
    'This cuts the per-wakeup token cost, the biggest multiplier.',
    'The scheduler logs "session busy, tick dropped" the same as "nothing to do".',
    'Print the version number and commit hash in the sidebar header.',
    // OPERATOR-SHAPE false positives, measured on the live board: of 117 security-decision cards
    // only five contained a comparison operator at all, and not one was a secret comparison.
    'Add an empty-state when sites.length === 0 after load.',
    'Handle both 404 and a raw network error: if (status === 404 || status === 0)',
    // The widened boundary must still not fire inside an ordinary word: `scap` in "landscape".
    'render the landscape orientation preview',
    // Cybersec's own negative control: the `compose` needle must not fire on ordinary composition.
    'Compose the invite email from the template.',
    // The camelCase widening must not start matching a word that merely ENDS in a needle.
    'render the keyboard shortcut overlay when help === true',
  ]
  for (const description of stillLocal) {
    it(`still local (no permission modal): ${description.slice(0, 38)}`, () => {
      expect(routeTask({ description }).route).toBe('local')
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

  it('REGRESSION (card b215ca62, Cybersec follow-up on 7a23c045): the burn-shape noun must match its PLURAL too', () => {
    // The card's own three examples (isolated from a co-occurring singular keyword that would
    // otherwise mask the gap -- e.g. "one-time"/"magic" alongside a plural noun): before this fix
    // \b(...|code|link|otp|...)\b required an EXACT word match, so "codes"/"links"/"otps" alone
    // (no other keyword nearby) silently fell through to local despite being security-critical.
    for (const description of [
      'mark the login codes as burned',
      'burn the shared links after use',
      'the otps get burned after redemption',
    ]) {
      expect(routeTask({ description }).route, description).toBe('online')
    }
  })

  it("the card's own three example sentences also route online (plural noun PLUS an incidental singular keyword)", () => {
    for (const description of [
      'mark the one-time login codes as burned',
      'burn the magic links after first use',
      'the otps get burned after redemption',
    ]) {
      expect(routeTask({ description }).route, description).toBe('online')
    }
  })

  it('CONTROL: "token" was already protected before this fix (a separate substring keyword), still online', () => {
    expect(routeTask({ description: 'burn the tokens after use' }).route).toBe('online')
  })
})

describe('stripGateLine (card 14a73ce6, measured false-positive: card 543d62ff)', () => {
  it('removes a single trailing "Gate: ..." line', () => {
    const stripped = stripGateLine('Fix the off-by-one in the paginator.\n\nGate: QA.')
    expect(stripped).toBe('Fix the off-by-one in the paginator.')
  })

  it('removes MULTIPLE Gate: lines (an earlier tier decision superseded by a later one)', () => {
    const stripped = stripGateLine('Bump the test timeout.\n\nGate: QA only.\n\nGate: QA + Cybersec (updated).')
    expect(stripped).not.toContain('Gate:')
    expect(stripped).toBe('Bump the test timeout.')
  })

  it('is case-insensitive and tolerant of leading whitespace/indentation', () => {
    expect(stripGateLine('text\n  gate:   qa')).toBe('text')
    expect(stripGateLine('text\nGATE: QA + Cybersec')).toBe('text')
  })

  it('leaves non-Gate: content completely untouched', () => {
    const desc = 'Line one.\nLine two.\nLine three.'
    expect(stripGateLine(desc)).toBe(desc)
  })

  it('does NOT strip a line that merely mentions "gate" without the line-anchored label shape', () => {
    // "gate" as an ordinary word (not the fleet's "Gate: ..." convention) must survive -- this is
    // deliberately narrow, matching gate-dispatch-check.sh's own GATE_LINE extraction shape.
    const desc = 'The login gate keeps failing under load, not a Gate: line at all.'
    expect(stripGateLine(desc)).toBe(desc)
  })
})

describe('the Gate: line no longer contaminates classification (card 14a73ce6)', () => {
  it('REGRESSION (real incident 47bc80e1): a mechanical constant-pin + unit-test task now routes LOCAL once its own Gate: trailer is excluded', () => {
    const description =
      'MIN_REASON_CHARS threshold is not pinned, and exemptionReasonFor() has no direct unit test. ' +
      'Pin the constant and add a test for the pure function.\n\n' +
      'Gate: QA + Cybersec (biztonsag-relevans guard tesztlefedettsege -- a legutobbi hasonlo kartya tiere).'
    // Before the fix, classifyCategory saw "biztonsag" in the Gate: trailer and forced online.
    expect(classifyCategory(description)).toBeNull()
    expect(routeTask({ description }).route).toBe('local')
  })

  it('REGRESSION (real incident 54699bbb): a CI/test-signal-integrity bug now routes LOCAL once its own Gate: trailer is excluded', () => {
    const description =
      'vitest exits code 1 even though every test is green (unhandled rejection in onTaskUpdate). ' +
      'Find and fix the reporter bug so a real CI failure cannot slip through unnoticed.\n\n' +
      'Gate: QA + rotalt biztonsagi gate a rule 4 alapesete szerint (trust-boundary/uj tamadasi felulet).'
    expect(classifyCategory(description)).toBeNull()
    expect(routeTask({ description }).route).toBe('local')
  })

  it('CONTROL: a genuine security signal in the TASK BODY (not just the Gate: line) still routes ONLINE', () => {
    // Proves the fix narrows the false-positive source, it does not weaken real detection.
    const description =
      'Add CSRF token validation to the password-reset endpoint.\n\nGate: QA + Cybersec.'
    expect(routeTask({ description }).route).toBe('online')
  })

  it('CONTROL: a description with NO Gate: line at all is unaffected by stripGateLine', () => {
    const description = 'Rename this variable consistently across the file.'
    expect(routeTask({ description }).route).toBe('local')
  })
})
