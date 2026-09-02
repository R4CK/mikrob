/**
 * Card 6cd61430: the backfill / reconcile entry point for kanban_relations.
 *
 *   pnpm exec tsx scripts/kanban-relations-backfill.ts              # dry run, writes nothing
 *   pnpm exec tsx scripts/kanban-relations-backfill.ts --yes        # apply
 *   pnpm exec tsx scripts/kanban-relations-backfill.ts --db /tmp/x.db --yes
 *
 * DRY RUN IS THE DEFAULT because this tool DELETES as well as inserts (it reconciles), and the
 * fleet runs scripts straight out of card text. Same posture as store/kanban-relations-rollback.sh.
 *
 * PASS --db, OR RUN IT FROM THE MAIN CHECKOUT. Without --db the path comes from STORE_DIR, which
 * hangs off PROJECT_ROOT (= the checkout this module was LOADED from, `__dirname/..`) -- so running
 * this from an agent worktree opens (and CREATES) an empty store/claudeclaw.db there and cheerfully reports "0 cards, 0 comments". Hit
 * while building this, which is why the report leads with the scanned counts: a run against the
 * wrong database is visible in its first line rather than in its silence.
 *
 * All the work is in reconcileKanbanRelations(); this file is argv and printing. That is on
 * purpose: the live hook and this script must never be two implementations of one rule.
 */
import { initDatabase, reconcileKanbanRelations } from '../src/db.js'

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(
    [
      'kanban-relations-backfill -- reconcile the marker-derived edges in kanban_relations.',
      '',
      '  --yes         apply the changes (default: dry run, nothing is written)',
      '  --db <path>   database to open (default: the store DB of THIS checkout --',
      '                pass this explicitly when running from an agent worktree)',
      '  --help        this text',
      '',
      "Only rows with source='marker-v1' are touched. Undo everything with:",
      "  DELETE FROM kanban_relations WHERE source = 'marker-v1';",
    ].join('\n'),
  )
  process.exit(0)
}

const apply = argv.includes('--yes')
const dbFlag = argv.indexOf('--db')
const dbPath = dbFlag >= 0 ? argv[dbFlag + 1] : undefined
if (dbFlag >= 0 && !dbPath) {
  console.error('--db needs a path')
  process.exit(2)
}

initDatabase(dbPath)
const report = reconcileKanbanRelations({ apply })

console.log(`scanned:   ${report.scannedCards} cards, ${report.scannedComments} comments`)
console.log(`extracted: ${report.edges} distinct edges stated by the corpus`)
if (report.applied) {
  console.log(`inserted:  ${report.missing}`)
  console.log(`deleted:   ${report.stale} (stale marker-v1 rows the corpus no longer states)`)
} else {
  console.log(`would insert: ${report.missing}`)
  console.log(`would delete: ${report.stale} (stale marker-v1 rows the corpus no longer states)`)
  console.log('DRY RUN -- nothing was written. Re-run with --yes to apply.')
}
