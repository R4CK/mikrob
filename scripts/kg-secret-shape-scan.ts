/**
 * Card 03dff487 (Kesz-ha point 3): backfill DRY-RUN over the existing knowledge-graph.db --
 * reports how many current nodes would match each of the 5 KG-local secret/PII shapes. Never
 * mutates anything.
 *
 *   pnpm exec tsx scripts/kg-secret-shape-scan.ts
 *   pnpm exec tsx scripts/kg-secret-shape-scan.ts --kg-db /tmp/x-kg.db
 *
 * All the work is in src/kg/secret-shape-scan.ts -- it lives there, not here, so a test can
 * drive it against an in-memory DB (same reasoning as scripts/kg-backfill.ts).
 */
import { openKgDb, kgDbPath } from '../src/kg/store.js'
import { scanKgSecretShapes, formatSecretShapeScanReport } from '../src/kg/secret-shape-scan.js'

const args = process.argv.slice(2)
const kgDbArgIndex = args.indexOf('--kg-db')
const kgDbPathArg = kgDbArgIndex >= 0 ? args[kgDbArgIndex + 1] : undefined

const db = openKgDb(kgDbPathArg ?? kgDbPath())
const report = scanKgSecretShapes(db)
console.log(formatSecretShapeScanReport(report))
