export type IngatlanTipus = 'haz' | 'lakas'

// A single sighting of a listing from one scrape pass -- what a search-results
// page parse produces per listing, before it's reconciled against the DB.
export interface ScrapedListing {
  id: string
  url: string
  tipus: IngatlanTipus
  allapot: string | null
  epitesiEv: number | null
  cim: string | null
  alapteruletM2: number | null
  ar: number
  nm2Ar: number
}
