// Card 5ecf6133: one-time repair for the 343 kg_anchors rows capture-pipeline.ts (line 541,
// before this card's fix) wrote with `path = kanban_comments:<id>` instead of a real
// repo-relative file path -- the same placeholder the forward-fix (runCapture) no longer writes.
// A placeholder row still carries a real, useful (node_id, sha) pair; this module re-resolves the
// real files for that sha (deps.filesForSha, same port runCapture now uses) and replaces the
// placeholder with one real-path anchor per resolved file, leaving a row alone when the sha no
// longer resolves (e.g. gc'd, a non-marveen repo) rather than guessing.
//
// Tested rollback (card's own "Kész, ha"): applyAnchorPathBackfill ALWAYS writes a backup of
// every row it is about to touch, plus the ids of every row it creates, to deps.writeBackup
// BEFORE mutating anything. restoreAnchorPathBackfill reverses exactly that: delete the created
// rows, re-insert the originals by their original id. Both run inside one DB transaction each, so
// a mid-run failure leaves the table exactly as it was.

import type Database from 'better-sqlite3'
import { upsertAnchor, type KgAnchorRow } from './store.js'

export const PLACEHOLDER_PATH_RX = /^kanban_comments:\d+$/

export interface AnchorBackfillDeps {
  filesForSha: (sha: string) => readonly string[]
  now: () => number
}

export interface AnchorBackfillPlanItem {
  readonly placeholder: KgAnchorRow
  readonly resolvedPaths: readonly string[]
}

export interface AnchorBackfillPlan {
  readonly toBackfill: readonly AnchorBackfillPlanItem[]
  readonly unresolved: readonly KgAnchorRow[]
}

// Card 5ecf6133: same cap as the forward fix (capture-pipeline.ts) -- a backfill item is not
// allowed to explode into more rows than a fresh capture of the same sha would ever write.
export const MAX_FILE_ANCHORS_PER_PLACEHOLDER = 20

function listPlaceholderAnchors(kgDb: Database.Database): KgAnchorRow[] {
  return kgDb
    .prepare(`SELECT * FROM kg_anchors WHERE path LIKE 'kanban_comments:%'`)
    .all() as KgAnchorRow[]
}

/** Pure with respect to the DB write path (only reads), so a test can assert the plan without a
 *  real git checkout -- filesForSha is the only injected boundary. */
export function planAnchorPathBackfill(
  kgDb: Database.Database,
  deps: Pick<AnchorBackfillDeps, 'filesForSha'>,
): AnchorBackfillPlan {
  const rows = listPlaceholderAnchors(kgDb)
  const toBackfill: AnchorBackfillPlanItem[] = []
  const unresolved: KgAnchorRow[] = []
  // One filesForSha call per DISTINCT sha, not per row -- multiple solutions on one card share
  // the same Gate-SHA and would otherwise shell out to git once per row for nothing new.
  const bySha = new Map<string, string[]>()
  for (const row of rows) {
    if (!PLACEHOLDER_PATH_RX.test(row.path)) continue // defensive; the SQL LIKE is already exact enough in practice
    if (!bySha.has(row.sha)) bySha.set(row.sha, [...deps.filesForSha(row.sha)].slice(0, MAX_FILE_ANCHORS_PER_PLACEHOLDER))
    const resolvedPaths = bySha.get(row.sha)!
    if (resolvedPaths.length > 0) toBackfill.push({ placeholder: row, resolvedPaths })
    else unresolved.push(row)
  }
  return { toBackfill, unresolved }
}

export interface AnchorBackfillBackup {
  readonly takenAt: number
  readonly originals: readonly KgAnchorRow[]
  readonly createdIds: readonly number[]
}

export interface AnchorBackfillApplyResult {
  readonly backfilled: number // placeholder rows replaced
  readonly created: number // new real-path anchor rows written
  readonly unresolved: number // placeholder rows left untouched (sha didn't resolve)
  readonly backup: AnchorBackfillBackup
}

/** Applies a plan from planAnchorPathBackfill. ALWAYS calls writeBackup with the full backup
 *  record before touching a single row -- a backfill run that could not be backed up must not
 *  run at all (the CLI enforces this by requiring --backup; this function enforces it by making
 *  writeBackup a required, synchronous step before the transaction, not best-effort after). */
export function applyAnchorPathBackfill(
  kgDb: Database.Database,
  plan: AnchorBackfillPlan,
  writeBackup: (backup: Omit<AnchorBackfillBackup, 'createdIds'>) => void,
  now: () => number,
): AnchorBackfillApplyResult {
  // Bug caught testing restore against a copy of the live db before ever touching live: this used
  // to also snapshot plan.unresolved rows. Those are NEVER deleted (left alone, by design), so a
  // later restore tried to INSERT a row with an id still present in the table and hit
  // SQLITE_CONSTRAINT_PRIMARYKEY. Only toBackfill's placeholders are ever deleted, so only those
  // belong in a backup meant to undo the deletions.
  const originals = plan.toBackfill.map((i) => i.placeholder)
  // Backup taken BEFORE the transaction, from the plan's own snapshot (not a fresh re-read) --
  // the exact rows this run is about to touch, not whatever the table holds at call time.
  writeBackup({ takenAt: now(), originals })

  const createdIds: number[] = []
  kgDb.transaction((): void => {
    for (const item of plan.toBackfill) {
      for (const path of item.resolvedPaths) {
        const id = upsertAnchor(kgDb, {
          node_id: item.placeholder.node_id,
          repo: item.placeholder.repo,
          path,
          sha: item.placeholder.sha,
          state: 'fresh',
        })
        createdIds.push(id)
      }
      kgDb.prepare('DELETE FROM kg_anchors WHERE id = ?').run(item.placeholder.id)
    }
  })()

  return {
    backfilled: plan.toBackfill.length,
    created: createdIds.length,
    unresolved: plan.unresolved.length,
    backup: { takenAt: now(), originals, createdIds },
  }
}

/** Reverses exactly one applyAnchorPathBackfill run: delete every row it created, re-insert every
 *  original placeholder row by its ORIGINAL id (SQLite allows an explicit INTEGER PRIMARY KEY
 *  AUTOINCREMENT insert once the id is free, which it is -- the originals were deleted by the
 *  forward run). One transaction, so a mid-restore failure cannot leave a half-restored table. */
export function restoreAnchorPathBackfill(kgDb: Database.Database, backup: AnchorBackfillBackup): void {
  kgDb.transaction((): void => {
    for (const id of backup.createdIds) {
      kgDb.prepare('DELETE FROM kg_anchors WHERE id = ?').run(id)
    }
    for (const row of backup.originals) {
      kgDb
        .prepare(
          `INSERT INTO kg_anchors (id, node_id, repo, path, symbol, line_start, line_end, sha, content_hash, state, checked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.node_id,
          row.repo,
          row.path,
          row.symbol,
          row.line_start,
          row.line_end,
          row.sha,
          row.content_hash,
          row.state,
          row.checked_at,
        )
    }
  })()
}
