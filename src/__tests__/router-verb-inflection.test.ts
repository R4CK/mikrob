// The SHAPE rules must catch a verb in every form it is written in (card 339d7d0b, Cybersec).
//
// WHAT WAS ACTUALLY BROKEN. The OUTCOME-family rules listed their verbs by hand -- `treat|treats|
// treating` -- and every one of those lists was missing the PAST PARTICIPLE. That is not an exotic
// form: it is how a card states a change that has already been decided. "A missing role is TREATED
// as owner." "The filter is BYPASSED." "The check is no longer APPLIED." Cybersec measured 14 such
// gaps across three families on the installed artifact.
//
// WHY THESE RULES AND NOT THE KEYWORD BAGS. This family exists for sentences that contain no
// security NOUN at all, so the keyword lists never see them and the stage-1 7B classifier calls
// them MECHANICAL. Where the shape does not fire there is no second line.
//
// TWO SEPARATE FIXES CAME OUT OF IT, and the second was not in the card:
//   1. the forms are GENERATED from the stem, so the next verb is not a fifteenth bug;
//   2. rule (3) only matched verb-then-object, and the PASSIVE reverses that order -- "the scope
//      check is omitted". Adding participles fixed 12 of 14; the two stragglers were a grammar gap
//      wearing a vocabulary gap's clothes. A mirrored rule closes it, the same way the older
//      guard-noun family already carries both directions.
//
// PRICE, MEASURED BEFORE LANDING rather than assumed: route-histogram.mjs over all 479 live cards,
// old artifact vs new, gave LOCAL 206 / ONLINE 273 both times with every category count identical.
// 13 real gaps closed and 0 cards moved. Zero movement would be a worrying result on its own -- it
// is also what an inert change looks like -- which is why the sentence-level A/B below is the proof
// that the rules actually fire, and the prose control is the proof that they do not fire on
// everything.
import { describe, it, expect } from 'vitest'
import { routeTask, verbForms } from '../local-llm-router.js'

/** The exact 14 forms Cybersec measured, each in its family's sentence frame. */
const MEASURED_GAPS: ReadonlyArray<readonly [string, string]> = [
  ['(2) treated', 'Update the loader so a missing role is treated as owner.'],
  ['(2) interprets', 'Update the loader so it interprets a missing role as owner.'],
  ['(2) interpreted', 'Update the loader so a missing role is interpreted as owner.'],
  ['(2) considered', 'Update the loader so a missing role is considered as owner.'],
  ['(2) counted', 'Update the loader so a missing role is counted as owner.'],
  ['(2) regarded', 'Update the loader so a missing role is regarded as owner.'],
  ['(2) mapped', 'Update the loader so a missing role is mapped as owner.'],
  ['(1) granted', 'Update the handler so access is granted to the caller.'],
  ['(1) allowed', 'Update the handler so the request is allowed through.'],
  ['(1) permitted', 'Update the handler so the request is permitted through.'],
  ['(1) lets', 'Update the handler so it lets any user through.'],
  ['(3) bypassed', 'Update the loader so the tenant filter is bypassed.'],
  ['(3) omitted', 'Update the loader so the scope check is omitted.'],
  ['(3) no longer applied', 'Update the loader so the filter is no longer applied.'],
]

describe('SHAPE rules are morphology-tolerant (card 339d7d0b)', () => {
  it.each(MEASURED_GAPS)('routes ONLINE: %s', (_label, description) => {
    expect(routeTask({ description }).route).toBe('online')
  })

  it('the generator produces the participle for every stem the rules use', () => {
    // Pinned at the generator rather than only through routeTask, so a regression names the cause
    // instead of pointing at fourteen sentences.
    expect(verbForms('treat')).toContain('treated')
    expect(verbForms('apply')).toContain('applied') // y -> ied; `apply\w*` never matched this
    expect(verbForms('permit')).toContain('permitted') // consonant doubling
    expect(verbForms('map')).toContain('mapped')
    expect(verbForms('let')).toContain('lets')
    expect(verbForms('bypass')).toContain('bypassed') // sibilant -> es, but past is plain +ed
  })

  it('over-generates rather than guessing, because the two errors are not equal', () => {
    // "interpret" and "map" have the same consonant-vowel-consonant ending and inflect differently,
    // and spelling alone cannot tell them apart. Emitting both costs one dead alternation branch;
    // picking wrong costs a routing hole. So both must be present.
    expect(verbForms('interpret')).toEqual(expect.arrayContaining(['interpreted', 'interpretted']))
    expect(verbForms('map')).toEqual(expect.arrayContaining(['mapped', 'maped']))
  })

  it('CONTROL: ordinary prose using the same verb forms stays LOCAL', () => {
    // The widened forms include everyday words -- counted, mapped, allowed, applied, treated. If
    // they fired on any sentence containing them, the rule would be a synonym for "route
    // everything online" and the 14 assertions above would pass for the wrong reason.
    for (const description of [
      'The dashboard shows how many rows were counted as duplicates in the import.',
      'The CSV columns are mapped as strings before the chart renders them.',
      'Increase the upload size that is allowed by the reverse proxy config.',
      'The brand colours are applied to the print stylesheet.',
      'In the changelog the beta builds are treated as drafts for the release notes.',
    ]) {
      expect(routeTask({ description }).route, description).toBe('local')
    }
  })
})
