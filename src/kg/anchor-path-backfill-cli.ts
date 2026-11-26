// The body of scripts/kg-anchor-path-backfill.ts -- lives here so a test can drive it with its
// collaborators mocked, same reasoning as backfill-cli.ts.
import type Database from 'better-sqlite3'
import { writeFileSync, readFileSync, renameSync, fsyncSync, openSync, closeSync, existsSync } from 'node:fs'
import { openKgDb, kgDbPath } from './store.js'
import { filesForCommits, resolveFullSha } from '../kanban-relations-git.js'
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
  backupExists: (path: string) => boolean
  now: () => number
  log: (msg: string) => void
  warn: (msg: string) => void
}

export function defaultFilesForSha(sha: string): string[] {
  try {
    const full = resolveFullSha(MARVEEN_MAIN, sha)
    if (!full) return []
    return filesForCommits(MARVEEN_MAIN, [full]).get(full) ?? []
  } catch {
    return []
  }
}

/** Write + fsync + rename, not a plain writeFileSync (card 5ecf6133, CYBERSEC F-4a): a kill
 *  mid-write used to leave truncated JSON at the final path with no way to tell. The temp file
 *  lives next to the target so the rename stays on the same filesystem (atomic). */
export function atomicWriteFile(path: string, content: string): void {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`
  const fd = openSync(tmpPath, 'w')
  try {
    writeFileSync(fd, content, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, path)
}

export function defaultAnchorBackfillCliDeps(): AnchorBackfillCliDeps {
  return {
    openKgDb,
    kgDbPath,
    filesForSha: defaultFilesForSha,
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFile: atomicWriteFile,
    backupExists: existsSync,
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
      `RESTORED: ${backup.createdIds.length} created row(s) deleted, ` +
        `${backup.updatedOriginals.length} overwritten row(s) reverted, ` +
        `${backup.originals.length} original placeholder row(s) re-inserted from ${restorePath}.`,
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

  // Card 5ecf6133, CYBERSEC F-5: a second run (or a re-run after a crash) pointed at the SAME
  // --backup path used to overwrite a prior, real backup (e.g. 214 originals) with an empty one
  // from this run's own pre-mutation write -- restore then exited 0 "RESTORED: 0" while the real
  // backup was already gone. Exclusive create: refuse outright if anything already sits at this
  // path, rather than letting either write silently replace it.
  if (deps.backupExists(backupPath)) {
    deps.warn(
      `REFUSED: --backup ${backupPath} already exists -- refusing to overwrite a possibly-real prior backup. ` +
        'Pick a fresh path for this run (or --restore the existing file first if it is still needed).',
    )
    return
  }

  const result = applyAnchorPathBackfill(
    kgDb,
    plan,
    (preBackup) => {
      // Written before the transaction below mutates anything, with appliedAt EXPLICITLY null
      // (card 5ecf6133, CYBERSEC F-4a / CYBERED H-A): if the process dies after the transaction
      // commits but before the real post-commit write below, this file is what --restore would
      // read, and restoreAnchorPathBackfill refuses any backup with appliedAt=null rather than
      // silently reporting success while leaving the newly-created rows behind.
      deps.writeFile(backupPath, JSON.stringify({ ...preBackup, createdIds: [], appliedAt: null }, null, 2))
    },
    deps.now,
  )
  // Post-commit write: atomic (temp+rename via deps.writeFile), and only ever reached after the
  // mutation has actually committed -- result.backup.appliedAt is the real commit timestamp.
  deps.writeFile(backupPath, JSON.stringify(result.backup, null, 2))

  deps.log(`backfilled: ${result.backfilled} placeholder row(s) replaced`)
  deps.log(`created:    ${result.created} real-path anchor row(s)`)
  deps.log(`updated:    ${result.updated} pre-existing real-path anchor row(s) overwritten`)
  deps.log(`unresolved: ${result.unresolved} (left as placeholders)`)
  deps.log(`backup written to ${backupPath} -- restore with --restore ${backupPath}`)
}
