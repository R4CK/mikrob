// Connection + CRUD for the knowledge graph (MT-01/MT-13 alap, card ee9ee17b).
//
// Deliberately a SEPARATE file from store/claudeclaw.db (see the MODULTERV, section 1): a
// backfill or embedding write must never contend with the kanban/message hot path. Opened the
// same way src/channel-coordinator/ingest.ts opens its own handle onto a different file --
// own connection, own WAL assertion, own busy_timeout.
//
// Write authority (MT-13 jogosultság tábla): only the capture worker (MT-05, a later card) and
// mikrob create/mutate nodes in production. This module itself does not enforce WHO calls it --
// that is the HTTP route layer's job (F1b/F2/F3, not yet built) -- it only enforces WHAT a write
// may contain (secret-shape rejection, length bounds via the CHECK constraints already in the
// schema) and that every status change is audited.

import Database from 'better-sqlite3'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { SECRET_PATTERNS } from '../security/secret-gate.js'
import { MIGRATIONS, KG_SCHEMA_VERSION, type KgNodeType, type KgEdgeRel } from './schema.js'

export const KG_DB_FILENAME = 'knowledge-graph.db'

export class KgSecretError extends Error {
  constructor(public readonly field: string, public readonly patternName: string) {
    super(`kg write refused: ${field} matches secret pattern '${patternName}'`)
    this.name = 'KgSecretError'
  }
}

/** Reuses the SAME patterns the commit-time secret-gate scans diffs with (src/security/
 *  secret-gate.ts), so a node body is held to the same bar as a commit -- one source of truth
 *  for "what a secret shape looks like", not a second regex list that can drift from the first. */
function findSecretShape(text: string | null | undefined): string | null {
  if (!text) return null
  for (const { name, pattern } of SECRET_PATTERNS) {
    // SECRET_PATTERNS entries may carry the `g`/`y` flag from prior use elsewhere; .test() on a
    // global regex advances lastIndex, which would make a second call on the same pattern silently
    // skip matches. A fresh RegExp per call sidesteps that without touching the shared constant.
    const re = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
    if (re.test(text)) return name
  }
  return null
}

function assertNoSecretShape(fields: Record<string, string | null | undefined>): void {
  for (const [field, value] of Object.entries(fields)) {
    const hit = findSecretShape(value)
    if (hit) throw new KgSecretError(field, hit)
  }
}

export interface KgNodeInput {
  id: string
  type: KgNodeType
  project: string
  title: string
  body?: string | null
  snippet?: string | null
  snippet_lang?: string | null
  keywords?: string | null
  status?: 'draft' | 'active' | 'stale' | 'superseded' | 'archived'
  source_ref: string
  gate_sha?: string | null
  extractor: string
  embedding?: Buffer | null
  embed_model?: string | null
}

export interface KgEdgeInput {
  src: string
  dst: string
  rel: KgEdgeRel
  weight?: number
  source: string
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

export function kgDbPath(storeDir: string = STORE_DIR): string {
  return join(storeDir, KG_DB_FILENAME)
}

function currentVersion(db: Database.Database): number {
  const row = db.pragma('user_version', { simple: true }) as number
  return row
}

/** Runs every migration whose version is above the DB's current user_version, in order. A fresh
 *  file starts at user_version 0, so this also IS the initial schema creation -- there is no
 *  separate "create" path to drift from "migrate". */
export function migrate(db: Database.Database, toVersion: number = KG_SCHEMA_VERSION): void {
  const have = currentVersion(db)
  if (have >= toVersion) return
  const tx = db.transaction(() => {
    for (const m of MIGRATIONS) {
      if (m.version <= have || m.version > toVersion) continue
      for (const stmt of m.up) db.exec(stmt)
      db.pragma(`user_version = ${m.version}`)
    }
  })
  tx()
}

/** The tested rollback path (EK-MT-1): runs down-migrations in reverse version order until the
 *  DB's user_version reaches toVersion. toVersion=0 drops every kg_* table/trigger/FTS index the
 *  schema created, leaving a plain empty SQLite file -- the "rm + rebuild" recovery path (section
 *  4 of the MODULTERV) is then just migrate() again on that same emptied file, exercised by
 *  rebuild() below. */
export function migrateDown(db: Database.Database, toVersion: number = 0): void {
  const have = currentVersion(db)
  if (have <= toVersion) return
  const tx = db.transaction(() => {
    for (const m of [...MIGRATIONS].sort((a, b) => b.version - a.version)) {
      if (m.version > have || m.version <= toVersion) continue
      for (const stmt of m.down) db.exec(stmt)
      db.pragma(`user_version = ${m.version - 1}`)
    }
  })
  tx()
}

export function openKgDb(dbPath: string = kgDbPath()): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  // Concurrent-write risk flagged in the plan-grilling verdict (3f6fc4ce comment 20727): multiple
  // agents landing/closing cards at once can both touch this file. WAL lets readers proceed
  // during a writer; busy_timeout (not asserted by WAL mode itself) turns a second writer's
  // contention into a bounded wait instead of an immediate SQLITE_BUSY throw, following the same
  // pattern already proven on claudeclaw.db (src/channel-coordinator/ingest.ts).
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

/** The "teljes újraépítés" recovery path (section 4): close the handle, delete the file (and its
 *  WAL/SHM sidecars), then reopen+migrate on a clean file. Tested directly (not just described)
 *  by kg-store.test.ts, since the graph is fully derivable from source data and this IS the
 *  documented disaster-recovery procedure, not a hypothetical one. */
export function rebuild(db: Database.Database, dbPath: string): Database.Database {
  db.close()
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix
    if (existsSync(p)) unlinkSync(p)
  }
  return openKgDb(dbPath)
}

export function upsertNode(db: Database.Database, input: KgNodeInput): void {
  assertNoSecretShape({
    title: input.title,
    body: input.body,
    snippet: input.snippet,
    keywords: input.keywords,
  })
  const now = nowSec()
  db.prepare(
    `INSERT INTO kg_nodes
       (id, type, project, title, body, snippet, snippet_lang, keywords, status, source_ref,
        gate_sha, quality, extractor, embedding, embed_model, created_at, updated_at)
     VALUES (@id, @type, @project, @title, @body, @snippet, @snippet_lang, @keywords, @status,
        @source_ref, @gate_sha, 0, @extractor, @embedding, @embed_model, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, body=excluded.body, snippet=excluded.snippet,
       snippet_lang=excluded.snippet_lang, keywords=excluded.keywords, status=excluded.status,
       source_ref=excluded.source_ref, gate_sha=excluded.gate_sha, extractor=excluded.extractor,
       embedding=excluded.embedding, embed_model=excluded.embed_model, updated_at=excluded.updated_at`,
  ).run({
    id: input.id,
    type: input.type,
    project: input.project,
    title: input.title,
    body: input.body ?? null,
    snippet: input.snippet ?? null,
    snippet_lang: input.snippet_lang ?? null,
    keywords: input.keywords ?? null,
    status: input.status ?? 'active',
    source_ref: input.source_ref,
    gate_sha: input.gate_sha ?? null,
    extractor: input.extractor,
    embedding: input.embedding ?? null,
    embed_model: input.embed_model ?? null,
    created_at: now,
    updated_at: now,
  })
}

/** INSERT OR IGNORE: the composite primary key (src,dst,rel) already gives idempotency, same
 *  pattern as kanban_relations (src/db.ts writeRelationEdges) -- re-running an import is a no-op
 *  rather than a duplicate-row problem. */
export function upsertEdge(db: Database.Database, input: KgEdgeInput): number {
  const now = nowSec()
  return db.prepare(
    `INSERT OR IGNORE INTO kg_edges (src, dst, rel, weight, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.src, input.dst, input.rel, input.weight ?? 1.0, input.source, now).changes
}

/** The only sanctioned way to change a node's status (section 5 állapotgép): every transition is
 *  audited (kg_audit), which a raw `UPDATE kg_nodes SET status=...` would silently skip. */
export function setNodeStatus(
  db: Database.Database,
  nodeId: string,
  status: 'draft' | 'active' | 'stale' | 'superseded' | 'archived',
  actor: string,
): void {
  const before = db.prepare('SELECT status FROM kg_nodes WHERE id = ?').get(nodeId) as
    | { status: string }
    | undefined
  if (!before) throw new Error(`kg node not found: ${nodeId}`)
  const now = nowSec()
  const tx = db.transaction(() => {
    db.prepare('UPDATE kg_nodes SET status = ?, updated_at = ? WHERE id = ?').run(status, now, nodeId)
    db.prepare(
      'INSERT INTO kg_audit (node_id, action, actor, before, after, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(nodeId, 'status_change', actor, before.status, status, now)
  })
  tx()
}

export function getNode(db: Database.Database, id: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM kg_nodes WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
}
