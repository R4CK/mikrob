/**
 * Card 1f1e3ae4: resolve every Gate-SHA already in kanban_relations into the files it touched.
 *
 *   pnpm exec tsx scripts/kanban-relations-git-sweep.ts              # dry run, writes nothing
 *   pnpm exec tsx scripts/kanban-relations-git-sweep.ts --yes        # apply
 *   pnpm exec tsx scripts/kanban-relations-git-sweep.ts --db /tmp/x.db --yes
 *
 * SWEEP ONLY, NEVER A REQUEST PATH. One measured run takes ~34 seconds, almost all of it the
 * CleanCore half on the /mnt/h drvfs mount. The module it calls is not importable from db.ts, so
 * this cannot drift into a comment write.
 *
 * DRY RUN IS THE DEFAULT: it reconciles, so it deletes as well as inserts. Same posture as
 * kanban-relations-backfill.ts and store/kanban-relations-rollback.sh.
 *
 * PASS --db, OR RUN IT FROM THE MAIN CHECKOUT -- without it the store path follows PROJECT_ROOT
 * (`__dirname/..`), so from an agent worktree this opens an empty database there and reports zero
 * shas. The report leads with the sha count for exactly that reason.
 *
 * ORDER MATTERS: this reads the `gate-sha` edges that kanban-relations-backfill.ts writes. Run that
 * one first, or this sweep has nothing to resolve.
 */
import { initDatabase, gateShaTargets, reconcileRelationSource } from '../src/db.js'
import { GIT_SOURCE, defaultRepos, gitSweepEdges } from '../src/kanban-relations-git.js'

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(
    [
      'kanban-relations-git-sweep -- resolve Gate-SHAs to the files they touched.',
      '',
      '  --yes         apply the changes (default: dry run, nothing is written)',
      '  --db <path>   database to open (default: the store DB of THIS checkout --',
      '                pass this explicitly when running from an agent worktree)',
      '  --help        this text',
      '',
      'Repos probed: marveen (this checkout) and CleanCore ($CLEANCORE_MAIN, main clone only).',
      `Only rows with source='${GIT_SOURCE}' are touched. Undo everything with:`,
      `  DELETE FROM kanban_relations WHERE source = '${GIT_SOURCE}';`,
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
const shas = gateShaTargets()
const repos = defaultRepos()
for (const r of repos) console.log(`repo:      ${r.name} -> ${r.path}`)
console.log(`gate-shas: ${shas.length} distinct`)

if (shas.length === 0) {
  // Not an error, but worth saying out loud rather than reporting a cheerful zero: it almost always
  // means the marker backfill has not run against THIS database yet (or --db points at the wrong one).
  console.log('nothing to resolve -- run scripts/kanban-relations-backfill.ts --yes first?')
  process.exit(0)
}

const { edges, byLocation } = gitSweepEdges(shas, repos)
const report = reconcileRelationSource(GIT_SOURCE, edges, { apply })

const located = Object.entries(byLocation)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k}=${v}`)
  .join(', ')
console.log(`resolved:  ${located}`)
console.log(`extracted: ${report.edges} distinct edges`)
if (report.applied) {
  console.log(`inserted:  ${report.missing}`)
  console.log(`deleted:   ${report.stale} (stale ${GIT_SOURCE} rows no longer derivable)`)
} else {
  console.log(`would insert: ${report.missing}`)
  console.log(`would delete: ${report.stale} (stale ${GIT_SOURCE} rows no longer derivable)`)
  console.log('DRY RUN -- nothing was written. Re-run with --yes to apply.')
}
