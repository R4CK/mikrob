// Ár-eloszlás bucketing for the distribution BarChart (DESIGN-IA.md section 3.1): fixed price
// bands, ház/lakás counted separately per band. Each listing lands in the FIRST band whose upper
// bound exceeds its price, so a price at or above the highest band's floor still lands somewhere
// (no silent data loss even if a listing sits outside the 50-120M search window it was scraped
// under -- prices can drift after first sighting).
const BANDS = [
  { label: '< 50M', max: 50_000_000 },
  { label: '50-70M', max: 70_000_000 },
  { label: '70-90M', max: 90_000_000 },
  { label: '90-110M', max: 110_000_000 },
  { label: '110-120M', max: Infinity },
] as const

export interface PriceBand {
  label: string
  hazCount: number
  lakasCount: number
}

export function buildPriceDistribution(listings: Array<{ tipus: 'haz' | 'lakas'; ar: number }>): PriceBand[] {
  const result: PriceBand[] = BANDS.map((b) => ({ label: b.label, hazCount: 0, lakasCount: 0 }))
  for (const listing of listings) {
    const idx = BANDS.findIndex((b) => listing.ar < b.max)
    const bandIdx = idx === -1 ? BANDS.length - 1 : idx
    if (listing.tipus === 'haz') result[bandIdx].hazCount++
    else result[bandIdx].lakasCount++
  }
  return result
}
