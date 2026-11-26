// The body of scripts/kg-anchor-path-backfill.ts -- lives here so a test can drive it with its
// collaborators mocked, same reasoning as backfill-cli.ts.
import type Database from 'better-sqlite3'
import { writeFileSync, readFileSync } from 'node:fs'
import { openKgDb, kgDbPath } from './store.js'
import { filesForCommits } from '../kanban-relations-git.js'
import {
  planAnchorPathBackfill,
  applyAnchorPathBackfill,
  restoreAnchorPathBackfill,
  type AnchorBackfillBackup,
} from './anchor-path-backfill.js'

const MARVEEN_MAIN = process.env.MARVEEN_MAIN || '/home/neon/marveen'

export const HELP_TEXT = [
  'kg-anchor-path-backfill -- replace kg_anchors.path = kanban_comments:<id> placeholders',
  'with the real repo-relative files the row\'s own Gate-SHA touched (card 5ecf6133).',
  '',
  '  --kg-db <path>   knowledge-graph database to open (default: this checkout\'s store DB)',
  '  --backup <path>  REQUIRED for a real run -- where the pre-mutation snapshot is written',
  '  --dry-run        plan only, write nothing, print counts',
  '  --restore <path> undo a previous run: read the backup file at <path> and reverse it',
  '  --help           this text',
].join('\n')

export interface AnchorBackfillCliDeps {
  openKgDb: (path: string) => Database.Database
  kgDbPath: () => string
  filesForSha: (sha: string) => readonly string[]
  readFile: (path: string) => string
  writeFile: (path: string, content: string) => void
  now: () => number
  log: (msg: string) => void
  warn: (msg: string) => void
}

export function defaultFilesForSha(sha: string): string[] {
  try {
    return filesForCommits(MARVEEN_MAIN, [sha]).get(sha) ?? []
  } catch {
    return []
  }
}

export function defaultAnchorBackfillCliDeps(): AnchorBackfillCliDeps {
  return {
    openKgDb,
    kgDbPath,
    filesForSha: defaultFilesForSha,
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFile: (path, content) => writeFileSync(path, content, 'utf8'),
    now: () => Math.floor(Date.now() / 1000),
    log: (msg) => console.log(msg),
    warn: (msg) => console.error(msg),
  }
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

export function runAnchorPathBackfillCli(argv: readonly string[], deps: AnchorBackfillCliDeps): void {
  if (argv.includes('--help') || argv.includes('-h')) {
    deps.log(HELP_TEXT)
    return
  }

  const kgDbPathArg = flagValue(argv, '--kg-db')
  const kgDb = deps.openKgDb(kgDbPathArg ?? deps.kgDbPath())

  const restorePath = flagValue(argv, '--restore')
  if (restorePath !== undefined) {
    const backup = JSON.parse(deps.readFile(restorePath)) as AnchorBackfillBackup
    restoreAnchorPathBackfill(kgDb, backup)
    deps.log(
      `RESTORED: ${backup.createdIds.length} created row(s) deleted, ${backup.originals.length} original placeholder row(s) re-inserted from ${restorePath}.`,
    )
    return
  }

  const plan = planAnchorPathBackfill(kgDb, { filesForSha: deps.filesForSha })
  const dryRun = argv.includes('--dry-run')
  deps.log(`placeholder rows found: ${plan.toBackfill.length + plan.unresolved.length}`)
  deps.log(`  resolvable (sha -> real file(s)): ${plan.toBackfill.length}`)
  deps.log(`  unresolved (sha did not resolve, left untouched): ${plan.unresolved.length}`)

  if (dryRun) {
    deps.log('DRY RUN -- nothing written. Re-run with --backup <path> to apply.')
    return
  }

  const backupPath = flagValue(argv, '--backup')
  if (backupPath === undefined) {
    deps.warn('REFUSED: a real run needs --backup <path> (tested rollback requires a backup to roll back to). Use --dry-run to plan without one.')
    return
  }

  const result = applyAnchorPathBackfill(
    kgDb,
    plan,
    (preBackup) => {
      // Written before the transaction below mutates anything; the full backup (with createdIds)
      // is re-written once more after, so the file on disk always reflects the true outcome even
      // if the process is interrupted between these two writes (the pre-mutation copy is still a
      // valid, if incomplete, restore target -- it just has no created rows to also delete yet).
      deps.writeFile(backupPath, JSON.stringify({ ...preBackup, createdIds: [] }, null, 2))
    },
    deps.now,
  )
  deps.writeFile(backupPath, JSON.stringify(result.backup, null, 2))

  deps.log(`backfilled: ${result.backfilled} placeholder row(s) replaced`)
  deps.log(`created:    ${result.created} real-path anchor row(s)`)
  deps.log(`unresolved: ${result.unresolved} (left as placeholders)`)
  deps.log(`backup written to ${backupPath} -- restore with --restore ${backupPath}`)
}
