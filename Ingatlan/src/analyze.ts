// CLI entry point for the analysis layer (card 12e508c4, 2/4). Reads whatever is currently in
// the DB (empty until the 1/4 scraper is unblocked -- see README.md "Blokkolt") and prints the
// grouped market report. The 3/4 webapp card will import analyzeMarket()/query.ts directly
// rather than shelling out to this script; this is for manual/ad-hoc inspection.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from './db.js'
import { getLatestSnapshots, getPriceHistoryPoints } from './query.js'
import { analyzeMarket, type GroupReport } from './analysis/report.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(HERE, '..', 'data', 'ingatlan.db')

function formatGroup(name: string, group: GroupReport): string {
  if (!group.stats) return `${name}: nincs adat`
  const s = group.stats
  const forecast =
    group.forecast?.status === 'ok'
      ? `előrejelzés (+${group.forecast.forecastDaysAhead} nap): ${Math.round(group.forecast.forecastNm2Ar).toLocaleString('hu-HU')} Ft/m2`
      : `előrejelzés: nincs elég historikus adat (${group.forecast?.daysOfHistory ?? 0}/${group.forecast?.minDaysRequired ?? '?'} nap)`
  return (
    `${name}: ${s.count} hirdetés, átlag ${Math.round(s.avgNm2Ar).toLocaleString('hu-HU')} Ft/m2, ` +
    `medián ${Math.round(s.medianNm2Ar).toLocaleString('hu-HU')} Ft/m2 (min ${Math.round(s.minNm2Ar).toLocaleString('hu-HU')}, ` +
    `max ${Math.round(s.maxNm2Ar).toLocaleString('hu-HU')}), ${group.withinBand.length} hirdetés a median +-5%-os sávban. ${forecast}`
  )
}

function main(): void {
  const db = openDb(DB_PATH)
  try {
    const snapshots = getLatestSnapshots(db)
    const pricePoints = getPriceHistoryPoints(db)
    const report = analyzeMarket(snapshots, pricePoints)
    console.log(formatGroup('Ház', report.haz))
    console.log(formatGroup('Lakás', report.lakas))
    console.log(formatGroup('Összevont', report.combined))
  } finally {
    db.close()
  }
}

main()
