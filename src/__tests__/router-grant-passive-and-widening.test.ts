// Three morphology gaps in the SHAPE rules, all closed the same way as card 339d7d0b's (3b) mirror
// rule (card 0f1e9fa9).
//
// (1b) grant-family passive voice. Rule (1) requires the bag-word (access|request|...) AFTER the
// verb within 35 chars. Passive voice puts the bag-word BEFORE the verb ("access is granted to the
// support team"), so it went unmatched even though the word was already in the list. MikroB's
// correction: this was NOT a recipient-noun vocabulary gap (nouns cannot be stemmed the way
// verbAlternation() stems verbs) -- it is the same word-order gap (3b) closed for the ceasing-to-
// apply family, applied to the granting family. Zero new vocabulary.
//
// (5)/(6) hand-listed verb groups missing the past participle, PLUS the same word-order gap as
// (1b). The card's own diagnosis named only the missing participle ("moved", "widened", ...), and
// migrating the verb group to verbAlternation() alone was measured here to be insufficient: (5)/(6)
// are still verb-then-noun, and the card's own motivating examples -- "The check was moved to the
// browser." and "The query was widened so a foreman sees all crews." (the exact card Cybered wrote
// family (6) for, c1661fff) -- are passive, so the guard/scope noun precedes the verb and nothing
// follows it within the window. Closed the same way as (1b)/(3b): a mirrored (5b)/(6b) rule,
// noun-then-copula-then-verb, zero new vocabulary (reuses the same verbAlternation() call).
//
// NEUTRAL NOUNS ONLY. MikroB's own self-correction on the prior measurement: probing with
// permission/validation/authorization words proves the KEYWORD BAG fires, not the SHAPE rule --
// those words are already in CATEGORY_SIGNALS and route ONLINE regardless of SHAPE_SIGNALS. Every
// assertion below uses a noun absent from every CATEGORY_SIGNALS bag (checked against the bag lists
// directly), so a pass here can only be the SHAPE rule.
import { describe, it, expect } from 'vitest'
import { routeTask, verbForms } from '../local-llm-router.js'

describe('(1b) grant-family passive mirror (card 0f1e9fa9)', () => {
  it.each([
    ['access ... support team', 'Update the handler so access is granted to the support team.'],
    ['access ... role', 'Update the handler so access is granted to the role.'],
    ['request ... warehouse role', 'Update the handler so the request is permitted for the warehouse role.'],
    ['user ... reviewers', 'Update the handler so the user is allowed for the reviewers group.'],
  ])('routes ONLINE (was LOCAL before the mirror rule): %s', (_label, description) => {
    expect(routeTask({ description }).route).toBe('online')
  })

  it('CONTROL: the bag-word with no copula+verb between it and the sentence stays LOCAL', () => {
    // "access" is in the bag-word list, but nothing here is being granted/allowed/permitted.
    expect(routeTask({ description: 'The access log line appears at the bottom of the page.' }).route).toBe('local')
  })

  it('does not regress the already-working active-voice direction (rule 1, forward order)', () => {
    expect(routeTask({ description: 'Update the handler so access is granted to the caller.' }).route).toBe('online')
  })
})

describe('(5b) control-moved-to-client, passive mirror (card 0f1e9fa9)', () => {
  it('routes ONLINE with the past participle and a NEUTRAL guard noun ("check")', () => {
    expect(routeTask({ description: 'The check was moved to the browser.' }).route).toBe('online')
  })

  it('does not regress the already-working active-voice direction', () => {
    expect(routeTask({ description: 'Move the check to the browser instead of the server.' }).route).toBe('online')
  })

  it('CONTROL: an ordinary relocation with no guard noun stays LOCAL', () => {
    expect(routeTask({ description: 'The team decided to move the stand-up meeting to the afternoon.' }).route).toBe('local')
  })
})

describe('(6b) widening family, passive mirror (card 0f1e9fa9, family from c1661fff)', () => {
  it('routes ONLINE with the past participle -- the exact card this family exists for', () => {
    expect(routeTask({ description: 'The query was widened so a foreman sees all crews.' }).route).toBe('online')
  })

  it.each([
    ['broadened', 'The endpoint filter was broadened during the last refactor.'],
    ['expanded', 'The visibility scope was expanded without anyone noticing.'],
  ])('routes ONLINE: %s', (_label, description) => {
    expect(routeTask({ description }).route).toBe('online')
  })

  it('does not regress the already-working active-voice direction', () => {
    expect(routeTask({ description: 'Widen the query so a foreman sees all crews.' }).route).toBe('online')
  })

  it('CONTROL: an ordinary business-expansion sentence with no scope noun stays LOCAL', () => {
    // "company" is deliberately avoided here -- it is its own CATEGORY_SIGNALS keyword (isolation
    // bag), so a sentence using it would pass for the wrong reason (keyword bag, not this rule).
    expect(routeTask({ description: 'The bakery plans to expand into two new neighborhoods next year.' }).route).toBe('local')
  })
})

describe('generator produces the participle for every stem the three fixes rely on', () => {
  it('grant-family stems (1b)', () => {
    expect(verbForms('grant')).toContain('granted')
    expect(verbForms('permit')).toContain('permitted')
    expect(verbForms('allow')).toContain('allowed')
  })

  it('move-family stems (5) -- the exact forms the hand-written list omitted', () => {
    expect(verbForms('move')).toContain('moved')
    expect(verbForms('shift')).toContain('shifted')
    expect(verbForms('relocate')).toContain('relocated')
    expect(verbForms('push')).toContain('pushed')
  })

  it('widen-family stems (6) -- the exact forms the hand-written list omitted', () => {
    expect(verbForms('widen')).toContain('widened')
    expect(verbForms('broaden')).toContain('broadened')
    expect(verbForms('expand')).toContain('expanded')
  })
})
