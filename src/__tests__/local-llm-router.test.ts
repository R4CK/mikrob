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
  titleTags,
  hasSecurityTag,
  NON_OFFLOADABLE_CATEGORIES,
  CATEGORY_CEILINGS,
  taskStatement,
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

describe('a declared SEC tag is a router input, not a word to find in prose (card 5f0e7aa5)', () => {
  // THE MEASURED GAP: 155 cards on the frozen 561-card board carry a SEC/CYBERSEC tag, and 30 of
  // them routed LOCAL with classifyCategory returning null -- their text names no signal these
  // tables know, in either language. The fleet had already decided those cards were security work;
  // the router just could not see the decision, because it only ever got prose.
  const MECHANICAL = 'rename the approve button label to Accept, nothing else changes'

  it('a SEC tag routes online even when the text carries no security signal at all', () => {
    expect(routeTask({ description: MECHANICAL }).route).toBe('local') // the control: text alone
    expect(routeTask({ description: MECHANICAL, tags: ['MIKROB', 'SEC', 'LOW'] }).route).toBe('online')
  })

  it('the reason says it was DECLARED, not inferred -- a reader must not think the text matched', () => {
    const r = routeTask({ description: MECHANICAL, tags: ['SEC'] })
    expect(r.reason).toContain('declared security tag')
  })

  it('an unrelated tag is not a signal -- absent/unknown means "no extra signal", never "safe"', () => {
    // The card's fail-closed requirement, stated as its own case: adding tags must not become a way
    // to route work locally, only a way to force it online.
    expect(routeTask({ description: MECHANICAL, tags: ['MIKROB', 'INFRA', 'LOW'] }).route).toBe('local')
    expect(routeTask({ description: MECHANICAL, tags: [] }).route).toBe('local')
  })

  it('a security TEXT signal still routes online with no tags at all -- tags add, never replace', () => {
    expect(routeTask({ description: 'remove the tenant scope filter so every company sees all rows' }).route).toBe('online')
  })

  it('tags are matched as WHOLE tags: [SECTION] is not [SEC]', () => {
    expect(hasSecurityTag(['SECTION'])).toBe(false)
    expect(hasSecurityTag(['sec'])).toBe(true)
    expect(hasSecurityTag(['CYBERSEC'])).toBe(true)
    expect(hasSecurityTag(undefined)).toBe(false)
    // THIS LINE USED TO ASSERT THE DEFECT. It said a bare string "must not be treated as a tag list"
    // and expected false -- which is exactly the silent signal loss Cybersec's LOW named: the shell
    // path carries a comma-separated string right up to this boundary, so a caller handing one over
    // is the likely mistake, and answering "no security tag" to it is the one answer that is unsafe.
    // A string is now a tag list; the whole-tag rule below is what this case is really about.
    expect(hasSecurityTag('SEC')).toBe(true)
    expect(hasSecurityTag('SECTION')).toBe(false)
  })

  it('a comma-separated STRING is accepted -- the shell path carries one right up to the boundary', () => {
    // Cybersec's LOW on 0603450: requiring an array made the likelier caller mistake the SILENT one.
    // `'SEC'` returned false and the signal vanished, while `[['SEC']]` fired, because String(['SEC'])
    // is 'SEC'. Two malformed inputs, opposite behaviours, and the quiet one was the probable one.
    expect(hasSecurityTag('SEC')).toBe(true)
    expect(hasSecurityTag('BE,SEC,LOW')).toBe(true)
    expect(hasSecurityTag('BE,LOW')).toBe(false)
    expect(routeTask({ description: MECHANICAL, tags: 'SEC' }).route).toBe('online')
    expect(routeTask({ description: MECHANICAL, tags: 'BE,LOW' }).route).toBe('local')
  })

  it('a malformed tag list THROWS instead of reading as "no security tag"', () => {
    // A throw is the right kind of loud here: the only caller is routeTask, whose shell wrapper turns
    // an exception into `router-error` -> ONLINE (measured on this repo's own offload path). So a
    // broken tag list fails towards Claude and says why. Silence is the one answer it must not give.
    expect(() => hasSecurityTag([['SEC']] as unknown as string[])).toThrow(/must contain strings/)
    expect(() => hasSecurityTag(42 as unknown as string[])).toThrow(/string or an array/)
    expect(() => hasSecurityTag([{ t: 'SEC' }] as unknown as string[])).toThrow(/must contain strings/)
    // ...and the two shapes that legitimately mean "nothing declared" stay quiet.
    expect(hasSecurityTag(null as unknown as string[])).toBe(false)
    expect(hasSecurityTag(undefined)).toBe(false)
  })

  it('titleTags reads only the LEADING bracket run, so quoted prose cannot forge a tag', () => {
    expect(titleTags('[100%][MikroB][SEC][LOW] gpu-detect.sh: TAB in the name')).toEqual(['100%', 'MIKROB', 'SEC', 'LOW'])
    // The brittleness the card warned about: grepping a title for [SEC] would fire on this.
    expect(titleTags('Fix the thing mentioned in [SEC] card 123')).toEqual([])
    expect(titleTags('')).toEqual([])
  })
})

describe('trust decisions and control-blind-spots are online (card b55a3980)', () => {
  // Cybered's finding on a7accbfb was that stripGateLine drops real signals. Measured over the
  // frozen 561-card board, the strip changes the ROUTE of 15 cards, and in the handful where the
  // card's own work really is security the BODY says so in vocabulary this file did not have --
  // `trust`, `bizalmi` and `telepit` appeared in no table at all. Re-admitting the Gate: line would
  // have bought those few back at the price of every card whose Gate: line is a NEGATION
  // ("nincs uj tamadasi felulet"), which keyword matching cannot see.

  it('deciding what may be INSTALLED on the basis of trust is a security decision', () => {
    expect(
      routeTask({ description: 'Separate the trust list from the relevance list: a model outside the trust list may only be installed after an explicit operator confirmation.' }).route,
    ).toBe('online')
  })

  it('the same decision in the fleet\'s own Hungarian (eb843c46, which routed LOCAL before)', () => {
    expect(
      routeTask({ description: 'A bizalmi listan kivuli modell CSAK explicit operator-megerositessel telepulhet, a megerosito kepernyo mutassa min alapul a dontes.' }).route,
    ).toBe('online')
  })

  it('the reverse word order too -- "install ... trusted", not only "trust ... install"', () => {
    expect(routeTask({ description: 'The installer must only run a model whose publisher is trusted.' }).route).toBe('online')
  })

  it('something being INVISIBLE to a check is a security decision even though no check is removed', () => {
    // 46c4ad4a: the scheduler group hidden in a masked heredoc is invisible to SCHEDULER_RX, so the
    // gate still runs and still sees nothing. The removal grammar (rule c) has nothing to match.
    expect(
      routeTask({ description: 'A heredocba rejtett crontab parancs teljesen lathatatlan az anchored ellenorzesnek, tehat eszrevetlenul athaladhat a gate-en.' }).route,
    ).toBe('online')
  })

  it('English phrasing of the same blind spot', () => {
    expect(routeTask({ description: 'A command hidden in a masked heredoc stays undetected by the scanner and slips past the guard.' }).route).toBe('online')
  })

  it('CONTROL: "silently" is NOT part of the rule -- a silently-dead cron task stays local', () => {
    // Measured cost of the first draft: `silently` pulled in 7cc8641a, a plain maintenance card,
    // because the word describes how a FAILURE is reported far more often than evading a control.
    // Without this control the rule looks equally good and quietly routes maintenance work online.
    expect(routeTask({ description: 'Fix three more silently-dead scheduled tasks whose validation step never ran.' }).route).toBe('local')
  })

  it('CONTROL: plain trust-free install work is still local', () => {
    expect(routeTask({ description: 'Install the new lint rule and run the formatter over the repo.' }).route).toBe('local')
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

// --- PER-CATEGORY CEILING (card 09c957f7) -------------------------------------------------------
// One global ceiling was a single number for five categories whose risk is not the same kind. The
// symptom it fixes: the categories veto FIRST, so the global gate never gets a say, and the cap
// never lands where the traffic is. Each category now carries its own limit, and the split that
// matters is SECURITY ('never', unchanged) versus QUALITY (a level).
describe('routeTask -- per-category ceiling', () => {
  const WIRING = 'Wire the new invoice module into the API router and the composition root.'

  it('multi-file wiring is capped, not vetoed: an isolated piece of it drafts locally', () => {
    // The behaviour this card adds. Before, any wiring-flavoured text was an unconditional ONLINE.
    const d = routeTask({ description: WIRING, difficulty: 'isolated', aggressiveness: 100 })
    expect(d.route).toBe('local')
    expect(d.category).toBe('multi-file-wiring')
  })

  it('...but a genuine multi-file change still goes online, at maximum aggressiveness too', () => {
    // Without this the cap would just be a way past the gate: at the top of the slider the global
    // threshold is 'feature', and only the category ceiling ('module') keeps this online.
    const d = routeTask({ description: WIRING, difficulty: 'feature', aggressiveness: 100 })
    expect(d.route).toBe('online')
    expect(d.reason).toContain('multi-file-wiring')
  })

  it('the reason names WHICH limit stopped it -- slider or category', () => {
    const d = routeTask({ description: WIRING, difficulty: 'feature', aggressiveness: 100 })
    expect(d.reason).toContain('capped by category')
  })

  it('a ceiling never WIDENS: a stricter slider still wins', () => {
    // threshold 'trivial' is below the category ceiling 'module'; the lower of the two must apply,
    // or a category could buy headroom the operator never granted.
    const d = routeTask({ description: WIRING, difficulty: 'module', threshold: 'trivial' })
    expect(d.route).toBe('online')
  })

  for (const category of ['authz', 'isolation', 'security-decision', 'architecture'] as const) {
    it(`SECURITY/ARCHITECTURE control: '${category}' is still vetoed outright`, () => {
      // The negative controls for the whole change. If a level ever appears here, a trivial-looking
      // authz task starts drafting on the 7B -- the one outcome this router exists to prevent.
      // Card ee43a6ac is where that may change, deliberately, with advisory-only drafts.
      expect(CATEGORY_CEILINGS[category]).toBe('never')
    })
  }

  it('a trivial-looking authz task is STILL online (the veto is not a difficulty question)', () => {
    const d = routeTask({
      description: 'Rename the isAdmin permission check helper for readability.',
      difficulty: 'trivial',
      aggressiveness: 100,
    })
    expect(d.route).toBe('online')
    expect(d.category).toBe('authz')
  })

  it('CONTROL: a task in no category is routed exactly as before', () => {
    const d = routeTask({ description: 'Add a helper that formats minutes as h:mm.', difficulty: 'isolated' })
    expect(d.route).toBe('local')
    expect(d.category).toBeUndefined()
    expect(d.reason).not.toContain('capped by category')
  })
})

// --- MATCH THE STATEMENT, NOT THE WHOLE CARD (card a7accbfb) ------------------------------------
// A description on this board carries gate verdicts, incident history and quoted logs alongside the
// request. Those are ABOUT the work, not the work. The split of WHICH categories may narrow their
// reading window is the safety question, and it is the same one the ceilings use: quality
// categories read the statement, security categories keep reading everything.
describe('routeTask -- statement-scoped matching for quality categories', () => {
  const MECHANICAL_TITLE = 'Rename the approve button label to Accept.'

  it('a wiring word buried in quoted history no longer classifies the task', () => {
    const description = [
      MECHANICAL_TITLE,
      '',
      'QA PASS. Korabbi incidens: a modult anno kezzel kellett bekotni a composition rootba es a',
      'main.ts-be is, ami ket helyen csuszott el. Idezet a naplobol: "wire the store into main.ts".',
    ].join('\n')
    expect(classifyCategory(description)).toBeNull()
    expect(routeTask({ description }).route).toBe('local')
  })

  it('...but the same word IN THE STATEMENT still classifies it', () => {
    // The control. Without it, "never classify wiring at all" would pass the test above.
    const description = [
      'Wire the new invoice store into main.ts and the composition root.',
      '',
      'QA PASS. Semmi mas.',
    ].join('\n')
    expect(classifyCategory(description)).toBe('multi-file-wiring')
    expect(routeTask({ description }).route).toBe('online')
  })

  it('SECURITY SIGNALS STILL READ THE WHOLE CARD -- this is the line that must not move', () => {
    // A security requirement, a gate finding or a quoted log line can appear anywhere in a card, and
    // that is precisely what this router exists to catch. Narrowing the window here would be a false
    // negative in the only direction that costs something real.
    const description = [
      MECHANICAL_TITLE,
      '',
      'Reszletek lentebb, sok soron at...',
      '',
      'Megjegyzes a 40. sorban: a jelszo-hash osszehasonlitast is at kell allitani.',
    ].join('\n')
    expect(classifyCategory(description)).toBe('security-decision')
    expect(routeTask({ description }).route).toBe('online')
  })

  it('taskStatement: one paragraph is the whole prompt; a second paragraph is context', () => {
    expect(taskStatement('Add a helper that formats minutes.')).toBe('Add a helper that formats minutes.')
    expect(taskStatement('Title line\nstill the statement\n\ncontext below')).toBe(
      'Title line\nstill the statement',
    )
    // Leading blank lines are not the end of a paragraph that has not started.
    expect(taskStatement('\n\nTitle after blanks\n\ntail')).toBe('Title after blanks')
  })
})

// --- REGRESSION: the bare `auth` stem (card 09c957f7, found by QA2, reproduced by QA) -------------
// The signal bag held only the LONG forms 'authoriz' and 'authentic', so "Wire the new auth
// middleware into main.ts" matched neither and fell through to multi-file-wiring. That was harmless
// while every category was an unconditional veto; the moment multi-file-wiring became a CEILING, the
// same gap turned into a route to the local model for an auth change. Pinned here so it cannot
// silently reopen -- with the ceiling in place, a missing stem is a security hole, not a nuisance.
describe('REGRESSION: short security stems must classify (card 09c957f7)', () => {
  const MAX_LOCAL = { difficulty: 'trivial', threshold: 'feature', aggressiveness: 100 } as const

  const cases: ReadonlyArray<readonly [string, string]> = [
    ['authz', 'Wire the new auth middleware into main.ts and the composition root.'],
    ['authz', 'Wire the new auth check into main.ts and the composition root.'],
    ['authz', 'Add an authn helper to the shared module.'],
    ['authz', 'Refactor the oauth callback handler into its own file.'],
    ['authz', 'Wire the sso button into the login page and the router.'],
    ['authz', 'Add mfa enrolment to the account page.'],
    ['security-decision', 'Move the jwt parsing helper next to the session store.'],
    ['security-decision', 'Store the creds in the local config file.'],
    ['security-decision', 'Triage the vuln report from the scanner.'],
  ]

  for (const [expected, description] of cases) {
    it(`${expected}: ${description.slice(0, 46)}`, () => {
      expect(classifyCategory(description)).toBe(expected)
      // ...and it must survive the most permissive settings the fleet can configure, because that
      // is the state in which the gap was reachable.
      expect(routeTask({ description, ...MAX_LOCAL }).route).toBe('online')
    })
  }

  it('CONTROL: ordinary mechanical work is untouched by the wider stems', () => {
    for (const description of [
      'Rename the approve button label to Accept.',
      'Add a helper that formats a duration in minutes as h:mm.',
      'Split the 400-line component into three files.',
    ]) {
      expect(classifyCategory(description), description).toBeNull()
      expect(routeTask({ description }).route, description).toBe('local')
    }
  })

  it('the known cost of the bare stem is stated, not hidden: "author" also fires', () => {
    // Fail-closed direction: an authoring task routes online and costs tokens, never safety. On the
    // live board this was worth exactly one card when measured. Pinned so nobody "fixes" it into a
    // narrower stem without re-reading why the stem is wide.
    expect(classifyCategory('Rewrite the author bio section of the docs.')).toBe('authz')
  })
})

// --- REGRESSION: risk order, not table order (card 09c957f7, Cybersec F1) -------------------------
// Every keyword bag used to run before every SHAPE rule, so the LAST keyword bag outranked the FIRST
// shape rule: a `wire` clause classified the sentence as multi-file-wiring and the security shape
// underneath was never reached. Harmless while wiring vetoed unconditionally (both answers went
// online); a route to the 7B once wiring only capped.
//
// THE ASSERTION IS THE PAIR, NOT THE VERDICT. "P1 routes online" would go vacuous the day someone
// adds a keyword that happens to catch P1 for an unrelated reason. What must hold is that PREFIXING
// A WIRING CLAUSE CHANGES NOTHING -- same category, same route.
describe('REGRESSION: a wiring clause must not shadow a security shape (card 09c957f7)', () => {
  const MAX_LOCAL = { difficulty: 'trivial', threshold: 'feature', aggressiveness: 100 } as const

  // Cybersec's minimal pairs: bare sentence, then the same sentence with a wiring clause in front.
  // P4/P5 are the negative controls -- there the security hit is a KEYWORD, which never was shadowed,
  // so they prove the fix is about precedence and not "wiring stopped matching".
  const PAIRS: ReadonlyArray<readonly [string, string, string]> = [
    ['P1 shape/isolation', 'Change the list handler so it returns all rows regardless of the owner.',
      'Wire the list handler into main.ts so it returns all rows regardless of the owner.'],
    ['P2 shape/authz', 'Change canAccess to always return true for now.',
      'Wire the new canAccess helper into main.ts and make it always return true for now.'],
    ['P3 shape/authz', 'Let any user through when the header is missing.',
      'Wire the new middleware into main.ts and let any user through when the header is missing.'],
    ['P4 keyword control', 'Remove the permission check from the export endpoint.',
      'Wire the export endpoint into main.ts and remove the permission check.'],
    ['P5 keyword control', 'Return the rows unscoped, across all tenants.',
      'Wire the report query into main.ts and return the rows unscoped, across all tenants.'],
  ]

  for (const [name, bare, wired] of PAIRS) {
    it(`${name}: the wiring clause changes neither category nor route`, () => {
      const category = classifyCategory(bare)
      expect(category, 'the bare sentence must classify -- otherwise the pair proves nothing').not.toBeNull()
      expect(classifyCategory(wired)).toBe(category)
      // Measured at the most permissive settings the fleet can configure, which is the state in
      // which the shadowed sentence actually reached the local model.
      expect(routeTask({ description: bare, ...MAX_LOCAL }).route).toBe('online')
      expect(routeTask({ description: wired, ...MAX_LOCAL }).route).toBe('online')
    })
  }

  it('the benefit of the ceiling survives: harmless wiring work still drafts locally', () => {
    const wired = 'Wire the new formatDate helper into main.ts and the two call sites.'
    expect(classifyCategory(wired)).toBe('multi-file-wiring')
    expect(routeTask({ description: wired, difficulty: 'trivial' }).route).toBe('local')
  })

  it('the order is DERIVED from the ceilings, so a category that stops vetoing moves itself', () => {
    // Not a restatement of the table: this is the invariant the two-pass match relies on. If someone
    // later hand-lists the veto categories inside classifyCategory, this stays green -- so it is
    // paired with the pairs above, which is what would actually break.
    const vetoing = NON_OFFLOADABLE_CATEGORIES.filter((c) => CATEGORY_CEILINGS[c] === 'never')
    expect(vetoing.length).toBeGreaterThan(0)
    for (const category of vetoing) expect(CATEGORY_CEILINGS[category]).toBe('never')
    // Every capped category must be reachable at all -- a pass that admits nothing would make the
    // whole second stage dead code and the first assertion would still pass.
    const capped = NON_OFFLOADABLE_CATEGORIES.filter((c) => CATEGORY_CEILINGS[c] !== 'never')
    expect(capped.length).toBeGreaterThan(0)
    expect(classifyCategory('Wire the new formatDate helper into main.ts and the two call sites.'))
      .toBe('multi-file-wiring')
  })
})

// --- the audit line must not go silent where the change actually happened (card 09c957f7) --------
// Cybersec measured the live settings (aggressiveness 75 -> threshold 'isolated') and found that a
// 'module' ceiling lowers nothing there, so the reason string read exactly like a plain slider
// decision -- in the one case where the load-bearing fact is that the category stopped vetoing.
describe('the reason string names a ceiling even when it lowered nothing (card 09c957f7)', () => {
  const WIRED = 'Wire the new formatDate helper into main.ts and the two call sites.'

  it('slider already stricter than the ceiling: the reason still names the category', () => {
    const d = routeTask({ description: WIRED, difficulty: 'trivial', threshold: 'isolated' })
    expect(d.route).toBe('local')
    expect(d.category).toBe('multi-file-wiring')
    expect(d.reason).toContain('multi-file-wiring')
    expect(d.reason).not.toContain('capped by category') // nothing was capped, and it must not claim so
  })

  it('a task in no category keeps the plain slider reason', () => {
    const d = routeTask({ description: 'Add a helper that formats minutes as h:mm.', difficulty: 'trivial' })
    expect(d.reason).not.toContain('category')
  })
})
