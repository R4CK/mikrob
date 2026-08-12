// Tests the extension's pure text-parsing helpers (Ingatlan/extension/parse-listing-text.js).
// UNVERIFIED AGAINST THE REAL PAGE (see README "Blokkolt") -- these fixtures are constructed
// approximations of typical Hungarian real-estate listing text, not captured real markup. What
// this DOES prove: the regex/number-parsing logic itself is correct for the price/area formats it
// is designed to handle, so if a real debug capture later shows the SAME text shapes with
// different surrounding markup, only the DOM-selection step (content-script.js) needs fixing, not
// this parsing logic too.
import { describe, it, expect } from 'vitest'
import {
  parseHunNumber,
  findPrice,
  findAreaM2,
  findNm2Ar,
  findAllapot,
  findEpitesiEv,
  findCim,
  // @ts-expect-error -- plain JS extension file, no type declarations
} from '../../extension/parse-listing-text.js'

describe('parseHunNumber', () => {
  it('parses dot-separated thousands', () => expect(parseHunNumber('89.900.000')).toBe(89900000))
  it('parses space-separated thousands', () => expect(parseHunNumber('89 900 000')).toBe(89900000))
  it('parses a comma-decimal figure', () => expect(parseHunNumber('89,9')).toBe(89.9))
  it('parses a plain integer', () => expect(parseHunNumber('1234')).toBe(1234))
})

describe('findPrice', () => {
  it('parses "X,X M Ft" (millions) form', () => {
    expect(findPrice('Ár: 89,9 M Ft')).toBe(89_900_000)
  })
  it('parses "X MFt" form', () => {
    expect(findPrice('115 MFt')).toBe(115_000_000)
  })
  it('parses a full spelled-out price with thousands separators', () => {
    expect(findPrice('89 900 000 Ft')).toBe(89_900_000)
  })
  it('does NOT mistake a per-m2 price for the total price', () => {
    // Only a "Ft/m²" figure present, no total -- must not match it as the total price.
    expect(findPrice('1 234 567 Ft/m²')).toBeNull()
  })
  it('picks the TOTAL price even when a per-m2 price also appears in the same text', () => {
    const text = '89 900 000 Ft (1 234 567 Ft/m²)'
    expect(findPrice(text)).toBe(89_900_000)
  })
  it('returns null when no price pattern is present', () => {
    expect(findPrice('nincs ár feltüntetve')).toBeNull()
  })
})

describe('findAreaM2', () => {
  it('parses "m²"', () => expect(findAreaM2('73 m²')).toBe(73))
  it('parses "m2" (no superscript)', () => expect(findAreaM2('73 m2')).toBe(73))
  it('parses a decimal area', () => expect(findAreaM2('72,5 m²')).toBe(72.5))
  it('returns null when absent', () => expect(findAreaM2('no area here')).toBeNull())
})

describe('findNm2Ar', () => {
  it('prefers an EXPLICIT Ft/m2 figure over price/area division', () => {
    // Division would give 89900000/73 = 1231506.8..., but the explicit figure wins.
    expect(findNm2Ar('89 900 000 Ft, 1 231 000 Ft/m²', 89_900_000, 73)).toBe(1_231_000)
  })
  it('falls back to price / area when no explicit figure is present', () => {
    expect(findNm2Ar('no explicit figure', 1000, 10)).toBe(100)
  })
  it('returns null when neither an explicit figure nor price/area is available', () => {
    expect(findNm2Ar('nothing', null, null)).toBeNull()
  })
})

describe('findAllapot', () => {
  it('matches a known condition keyword', () => {
    expect(findAllapot('Állapota: felújított, 2 szoba')).toBe('felújított')
  })
  it('returns null when no known keyword is present', () => {
    expect(findAllapot('nincs adat az állapotról')).toBeNull()
  })
})

describe('findEpitesiEv', () => {
  it('parses a plausible year after "épült"', () => {
    expect(findEpitesiEv('Épült: 1998')).toBe(1998)
  })
  it('rejects an implausible year', () => {
    expect(findEpitesiEv('épült 3050')).toBeNull()
  })
  it('returns null when absent', () => {
    expect(findEpitesiEv('no build year')).toBeNull()
  })
})

describe('findCim', () => {
  it('picks a short line mentioning Budapest', () => {
    expect(findCim('89,9 M Ft\nBudapest II. kerület, Hűvösvölgy\n73 m²')).toBe('Budapest II. kerület, Hűvösvölgy')
  })
  it('returns null when no Budapest-mentioning line is short enough', () => {
    const longLine = 'Budapest ' + 'x'.repeat(130)
    expect(findCim(longLine)).toBeNull()
  })
  it('returns null when there is no address-like line at all', () => {
    expect(findCim('89,9 M Ft\n73 m²')).toBeNull()
  })
})
