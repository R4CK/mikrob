import type { IngatlanTipus, ScrapedListing } from './types.js'

export class NotImplementedError extends Error {}

// STUB pending unblock (see README.md "Blokkolt"): writing this for real needs either
// (a) the two actual ingatlan.com search URLs -- missing from card 61283865 and epic 6c69851f, or
// (b) ingatlan.com on store/egress-allowlist.json so a real search-results page can be fetched and
// inspected for its actual HTML/JSON shape (embedded JSON? field names? pagination?).
// Guessing at the page structure here would produce a scraper that silently returns wrong or
// empty listing data -- refusing explicitly instead of guessing.
export function parseSearchResultsHtml(_html: string, _tipus: IngatlanTipus): ScrapedListing[] {
  throw new NotImplementedError(
    'parseSearchResultsHtml: real ingatlan.com page structure not yet known -- blocked pending ' +
      'the two source URLs and/or egress-allowlist approval (see Ingatlan/README.md "Blokkolt").',
  )
}
