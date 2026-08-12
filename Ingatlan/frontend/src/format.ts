// Display-formatting helpers (card 65e96a20). The API deliberately returns raw HUF (see
// build-market-summary.ts's comment) -- this is where the "M Ft" conversion Fron Ted's design
// asks for actually happens, in exactly one place, so a unit mistake can't hide in multiple
// components independently.

export function formatMFtPerM2(hufPerM2: number | null): string {
  if (hufPerM2 === null) return '—'
  return `${(hufPerM2 / 1_000_000).toLocaleString('hu-HU', { maximumFractionDigits: 2 })} M Ft`
}

export function formatHuf(value: number): string {
  return `${Math.round(value).toLocaleString('hu-HU')} Ft`
}

export function formatPct(value: number | null): string {
  if (value === null) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toLocaleString('hu-HU', { maximumFractionDigits: 1 })}%`
}

export type FreshnessLevel = 'green' | 'yellow' | 'red' | 'unknown'

// DESIGN-IA.md section 4: "freshness dot: zöld ha < 26h, sárga 26-48h, piros > 48h".
export function freshnessLevel(isoString: string | null, now: () => number = Date.now): FreshnessLevel {
  if (!isoString) return 'unknown'
  const ageHours = (now() - new Date(isoString).getTime()) / (1000 * 60 * 60)
  if (ageHours < 26) return 'green'
  if (ageHours <= 48) return 'yellow'
  return 'red'
}
