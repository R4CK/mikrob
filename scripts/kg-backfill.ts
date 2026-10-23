/**
 * Card 7c9be2d8 (MT F6 / MT-06): backfill existing 'done' kanban cards into the knowledge graph.
 *
 *   pnpm exec tsx scripts/kg-backfill.ts                   # one batch, size = KG_BACKFILL_BATCH
 *   pnpm exec tsx scripts/kg-backfill.ts --limit 100        # calibration pass (MODULTERV section 0)
 *   pnpm exec tsx scripts/kg-backfill.ts --db /tmp/x.db --kg-db /tmp/x-kg.db
 *
 * PASS --db/--kg-db, OR RUN IT FROM THE MAIN CHECKOUT -- same trap as kanban-relations-backfill.ts:
 * without --db the main DB path comes from STORE_DIR of THIS checkout.
 *
 * Processes ONE batch per invocation (up to the limit) and stops. Run it again for the rest --
 * repeated invocation is the "kötegelve" (batched) half of the card; capture is local-LLM-only
 * (MODULTERV section 5) and never falls back online when the GPU gate holds, so a run that
 * reports haltedOnGpuHold just needs retrying later, not a different model.
 *
 * All the work is in runBackfillBatch(); this file is argv, wiring and printing.
 */
import { initDatabase, getDb } from '../src/db.js'
import { getEffectiveSettingValue } from '../src/settings-store.js'
import { openKgDb, kgDbPath } from '../src/kg/store.js'
import { runCapture, defaultDeps as defaultCaptureDeps } from '../src/kg/capture-pipeline.js'
import { runBackfillBatch, defaultListCandidates, defaultGpuGate } from '../src/kg/backfill.js'

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(
    [
      'kg-backfill -- feed existing done cards into the knowledge graph, one batch at a time.',
      '',
      '  --limit <n>    cards to process this run (default: the KG_BACKFILL_BATCH setting)',
      '  --db <path>    main (kanban) database to open (default: this checkout\'s store DB)',
      '  --kg-db <path> knowledge-graph database to open (default: this checkout\'s store DB)',
      '  --help         this text',
    ].join('\n'),
  )
  process.exit(0)
}

function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const dbPath = flagValue('--db')
const kgDbPathArg = flagValue('--kg-db')
const limitArg = flagValue('--limit')

initDatabase(dbPath)
const mainDb = getDb()
const kgDb = openKgDb(kgDbPathArg ?? kgDbPath())

const limit = limitArg ? Number(limitArg) : Number(getEffectiveSettingValue('KG_BACKFILL_BATCH'))
const maxSolutions = Number(getEffectiveSettingValue('KG_MAX_SOLUTIONS_PER_CARD'))
const captureDeps = defaultCaptureDeps()

const report = runBackfillBatch(kgDb, limit, {
  listCandidates: (n) => defaultListCandidates(mainDb, kgDb, n),
  gpuGate: defaultGpuGate,
  runOne: (cardId) => runCapture(mainDb, kgDb, cardId, maxSolutions, captureDeps),
  now: () => Math.floor(Date.now() / 1000),
})

console.log(`candidates:  ${report.candidates} (oldest-first, not yet in kg_capture_queue)`)
console.log(`processed:   ${report.processed}`)
console.log(`  active:    ${report.active}`)
console.log(`  draft:     ${report.draft}`)
console.log(`  failed:    ${report.failed}`)
console.log(`  skipped:   ${report.skipped}`)
console.log(`elapsed:     ${report.elapsedSec}s`)
if (report.haltedOnGpuHold) {
  console.log('HALTED: GPU gate on HOLD -- stopped before another local-LLM call. Re-run later for the rest.')
}
