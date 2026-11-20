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
import { existsSync } from 'node:fs'
import { openKgDb, kgDbPath } from '../src/kg/store.js'
import { scanKgSecretShapes, formatSecretShapeScanReport } from '../src/kg/secret-shape-scan.js'

const args = process.argv.slice(2)
const kgDbArgIndex = args.indexOf('--kg-db')
const kgDbPathArg = kgDbArgIndex >= 0 ? args[kgDbArgIndex + 1] : undefined

// Cybersec NO-GO 33019 LOW: openKgDb() creates + migrates a missing path (its own documented
// behavior for every OTHER caller), which breaks this script's read-only contract for a dry-run
// pointed at a path that does not exist yet. Fail fast instead of silently creating a DB to scan.
const targetDbPath = kgDbPathArg ?? kgDbPath()
if (!existsSync(targetDbPath)) {
  console.error(`kg-secret-shape-scan: no database at ${targetDbPath} -- this is a read-only dry-run, nothing to create.`)
  process.exit(1)
}

const db = openKgDb(targetDbPath)
const report = scanKgSecretShapes(db)
console.log(formatSecretShapeScanReport(report))
