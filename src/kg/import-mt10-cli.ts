// The body of scripts/kg-import-mt10.ts. Lives here, not in the script, so a test can drive
// runImportMt10Cli() with its collaborators mocked -- same reasoning as backfill-cli.ts /
// src/claude-plan-rotate-check-run.ts.
//
// Card 81593084 (MT P2 / MT-10): the four importers (import-findings.ts, import-decisions-log.ts,
// import-cold-memories.ts, import-anti-patterns.ts) were built, unit-tested and landed under this
// phase's children (63206155/bb0cadd9/76c2efb1/33e5e4ff + hardening follow-ups), but nothing ever
// called them against the live databases -- kg_nodes had zero decision/finding/error_class/lesson/
// anti_pattern rows (measured directly: `sqlite3 store/knowledge-graph.db "select type, count(*)
// from kg_nodes group by type"` returned only solution/card/commit). This script is that missing
// call: one-shot, idempotent (every importer upserts by a stable content-derived id, see each
// module's own header), safe to re-run on a schedule as DECISIONS.md/cold-memories/kanban_verdicts
// grow.
//
// Gated on KG_CAPTURE_ENABLED, same switch kg-backfill.ts (MT-06) already gates its own write
// path on -- these are both "derive graph nodes from existing data" jobs, not the KG_ENABLED
// read-side kill switch (src/web/routes/kg.ts), which only governs the query routes.
//
// LOW-1 (card 81593084 CYBERSEC GO comment 32549): atomicity is PER IMPORTER, not across the
// whole CLI run -- each importer wraps its own work in one kgDb.transaction. If a later importer
// throws, the earlier importers' writes stay committed; there is no outer transaction rolling the
// whole run back. This is safe to leave as-is rather than wrapping all four in one transaction:
// every importer's write is an idempotent upsert (re-running after a partial failure converges to
// the same state, same reasoning as the re-run-for-MEDIUM-1 case above), so a rerun after a
// mid-run throw is the recovery path, not a rollback.
import type Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { openKgDb, kgDbPath } from './store.js'
import { PROJECT_ROOT } from '../config.js'
import { mapProjectToPartition } from './project-map.js'
import { importFindings, type FindingsImportReport } from './import-findings.js'
import { importDecisionsLog, type DecisionsImportReport } from './import-decisions-log.js'
import { importColdMemories, type ColdMemoriesImportReport } from './import-cold-memories.js'
import { importAntiPatterns, type AntiPatternsImportReport } from './import-anti-patterns.js'

export function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  if (i < 0) return undefined
  const value = argv[i + 1]
  // LOW-2 (card 81593084 CYBERSEC GO comment 32549): a following flag (e.g. `--kg-db --help`)
  // must not be swallowed as this flag's value -- that previously created a file named `--help`.
  if (value === undefined || value.startsWith('--')) return undefined
  return value
}

export const HELP_TEXT = [
  'kg-import-mt10 -- import decisions/findings/lessons/anti-patterns into the knowledge graph.',
  '',
  '  --db <path>            main (kanban) database to open (default: this checkout\'s store DB)',
  '  --kg-db <path>         knowledge-graph database to open (default: this checkout\'s store DB)',
  '  --decisions-md <path>  DECISIONS.md snapshot to import (default: repo-root DECISIONS.md)',
  '  --help                 this text',
].join('\n')

export const ROOT_DECISIONS_PROJECT = 'MikroB'
export const ROOT_DECISIONS_SOURCE_PATH = 'DECISIONS.md'

export interface ImportMt10CliDeps {
  captureEnabled: () => boolean
  initDatabase: (dbPath?: string) => void
  getDb: () => Database.Database
  openKgDb: (path: string) => Database.Database
  kgDbPath: () => string
  readDecisionsMd: (path: string) => string
  importFindings: typeof importFindings
  importDecisionsLog: typeof importDecisionsLog
  importColdMemories: typeof importColdMemories
  importAntiPatterns: typeof importAntiPatterns
  log: (msg: string) => void
}

function defaultCaptureEnabled(): boolean {
  try {
    return String(getEffectiveSettingValue('KG_CAPTURE_ENABLED')) === '1'
  } catch {
    return false
  }
}

export function defaultImportMt10CliDeps(): ImportMt10CliDeps {
  return {
    captureEnabled: defaultCaptureEnabled,
    initDatabase,
    getDb,
    openKgDb,
    kgDbPath,
    readDecisionsMd: (path) => readFileSync(path, 'utf-8'),
    importFindings,
    importDecisionsLog,
    importColdMemories,
    importAntiPatterns,
    log: (msg) => console.log(msg),
  }
}

export interface ImportMt10Report {
  findings: FindingsImportReport
  decisions: DecisionsImportReport
  coldMemories: ColdMemoriesImportReport
  antiPatterns: AntiPatternsImportReport
}

/** Runs all four MT-10 importers once against the given handles. Exported so a test can assert
 *  the combined report without going through the CLI argv/switch plumbing. */
export function runImportMt10(
  mainDb: Database.Database,
  kgDb: Database.Database,
  decisionsMarkdown: string,
  decisionsProject: string,
  sourcePath: string,
  deps: Pick<
    ImportMt10CliDeps,
    'importFindings' | 'importDecisionsLog' | 'importColdMemories' | 'importAntiPatterns'
  >,
): ImportMt10Report {
  // antiPatterns BEFORE coldMemories: cold-memories' about-edges target `card:<id>` nodes that
  // only antiPatterns creates among these four importers (MEDIUM-1, card 81593084 CYBERSEC GO
  // comment 32549) -- running cold-memories first meant the first run skipped those edges
  // (card-node not yet there) and only the second run (re-run, idempotent upsert) picked them up.
  const antiPatterns = deps.importAntiPatterns(mainDb, kgDb, decisionsMarkdown, decisionsProject, sourcePath)
  return {
    findings: deps.importFindings(mainDb, kgDb),
    decisions: deps.importDecisionsLog(decisionsMarkdown, mainDb, kgDb, decisionsProject, sourcePath),
    coldMemories: deps.importColdMemories(mainDb, kgDb),
    antiPatterns,
  }
}

export function runImportMt10Cli(argv: readonly string[], deps: ImportMt10CliDeps): void {
  if (argv.includes('--help') || argv.includes('-h')) {
    deps.log(HELP_TEXT)
    return
  }

  if (!deps.captureEnabled()) {
    deps.log('SKIPPED -- KG_CAPTURE_ENABLED off. Nothing read or written.')
    return
  }

  const dbPath = flagValue(argv, '--db')
  const kgDbPathArg = flagValue(argv, '--kg-db')
  const decisionsMdArg = flagValue(argv, '--decisions-md')

  deps.initDatabase(dbPath)
  const mainDb = deps.getDb()
  const kgDb = deps.openKgDb(kgDbPathArg ?? deps.kgDbPath())

  const decisionsMdPath = decisionsMdArg ?? join(PROJECT_ROOT, ROOT_DECISIONS_SOURCE_PATH)
  const decisionsMarkdown = deps.readDecisionsMd(decisionsMdPath)
  const decisionsProject = mapProjectToPartition(ROOT_DECISIONS_PROJECT)

  const report = runImportMt10(mainDb, kgDb, decisionsMarkdown, decisionsProject, ROOT_DECISIONS_SOURCE_PATH, deps)

  deps.log(
    `findings:      verdicts=${report.findings.verdictsSeen} upserted=${report.findings.findingsUpserted} classEdges=${report.findings.classEdges} unclassified=${report.findings.unclassifiedCount}`,
  )
  deps.log(
    `decisions:     entries=${report.decisions.entriesParsed} upserted=${report.decisions.decisionsUpserted} governsEdges=${report.decisions.governsEdges} secretSkipped=${report.decisions.entriesRejectedSecret}`,
  )
  deps.log(
    `coldMemories:  scanned=${report.coldMemories.memoriesScanned} upserted=${report.coldMemories.lessonsUpserted} aboutEdges=${report.coldMemories.aboutEdges} secretSkipped=${report.coldMemories.rowsRejectedSecret}`,
  )
  deps.log(
    `antiPatterns:  comments=${report.antiPatterns.commentsScanned}+decisions=${report.antiPatterns.decisionsScanned} upserted=${report.antiPatterns.commentAntiPatternsUpserted + report.antiPatterns.decisionAntiPatternsUpserted} rejectedForEdges=${report.antiPatterns.rejectedForEdges} secretSkipped=${report.antiPatterns.rowsRejectedSecret}`,
  )
}
