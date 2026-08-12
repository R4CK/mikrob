import type { IngatlanTipus, ScrapedListing } from './types.js'

export type ValidationResult = { ok: true; listing: ScrapedListing } | { ok: false; error: string }

const TIPUS_VALUES: IngatlanTipus[] = ['haz', 'lakas']

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

// Zero Trust: this data crosses a real trust boundary (a browser extension's content script,
// running in the context of a THIRD-PARTY page, posting to a local HTTP endpoint) even though
// the endpoint only binds to 127.0.0.1. Every field is checked by type/shape/range -- no field is
// passed through on the assumption that "it came from our own extension so it must be well-formed".
export function validateIngestListing(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'listing must be an object' }
  const r = raw as Record<string, unknown>

  if (!isNonEmptyString(r.id)) return { ok: false, error: 'id must be a non-empty string' }
  if (!isNonEmptyString(r.url)) return { ok: false, error: 'url must be a non-empty string' }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(r.url)
  } catch {
    return { ok: false, error: 'url is not a valid URL' }
  }
  // The url is what a future dashboard will link out to -- restricting the host stops an ingest
  // payload (however it got crafted) from being used to plant an arbitrary/malicious link.
  if (!/(^|\.)ingatlan\.com$/i.test(parsedUrl.hostname)) {
    return { ok: false, error: 'url must be on the ingatlan.com domain' }
  }
  if (parsedUrl.protocol !== 'https:') return { ok: false, error: 'url must be https' }

  if (typeof r.tipus !== 'string' || !TIPUS_VALUES.includes(r.tipus as IngatlanTipus)) {
    return { ok: false, error: `tipus must be one of ${TIPUS_VALUES.join(', ')}` }
  }
  if (r.allapot !== null && !isNonEmptyString(r.allapot)) {
    return { ok: false, error: 'allapot must be a non-empty string or null' }
  }
  if (r.epitesiEv !== null && (!isFiniteNumber(r.epitesiEv) || r.epitesiEv < 1800 || r.epitesiEv > 2100)) {
    return { ok: false, error: 'epitesiEv must be null or a plausible year' }
  }
  if (r.cim !== null && !isNonEmptyString(r.cim)) {
    return { ok: false, error: 'cim must be a non-empty string or null' }
  }
  if (r.alapteruletM2 !== null && (!isFiniteNumber(r.alapteruletM2) || r.alapteruletM2 <= 0)) {
    return { ok: false, error: 'alapteruletM2 must be null or a positive number' }
  }
  if (!isFiniteNumber(r.ar) || r.ar <= 0) return { ok: false, error: 'ar must be a positive number' }
  if (!isFiniteNumber(r.nm2Ar) || r.nm2Ar <= 0) return { ok: false, error: 'nm2Ar must be a positive number' }

  return {
    ok: true,
    listing: {
      id: r.id,
      url: r.url,
      tipus: r.tipus as IngatlanTipus,
      allapot: (r.allapot as string | null) ?? null,
      epitesiEv: (r.epitesiEv as number | null) ?? null,
      cim: (r.cim as string | null) ?? null,
      alapteruletM2: (r.alapteruletM2 as number | null) ?? null,
      ar: r.ar,
      nm2Ar: r.nm2Ar,
    },
  }
}
