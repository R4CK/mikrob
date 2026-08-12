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

// CSV/formula-injection (OWASP): a cell starting with =, +, -, or @ is interpreted as a formula by
// Excel/Sheets/LibreOffice on open. Applied ONLY to `cím` -- the one column sourced from ingatlan.com
// listing text (via the browser extension, card 3f6bcc41), i.e. third-party free text, not our own
// controlled data (Cybersec finding on 917fd71, card 1f51f050). Every other column is a number or a
// value from OUR OWN fixed label set (típus/mediánsáv), so neutralizing them would just corrupt
// legitimate data -- a negative Δ ár (the common, GOOD case: price dropped) starts with "-" too, and
// an earlier version of this fix applied the guard to every column, silently turning every price-drop
// row's Δ ár into text. A leading apostrophe is the standard mitigation: spreadsheet apps treat it as
// "force text" and it is invisible in the rendered cell.
function csvTextField(value: string): string {
  const neutralized = /^[=+\-@]/.test(value) ? `'${value}` : value
  return csvField(neutralized)
}

const MEDIAN_REL_LABEL: Record<NonNullable<Listing['median_rel']>, string> = {
  belul: 'belül',
  folott: 'fölött',
  alatt: 'alatt',
}

export function listingsToCsv(listings: Listing[]): string {
  const rows = listings.map((l) =>
    [
      csvTextField(l.cim ?? l.id),
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
