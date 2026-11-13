// The body of scripts/kg-backfill.ts. It lives here, not in the script, so a test can drive
// runBackfillCli() with its collaborators mocked (kg-backfill-cli.test.ts) -- same reasoning as
// src/claude-plan-rotate-check-run.ts: the script itself only calls it, and a top-level script
// cannot be imported and re-run per test case.
//
// RedHat delta re-gate (comment 23081, GO on 6eb41295) left three non-blocking items for THIS
// file specifically, all addressed here:
//   1. item 2: the CLI switch/--limit wiring and the real defaultCaptureEnabled had no shipped
//      test -- only backfill.ts's injected-deps tests did. kg-backfill-cli.test.ts now drives
//      the real wiring (mocked DB/IO collaborators) and a direct unit test covers
//      defaultCaptureEnabled's own fail-closed branches.
//   2. item 3 (E10): the CLI used to open both databases BEFORE checking the switch, so a
//      disabled capture still created/migrated the kg database file. The switch check now runs
//      first, before initDatabase/openKgDb.
//   3. item 4 (E8/B5): a hand-edited config-overrides.json or an out-of-range .env value for
//      KG_BACKFILL_BATCH was never clamped (only the --limit CLI flag was, since the delta fix
//      for X2). resolveLimit() now validates the CONFIGURED default the same way, before an
//      explicit --limit can override it.
import type Database from 'better-sqlite3'
import { initDatabase, getDb } from '../db.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { getSettingDefinition, validateSettingValue, type SettingDefinition } from '../config-registry.js'
import { openKgDb, kgDbPath } from './store.js'
import { runCapture, defaultDeps as defaultCaptureDeps, type CaptureDeps } from './capture-pipeline.js'
import {
  runBackfillBatch,
  defaultListCandidates,
  defaultListPendingCandidates,
  defaultGpuGate,
  defaultCaptureEnabled,
} from './backfill.js'
import { recordWorkerHeartbeat } from './worker-heartbeat.js'

export function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

export const HELP_TEXT = [
  "kg-backfill -- feed existing done cards into the knowledge graph, one batch at a time.",
  '',
  '  --limit <n>    cards to process this run (default: the KG_BACKFILL_BATCH setting)',
  "  --db <path>    main (kanban) database to open (default: this checkout's store DB)",
  "  --kg-db <path> knowledge-graph database to open (default: this checkout's store DB)",
  '  --help         this text',
].join('\n')

/** Validates the CONFIGURED default first (a hand-edited override or an out-of-range .env value
 *  is clamped, not trusted), then an explicit --limit on top of that, through the SAME registry
 *  validator both times. Either failure path falls back to the last known-good value, never to
 *  the raw unvalidated input -- so an invalid --limit falls back to the validated configured
 *  default, not to a potentially-invalid one. Pure: no DB, no IO, easy to test exhaustively. */
export function resolveLimit(
  batchDef: SettingDefinition | undefined,
  configuredDefault: string | number,
  limitArg: string | undefined,
  warn: (msg: string) => void,
): number {
  if (!batchDef) return typeof configuredDefault === 'number' ? configuredDefault : Number(configuredDefault)

  let limit = Number(batchDef.default)
  const validatedConfigured = validateSettingValue(batchDef, configuredDefault)
  if (validatedConfigured.ok && typeof validatedConfigured.value === 'number') {
    limit = validatedConfigured.value
  } else {
    warn(
      `kg-backfill: configured KG_BACKFILL_BATCH "${configuredDefault}" invalid (${validatedConfigured.error ?? 'nem ertelmezheto'}) -- a registry alapertelmezes (${batchDef.default}) megy.`,
    )
  }

  if (limitArg !== undefined) {
    const validatedArg = validateSettingValue(batchDef, limitArg)
    if (validatedArg.ok && typeof validatedArg.value === 'number') {
      limit = validatedArg.value
    } else {
      warn(
        `kg-backfill: --limit "${limitArg}" invalid (${validatedArg.error ?? 'nem ertelmezheto'}) -- ${limit} megy (a configured/registry alapertelmezes).`,
      )
    }
  }

  return limit
}

export interface BackfillCliDeps {
  captureEnabled: () => boolean
  getEffectiveSettingValue: (key: string) => string | number
  getSettingDefinition: (key: string) => SettingDefinition | undefined
  initDatabase: (dbPath?: string) => void
  getDb: () => Database.Database
  openKgDb: (path: string) => Database.Database
  kgDbPath: () => string
  runBackfillBatch: typeof runBackfillBatch
  listCandidates: (mainDb: Database.Database, kgDb: Database.Database, limit: number) => readonly string[]
  listPendingCandidates: (kgDb: Database.Database, limit: number) => readonly string[]
  recordHeartbeat: (kgDb: Database.Database, now: number) => void
  gpuGate: typeof defaultGpuGate
  runCapture: typeof runCapture
  captureDeps: () => CaptureDeps
  now: () => number
  log: (msg: string) => void
  warn: (msg: string) => void
}

/** One combined candidate source for the batch loop: already-enqueued rows (any reason -- this
 *  is the drain the live hook's queue never had a reader for) FIRST, then whatever budget remains
 *  goes to discovering 'done' cards never queued at all (the original backfill-only behaviour).
 *  A pure function over its deps so the pending-first/fill-remainder combination is unit-testable
 *  without a real database (see kg-backfill-cli.test.ts). */
export function buildListCandidates(
  deps: Pick<BackfillCliDeps, 'listPendingCandidates' | 'listCandidates'>,
  mainDb: Database.Database,
  kgDb: Database.Database,
): (limit: number) => readonly string[] {
  return (limit: number): readonly string[] => {
    const pending = deps.listPendingCandidates(kgDb, limit)
    if (pending.length >= limit) return pending
    const discovered = deps.listCandidates(mainDb, kgDb, limit - pending.length)
    return [...pending, ...discovered]
  }
}

export function defaultBackfillCliDeps(): BackfillCliDeps {
  return {
    captureEnabled: defaultCaptureEnabled,
    getEffectiveSettingValue,
    getSettingDefinition,
    initDatabase,
    getDb,
    openKgDb,
    kgDbPath,
    runBackfillBatch,
    listCandidates: defaultListCandidates,
    listPendingCandidates: defaultListPendingCandidates,
    recordHeartbeat: recordWorkerHeartbeat,
    gpuGate: defaultGpuGate,
    runCapture,
    captureDeps: defaultCaptureDeps,
    now: () => Math.floor(Date.now() / 1000),
    log: (msg) => console.log(msg),
    warn: (msg) => console.error(msg),
  }
}

/** Entry point for scripts/kg-backfill.ts. The switch is checked FIRST, before either database
 *  is opened (RedHat 23081 item 3) -- a disabled capture must not even create/migrate the kg
 *  database file. */
export function runBackfillCli(argv: readonly string[], deps: BackfillCliDeps): void {
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
  const limitArg = flagValue(argv, '--limit')

  deps.initDatabase(dbPath)
  const mainDb = deps.getDb()
  const kgDb = deps.openKgDb(kgDbPathArg ?? deps.kgDbPath())

  // Stamp liveness BEFORE processing anything, including a zero-candidate run -- the point is to
  // prove the worker ran at all (card 1388200c: the UI had no way to tell "running" from "never
  // existed"), not to report an exact count.
  deps.recordHeartbeat(kgDb, deps.now())

  const batchDef = deps.getSettingDefinition('KG_BACKFILL_BATCH')
  const limit = resolveLimit(batchDef, deps.getEffectiveSettingValue('KG_BACKFILL_BATCH'), limitArg, deps.warn)

  const maxSolutions = Number(deps.getEffectiveSettingValue('KG_MAX_SOLUTIONS_PER_CARD'))
  const captureDeps = deps.captureDeps()

  const report = deps.runBackfillBatch(kgDb, limit, {
    captureEnabled: deps.captureEnabled,
    listCandidates: buildListCandidates(deps, mainDb, kgDb),
    gpuGate: deps.gpuGate,
    runOne: (cardId) => deps.runCapture(mainDb, kgDb, cardId, maxSolutions, captureDeps),
    now: deps.now,
  })

  if (report.captureDisabled) {
    // Unreachable from this CLI (we already returned above) -- kept as defense-in-depth output
    // for the one other caller of runBackfillBatch (its own test file) that injects a deps
    // object directly.
    deps.log('SKIPPED -- KG_CAPTURE_ENABLED off. Nothing read or written.')
    return
  }

  deps.log(`candidates:  ${report.candidates} (oldest-first, not yet in kg_capture_queue)`)
  deps.log(`processed:   ${report.processed}`)
  deps.log(`  active:    ${report.active}`)
  deps.log(`  draft:     ${report.draft}`)
  deps.log(`  failed:    ${report.failed}`)
  deps.log(`  skipped:   ${report.skipped}`)
  deps.log(`elapsed:     ${report.elapsedSec}s`)
  if (report.haltedOnGpuHold) {
    deps.log('HALTED: GPU gate on HOLD -- stopped before another local-LLM call. Re-run later for the rest.')
  }
}
