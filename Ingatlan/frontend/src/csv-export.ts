import type { Listing } from './types.js'

const HEADER = ['Cím', 'Típus', 'Alapterület (m2)', 'Ár (Ft)', 'nm2 ár (Ft)', 'Delta ár (%)', 'Mediánsáv']

// RFC 4180: a field containing a comma, quote, or newline must be quoted, and embedded quotes are
// doubled. Without this an address like "Kossuth utca 4, fszt 2" would silently corrupt the CSV
// into an extra column instead of a garbled cell -- a real listing field, not a hypothetical.
function csvField(value: string | number): string {
  const text = String(value)
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

const MEDIAN_REL_LABEL: Record<NonNullable<Listing['median_rel']>, string> = {
  belul: 'belül',
  folott: 'fölött',
  alatt: 'alatt',
}

export function listingsToCsv(listings: Listing[]): string {
  const rows = listings.map((l) =>
    [
      csvField(l.cim ?? l.id),
      csvField(l.tipus === 'haz' ? 'ház' : 'lakás'),
      csvField(l.alapterulet_m2 ?? ''),
      csvField(l.ar),
      csvField(l.nm2_ar),
      csvField(l.delta_pct ?? ''),
      csvField(l.median_rel ? MEDIAN_REL_LABEL[l.median_rel] : ''),
    ].join(','),
  )
  return [HEADER.join(','), ...rows].join('\r\n')
}

// The only DOM-touching part -- deliberately NOT unit-tested (no jsdom in this suite, see
// format.test.ts's own precedent of testing pure logic only); covered by the real-browser check
// this card's completion report documents, same as 65e96a20's TopBar bug was.
export function downloadCsv(filename: string, csvText: string): void {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
