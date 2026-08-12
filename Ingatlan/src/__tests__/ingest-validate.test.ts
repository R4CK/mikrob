import { describe, it, expect } from 'vitest'
import { validateIngestListing } from '../ingest-validate.js'

const valid = () => ({
  id: 'l1',
  url: 'https://ingatlan.com/lakas/l1',
  tipus: 'lakas',
  allapot: 'jó állapotú',
  epitesiEv: 1995,
  cim: 'Budapest II. ker.',
  alapteruletM2: 65,
  ar: 80_000_000,
  nm2Ar: 1_230_769,
})

describe('validateIngestListing', () => {
  it('accepts a fully valid listing', () => {
    const result = validateIngestListing(valid())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.listing.id).toBe('l1')
  })

  it('accepts null for the nullable fields', () => {
    const result = validateIngestListing({
      ...valid(),
      allapot: null,
      epitesiEv: null,
      cim: null,
      alapteruletM2: null,
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a non-object payload', () => {
    expect(validateIngestListing('not an object').ok).toBe(false)
    expect(validateIngestListing(null).ok).toBe(false)
    expect(validateIngestListing(42).ok).toBe(false)
  })

  it('rejects a missing or empty id', () => {
    expect(validateIngestListing({ ...valid(), id: '' }).ok).toBe(false)
    expect(validateIngestListing({ ...valid(), id: undefined }).ok).toBe(false)
  })

  it('rejects a malformed url', () => {
    const r = validateIngestListing({ ...valid(), url: 'not a url' })
    expect(r).toEqual({ ok: false, error: 'url is not a valid URL' })
  })

  it('rejects a url on a DIFFERENT domain (defense against a planted arbitrary link)', () => {
    const r = validateIngestListing({ ...valid(), url: 'https://evil.example.com/lakas/l1' })
    expect(r).toEqual({ ok: false, error: 'url must be on the ingatlan.com domain' })
  })

  it('accepts a subdomain of ingatlan.com but rejects a lookalike domain', () => {
    expect(validateIngestListing({ ...valid(), url: 'https://www.ingatlan.com/x' }).ok).toBe(true)
    expect(validateIngestListing({ ...valid(), url: 'https://ingatlan.com.evil.com/x' }).ok).toBe(false)
    expect(validateIngestListing({ ...valid(), url: 'https://notingatlan.com/x' }).ok).toBe(false)
  })

  it('rejects a non-https url', () => {
    const r = validateIngestListing({ ...valid(), url: 'http://ingatlan.com/x' })
    expect(r).toEqual({ ok: false, error: 'url must be https' })
  })

  it('rejects an invalid tipus', () => {
    expect(validateIngestListing({ ...valid(), tipus: 'garazs' }).ok).toBe(false)
    expect(validateIngestListing({ ...valid(), tipus: 123 }).ok).toBe(false)
  })

  it('rejects an implausible epitesiEv', () => {
    expect(validateIngestListing({ ...valid(), epitesiEv: 1500 }).ok).toBe(false)
    expect(validateIngestListing({ ...valid(), epitesiEv: 3000 }).ok).toBe(false)
    expect(validateIngestListing({ ...valid(), epitesiEv: 'old' }).ok).toBe(false)
  })

  it('rejects a non-positive alapteruletM2', () => {
    expect(validateIngestListing({ ...valid(), alapteruletM2: 0 }).ok).toBe(false)
    expect(validateIngestListing({ ...valid(), alapteruletM2: -10 }).ok).toBe(false)
  })

  it('rejects a non-positive or non-numeric ar/nm2Ar', () => {
    expect(validateIngestListing({ ...valid(), ar: 0 }).ok).toBe(false)
    expect(validateIngestListing({ ...valid(), ar: '80000000' }).ok).toBe(false)
    expect(validateIngestListing({ ...valid(), nm2Ar: NaN }).ok).toBe(false)
    expect(validateIngestListing({ ...valid(), nm2Ar: Infinity }).ok).toBe(false)
  })

  it('rejects an empty-string allapot/cim (distinct from null)', () => {
    expect(validateIngestListing({ ...valid(), allapot: '' }).ok).toBe(false)
    expect(validateIngestListing({ ...valid(), cim: '' }).ok).toBe(false)
  })
})
