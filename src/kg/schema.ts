// Schema for the knowledge graph (MT-01, card ee9ee17b), versioned so migrate()/migrateDown()
// can move the database forward and back one version at a time. Every table is append-only or
// status-transition-only at the application layer (store.ts) -- nothing here blocks a raw UPDATE,
// because SQLite CHECK constraints cannot see "this column used to be X", only the new row.
//
// Kept in its own file (not inlined in store.ts) so a migration review can diff schema shape
// without wading through connection/CRUD code -- the pattern src/db.ts already uses for
// src/schema/agent-messages-ddl.ts.

export const KG_SCHEMA_VERSION = 1

export interface Migration {
  version: number
  up: readonly string[]
  down: readonly string[]
}

const V1_UP: readonly string[] = [
  `CREATE TABLE kg_nodes (
    id            TEXT PRIMARY KEY,
    type          TEXT NOT NULL CHECK(type IN ('card','solution','anti_pattern','decision',
                    'finding','error_class','lesson','commit','file','symbol','skill')),
    project       TEXT NOT NULL,
    title         TEXT NOT NULL CHECK(length(title) <= 200),
    body          TEXT CHECK(body IS NULL OR length(body) <= 8000),
    snippet       TEXT CHECK(snippet IS NULL OR length(snippet) <= 12000),
    snippet_lang  TEXT,
    keywords      TEXT,
    status        TEXT NOT NULL DEFAULT 'active'
                    CHECK(status IN ('draft','active','stale','superseded','archived')),
    source_ref    TEXT NOT NULL,
    gate_sha      TEXT,
    quality       REAL NOT NULL DEFAULT 0,
    extractor     TEXT NOT NULL,
    embedding     BLOB,
    embed_model   TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  )`,
  `CREATE INDEX kg_nodes_type_project ON kg_nodes(type, project, status)`,
  `CREATE TABLE kg_edges (
    src        TEXT NOT NULL REFERENCES kg_nodes(id),
    dst        TEXT NOT NULL REFERENCES kg_nodes(id),
    rel        TEXT NOT NULL CHECK(rel IN ('produced','implemented_in','touches','child_of','pair_fe',
                 'pair_be','found_on','of_class','fixed_by','supersedes','governs','about',
                 'used_by','rejected_for','similar_to','depends_on')),
    weight     REAL NOT NULL DEFAULT 1.0,
    source     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (src, dst, rel)
  )`,
  `CREATE INDEX kg_edges_dst ON kg_edges(dst, rel)`,
  `CREATE TABLE kg_anchors (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id       TEXT NOT NULL REFERENCES kg_nodes(id),
    repo          TEXT NOT NULL,
    path          TEXT NOT NULL,
    symbol        TEXT,
    line_start    INTEGER,
    line_end      INTEGER,
    sha           TEXT NOT NULL,
    content_hash  TEXT,
    state         TEXT NOT NULL DEFAULT 'fresh' CHECK(state IN ('fresh','drifted','gone')),
    checked_at    INTEGER NOT NULL,
    UNIQUE(node_id, repo, path, symbol)
  )`,
  `CREATE INDEX kg_anchors_path ON kg_anchors(repo, path)`,
  // Append-only: no UPDATE/DELETE trigger needed at the DB layer for usage/audit, since nothing
  // in this card's scope ever issues one -- but the spec calls them append-only explicitly, so the
  // triggers make that a property of the schema, not an unenforced convention (same argument the
  // MODULTERV makes for kg_nodes status transitions at the application layer in store.ts).
  `CREATE TABLE kg_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    event TEXT NOT NULL CHECK(event IN ('offered','used','not_relevant','harmful')),
    created_at INTEGER NOT NULL
  )`,
  `CREATE TRIGGER kg_usage_no_update BEFORE UPDATE ON kg_usage
   BEGIN SELECT RAISE(ABORT, 'kg_usage is append-only'); END`,
  `CREATE TRIGGER kg_usage_no_delete BEFORE DELETE ON kg_usage
   BEGIN SELECT RAISE(ABORT, 'kg_usage is append-only'); END`,
  `CREATE TABLE kg_capture_queue (
    card_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL CHECK(reason IN ('closed','backfill','reopen')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','failed','skipped')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE kg_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    before TEXT,
    after TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TRIGGER kg_audit_no_update BEFORE UPDATE ON kg_audit
   BEGIN SELECT RAISE(ABORT, 'kg_audit is append-only'); END`,
  `CREATE TRIGGER kg_audit_no_delete BEFORE DELETE ON kg_audit
   BEGIN SELECT RAISE(ABORT, 'kg_audit is append-only'); END`,
  `CREATE VIRTUAL TABLE kg_nodes_fts USING fts5(
    title, body, snippet, keywords, content='kg_nodes', content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
  )`,
  // kg_nodes has a TEXT primary key, not a rowid alias, so content_rowid='rowid' tracks sqlite's
  // implicit rowid -- the triggers below must use NEW.rowid / OLD.rowid (not NEW.id) for that join
  // to stay valid after an UPDATE.
  `CREATE TRIGGER kg_nodes_fts_ai AFTER INSERT ON kg_nodes BEGIN
     INSERT INTO kg_nodes_fts(rowid, title, body, snippet, keywords)
     VALUES (new.rowid, new.title, new.body, new.snippet, new.keywords);
   END`,
  `CREATE TRIGGER kg_nodes_fts_ad AFTER DELETE ON kg_nodes BEGIN
     INSERT INTO kg_nodes_fts(kg_nodes_fts, rowid, title, body, snippet, keywords)
     VALUES ('delete', old.rowid, old.title, old.body, old.snippet, old.keywords);
   END`,
  `CREATE TRIGGER kg_nodes_fts_au AFTER UPDATE ON kg_nodes BEGIN
     INSERT INTO kg_nodes_fts(kg_nodes_fts, rowid, title, body, snippet, keywords)
     VALUES ('delete', old.rowid, old.title, old.body, old.snippet, old.keywords);
     INSERT INTO kg_nodes_fts(rowid, title, body, snippet, keywords)
     VALUES (new.rowid, new.title, new.body, new.snippet, new.keywords);
   END`,
]

// Down migration order matters: triggers/indexes before the tables they reference, FTS before
// its content table, edges/anchors (which REFERENCE kg_nodes) before kg_nodes itself.
const V1_DOWN: readonly string[] = [
  `DROP TRIGGER IF EXISTS kg_nodes_fts_au`,
  `DROP TRIGGER IF EXISTS kg_nodes_fts_ad`,
  `DROP TRIGGER IF EXISTS kg_nodes_fts_ai`,
  `DROP TABLE IF EXISTS kg_nodes_fts`,
  `DROP TRIGGER IF EXISTS kg_audit_no_delete`,
  `DROP TRIGGER IF EXISTS kg_audit_no_update`,
  `DROP TABLE IF EXISTS kg_audit`,
  `DROP TABLE IF EXISTS kg_capture_queue`,
  `DROP TRIGGER IF EXISTS kg_usage_no_delete`,
  `DROP TRIGGER IF EXISTS kg_usage_no_update`,
  `DROP TABLE IF EXISTS kg_usage`,
  `DROP INDEX IF EXISTS kg_anchors_path`,
  `DROP TABLE IF EXISTS kg_anchors`,
  `DROP INDEX IF EXISTS kg_edges_dst`,
  `DROP TABLE IF EXISTS kg_edges`,
  `DROP INDEX IF EXISTS kg_nodes_type_project`,
  `DROP TABLE IF EXISTS kg_nodes`,
]

export const MIGRATIONS: readonly Migration[] = [{ version: 1, up: V1_UP, down: V1_DOWN }]

export const KG_NODE_TYPES = [
  'card', 'solution', 'anti_pattern', 'decision', 'finding', 'error_class', 'lesson', 'commit',
  'file', 'symbol', 'skill',
] as const
export type KgNodeType = (typeof KG_NODE_TYPES)[number]

export const KG_EDGE_RELS = [
  'produced', 'implemented_in', 'touches', 'child_of', 'pair_fe', 'pair_be', 'found_on',
  'of_class', 'fixed_by', 'supersedes', 'governs', 'about', 'used_by', 'rejected_for',
  'similar_to', 'depends_on',
] as const
export type KgEdgeRel = (typeof KG_EDGE_RELS)[number]
