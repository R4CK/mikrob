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
import { upsertAnchor, NON_DISCRIMINATING_ANCHOR_PATHS, type KgAnchorRow } from './store.js'

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
    if (!bySha.has(row.sha)) {
      // Card 5ecf6133 (CYBERSEC F-1): filter non-discriminating paths BEFORE the cap, same as the
      // forward fix -- a card that touched ONLY e.g. DECISIONS.md correctly ends up with zero
      // resolved paths and is left as an unresolved placeholder, not a stale-flagging anchor.
      const files = [...deps.filesForSha(row.sha)].filter((p) => !NON_DISCRIMINATING_ANCHOR_PATHS.has(p))
      bySha.set(row.sha, files.slice(0, MAX_FILE_ANCHORS_PER_PLACEHOLDER))
    }
    const resolvedPaths = bySha.get(row.sha)!
    if (resolvedPaths.length > 0) toBackfill.push({ placeholder: row, resolvedPaths })
    else unresolved.push(row)
  }
  return { toBackfill, unresolved }
}

export interface AnchorBackfillBackup {
  readonly takenAt: number
  readonly originals: readonly KgAnchorRow[]
  // Card 5ecf6133 (CYBERSEC LOW-b1 / CYBERED H-C): a resolved path can already carry a real anchor
  // from an earlier run (e.g. the forward fix captured it after this placeholder was created, same
  // node/repo/path/symbol). upsertAnchor then UPDATEs that row in place instead of inserting a new
  // one -- its pre-overwrite values are snapshotted here, separate from createdIds, so restore can
  // revert the overwrite instead of wrongly DELETING a row the run did not create.
  readonly updatedOriginals: readonly KgAnchorRow[]
  readonly createdIds: readonly number[]
  // Card 5ecf6133 (CYBERSEC F-4a / CYBERED H-A, non-atomic backup/restore window): null until the
  // mutating transaction has COMMITTED. restoreAnchorPathBackfill refuses a backup with appliedAt
  // still null -- a backup written before the transaction (or never updated after it, e.g. the
  // process died in that gap) must never be mistaken for a complete, restorable record.
  readonly appliedAt: number | null
}

export interface AnchorBackfillApplyResult {
  readonly backfilled: number // placeholder rows replaced
  readonly created: number // new real-path anchor rows written
  readonly updated: number // pre-existing real-path anchor rows overwritten, not newly created
  readonly unresolved: number // placeholder rows left untouched (sha didn't resolve)
  readonly backup: AnchorBackfillBackup
}

function findAnchorByKey(kgDb: Database.Database, nodeId: string, repo: string, path: string): KgAnchorRow | undefined {
  // Mirrors upsertAnchor's own lookup (store.ts): every row this module writes has symbol = NULL.
  return kgDb
    .prepare('SELECT * FROM kg_anchors WHERE node_id = ? AND repo = ? AND path = ? AND symbol IS NULL')
    .get(nodeId, repo, path) as KgAnchorRow | undefined
}

/** Applies a plan from planAnchorPathBackfill. ALWAYS calls writeBackup with the pre-mutation
 *  backup record before touching a single row -- a backfill run that could not be backed up must
 *  not run at all (the CLI enforces this by requiring --backup; this function enforces it by
 *  making writeBackup a required, synchronous step before the transaction, not best-effort after).
 *  writeBackup's own record always carries appliedAt: null (it runs before the transaction); the
 *  returned result.backup carries the real commit time, written by the CALLER only after this
 *  function returns successfully -- the two-stage write is intentional (see CLI), not a bug. */
export function applyAnchorPathBackfill(
  kgDb: Database.Database,
  plan: AnchorBackfillPlan,
  writeBackup: (backup: Omit<AnchorBackfillBackup, 'createdIds' | 'appliedAt'>) => void,
  now: () => number,
): AnchorBackfillApplyResult {
  // Bug caught testing restore against a copy of the live db before ever touching live: this used
  // to also snapshot plan.unresolved rows. Those are NEVER deleted (left alone, by design), so a
  // later restore tried to INSERT a row with an id still present in the table and hit
  // SQLITE_CONSTRAINT_PRIMARYKEY. Only toBackfill's placeholders are ever deleted, so only those
  // belong in a backup meant to undo the deletions.
  const originals = plan.toBackfill.map((i) => i.placeholder)
  // Read pass BEFORE the transaction: which resolved paths already have a real anchor that upsert
  // will overwrite, vs which will be a brand-new row. Snapshotted from the plan's own targets, not
  // a fresh table scan, so it lines up exactly with what the transaction below is about to do.
  const updatedOriginals: KgAnchorRow[] = []
  for (const item of plan.toBackfill) {
    for (const path of item.resolvedPaths) {
      const existing = findAnchorByKey(kgDb, item.placeholder.node_id, item.placeholder.repo, path)
      if (existing) updatedOriginals.push(existing)
    }
  }
  // Backup taken BEFORE the transaction, from the plan's own snapshot (not a fresh re-read) --
  // the exact rows this run is about to touch, not whatever the table holds at call time.
  writeBackup({ takenAt: now(), originals, updatedOriginals })

  const createdIds: number[] = []
  let updatedCount = 0
  // .immediate() (card 5ecf6133, MikroB msg 24849): better-sqlite3's default transaction() is
  // DEFERRED -- it only acquires the write lock on the first actual write, so a second writer that
  // already holds a read lock can block a deferred BEGIN with no timeout applying (busy_timeout
  // only governs waiting for a BUSY lock, and a deferred transaction's lock upgrade mid-transaction
  // does not go through that same wait path). BEGIN IMMEDIATE takes the write lock up front, so
  // busy_timeout actually bounds the wait for a concurrent live writer.
  kgDb.transaction((): void => {
    for (const item of plan.toBackfill) {
      for (const path of item.resolvedPaths) {
        const existing = findAnchorByKey(kgDb, item.placeholder.node_id, item.placeholder.repo, path)
        const id = upsertAnchor(kgDb, {
          node_id: item.placeholder.node_id,
          repo: item.placeholder.repo,
          path,
          sha: item.placeholder.sha,
          state: 'fresh',
        })
        if (existing) updatedCount++
        else createdIds.push(id)
      }
      kgDb.prepare('DELETE FROM kg_anchors WHERE id = ?').run(item.placeholder.id)
    }
  }).immediate()

  return {
    backfilled: plan.toBackfill.length,
    created: createdIds.length,
    updated: updatedCount,
    unresolved: plan.unresolved.length,
    backup: { takenAt: now(), originals, updatedOriginals, createdIds, appliedAt: now() },
  }
}

/** Reverses exactly one applyAnchorPathBackfill run: delete every row it created, restore every
 *  overwritten row's exact prior values, re-insert every original placeholder row by its ORIGINAL
 *  id (SQLite allows an explicit INTEGER PRIMARY KEY AUTOINCREMENT insert once the id is free,
 *  which it is -- the originals were deleted by the forward run). One transaction, so a mid-restore
 *  failure cannot leave a half-restored table. Refuses a backup whose transaction never confirmed
 *  commit (appliedAt null) -- see AnchorBackfillBackup's doc comment. */
export function restoreAnchorPathBackfill(kgDb: Database.Database, backup: AnchorBackfillBackup): void {
  if (backup.appliedAt == null) {
    throw new Error(
      'anchor-path-backfill: refusing to restore from a backup with appliedAt=null -- this backup was ' +
        'written before its mutation committed (or the process died before the commit confirmation was ' +
        'recorded), so it cannot be trusted as a complete, restorable snapshot.',
    )
  }
  kgDb.transaction((): void => {
    for (const id of backup.createdIds) {
      kgDb.prepare('DELETE FROM kg_anchors WHERE id = ?').run(id)
    }
    for (const row of backup.updatedOriginals) {
      kgDb
        .prepare(
          `UPDATE kg_anchors SET repo = ?, path = ?, symbol = ?, line_start = ?, line_end = ?, sha = ?,
             content_hash = ?, state = ?, checked_at = ? WHERE id = ?`,
        )
        .run(
          row.repo,
          row.path,
          row.symbol,
          row.line_start,
          row.line_end,
          row.sha,
          row.content_hash,
          row.state,
          row.checked_at,
          row.id,
        )
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
  }).immediate() // same busy_timeout reasoning as applyAnchorPathBackfill above
}
