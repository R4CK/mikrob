import Database from 'better-sqlite3'
import { isForceActor } from './kanban-force-actors.js'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, chmodSync, openSync, closeSync, statSync } from 'node:fs'
import { STORE_DIR, DB_FILENAME, ALLOWED_CHAT_ID, OLLAMA_URL, APP_TZ } from './config.js'
import { getEffectiveSettingValue } from './settings-store.js'
import { logger } from './logger.js'
import { TOOL_TIMEOUTS } from './tool-timeouts.js'
import { AGENT_MESSAGES_DDL, AGENT_MESSAGES_ALTER_COLUMNS } from './schema/agent-messages-ddl.js'
import {
  MARKER_SOURCE,
  NODE_CARD,
  NODE_FILE,
  NODE_SHA,
  REL_GATE_SHA,
  REL_TOUCHES_FILE,
  parseQualifiedPath,
  cardEdges,
  commentEdges,
  dedupeEdges,
  edgeKey,
  type RelationEdge,
  type RelationSourceCard,
} from './kanban-relations.js'

let db: Database.Database
// The path the CURRENT handle was opened on (null for ':memory:'). Kept so
// size reporting measures the database actually being served, not a
// re-derived default path that an override would silently diverge from.
let openedDbPath: string | null = null

// Lock the DB file and its sidecars (WAL, SHM, rollback journal) down to
// owner-only. better-sqlite3 opens the main file with the process umask
// (typically 0o644), which leaves a TOCTOU window where any other local
// process -- malicious npm postinstall, rogue shell script, unrelated
// tool running under the operator's UID -- can open() it for read BEFORE
// we narrow the mode. The narrowed chmod would not revoke an already-
// opened fd. Defense in depth:
//   (1) Pre-create the main DB file via openSync('wx', 0o600) so better-
//       sqlite3 inherits the tight mode on fresh installs and the race
//       window is closed entirely.
//   (2) After Database() + PRAGMA wal, chmod the sidecars (WAL/SHM/
//       journal) -- they were created during the pragma call at umask.
//       This path also fixes older installs whose files sit at 0o644.
function tightenDbPermissions(dbPath: string): void {
  const sidecars = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]
  for (const path of sidecars) {
    if (!existsSync(path)) continue
    try { chmodSync(path, 0o600) } catch (err) {
      logger.warn({ err, path }, 'Failed to tighten DB file permissions')
    }
  }
}

// dbPathOverride is for tests: pass ':memory:' (or a temp file path) to open an
// isolated database instead of the real store/claudeclaw.db. ':memory:' has no
// path to chmod, so the file-precreate (openSync 'wx') and tightenDbPermissions
// steps are skipped for it. A real on-disk override path (e.g. a /tmp temp file)
// STILL gets pre-create + tighten -- this lets the permission tests exercise the
// tightening logic on a throwaway file instead of touching the prod DB. The
// STORE_DIR mkdir stays prod-only; a temp-file override owns its own directory.
export function initDatabase(dbPathOverride?: string): void {
  const useOverride = dbPathOverride !== undefined
  const isMemory = dbPathOverride === ':memory:'
  if (!useOverride) mkdirSync(STORE_DIR, { recursive: true })
  // Idempotent re-init: close a previous handle before opening a new one
  // so repeated calls (tests, hot-reload, recovery paths) do not leak
  // the old better-sqlite3 fd.
  if (db) {
    try { db.close() } catch { /* already closed */ }
  }
  const dbPath = useOverride ? dbPathOverride! : join(STORE_DIR, DB_FILENAME)
  // Step 1: close the TOCTOU window on fresh installs. openSync with 'wx'
  // + 0o600 creates the file ONLY if it doesn't exist and sets the strict
  // mode atomically. better-sqlite3 then opens the existing file rather
  // than creating one at the default umask. Skipped only for ':memory:'.
  if (!isMemory && !existsSync(dbPath)) {
    try {
      closeSync(openSync(dbPath, 'wx', 0o600))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      // EEXIST: a concurrent startup won the race and created it. The
      // tightenDbPermissions call below will correct its mode.
      if (code !== 'EEXIST') {
        logger.warn({ err, dbPath }, 'Pre-create of DB file failed, continuing; mode will be tightened post-open')
      }
    }
  }
  db = new Database(dbPath)
  openedDbPath = isMemory ? null : dbPath
  db.pragma('journal_mode = WAL')
  // Performance pragmas: safe with WAL, applied after journal_mode is set.
  // cache_size: negative value = kibibytes; -65536 → 64 MB page cache.
  // mmap_size: memory-mapped I/O in bytes; 256 MB. Skipped for :memory: (no file to map).
  // synchronous = NORMAL: safe under WAL (only full-fsync skipped, not the WAL checkpoint).
  db.pragma('cache_size = -65536')
  if (!isMemory) db.pragma('mmap_size = 268435456')
  db.pragma('synchronous = NORMAL')
  if (!isMemory) tightenDbPermissions(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0
    )
  `)

  // Migráció: message_count oszlop hozzáadása meglévő DB-hez
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0')
  } catch {
    // már létezik, rendben
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      topic_key TEXT,
      content TEXT NOT NULL,
      sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
      salience REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    )
  `)

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content='memories',
      content_rowid='id'
    )
  `)

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
    END
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      next_run INTEGER NOT NULL,
      last_run INTEGER,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status_next ON scheduled_tasks(status, next_run)`)

  // --- Local-LLM work queue (card defcc189) ---
  //
  // WHY A QUEUE. Local-LLM offload is currently SYNCHRONOUS and ONE-SHOT: an agent blocks 15-70s
  // waiting for the 7B, and a card only gets a local draft at the dispatch instant. Measured over
  // 740 calls, 87% were that single dispatch shot. Blocking is what caps the volume -- every call
  // costs the agent time it could spend on its own online work, so agents avoid making them.
  //
  // The queue makes offload ASYNC and REPEATABLE: any source (dispatch, an agent mid-task, MikroB's
  // periodic reconciliation) inserts a row and returns immediately; a single worker drains it behind
  // the existing GPU flock. `status` is the whole state machine, and `started_at`/`finished_at`
  // bound each phase so a crashed worker's rows are recoverable (see reclaimStaleRunning).
  //
  // ADDITIVE ONLY: the synchronous local-llm.sh / local-llm-rag.sh paths keep working unchanged.
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_llm_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      card_id TEXT,
      task_type TEXT,
      template TEXT,
      prompt TEXT NOT NULL,
      context TEXT,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed','escalated')),
      source TEXT NOT NULL DEFAULT 'agent',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      result TEXT,
      error TEXT
    )
  `)
  // The worker's hot query is "oldest pending, highest priority first"; the status+created_at index
  // serves both that and the per-status dashboard counts.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_llmq_status_created ON local_llm_queue(status, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_llmq_agent ON local_llm_queue(agent, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_llmq_card ON local_llm_queue(card_id)`)
  // Migration: add 'escalated' to local_llm_queue's status CHECK constraint (card 03fca184). SQLite
  // can't ALTER a CHECK constraint, so recreate the table when the current schema doesn't yet
  // include it -- same pattern as the kanban_cards 'testing'-status migration above. Idempotent on
  // fresh DBs (CREATE TABLE above already includes 'escalated' for those).
  try {
    const llmqSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='local_llm_queue'").get() as { sql: string } | undefined
    if (llmqSchema?.sql && !llmqSchema.sql.includes("'escalated'")) {
      db.exec(`
        CREATE TABLE local_llm_queue_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent TEXT NOT NULL,
          card_id TEXT,
          task_type TEXT,
          template TEXT,
          prompt TEXT NOT NULL,
          context TEXT,
          priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed','escalated')),
          source TEXT NOT NULL DEFAULT 'agent',
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER,
          result TEXT,
          error TEXT
        );
        INSERT INTO local_llm_queue_new
          SELECT id, agent, card_id, task_type, template, prompt, context, priority, status,
                 source, attempts, created_at, started_at, finished_at, result, error
          FROM local_llm_queue;
        DROP TABLE local_llm_queue;
        ALTER TABLE local_llm_queue_new RENAME TO local_llm_queue;
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_llmq_status_created ON local_llm_queue(status, created_at)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_llmq_agent ON local_llm_queue(agent, created_at)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_llmq_card ON local_llm_queue(card_id)`)
    }
  } catch (err) {
    logger.warn({ err }, 'local_llm_queue escalated-status migration failed -- continuing')
  }

  // --- Kanban ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_cards (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','testing','waiting','done')),
      assignee TEXT,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
      project TEXT,
      due_date INTEGER,
      sort_order REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    )
  `)
  // Migration: add project column to kanban_cards for installs created
  // before #89 (whose CREATE TABLE IF NOT EXISTS ran without `project`
  // and is a no-op on the next boot). Without this, createKanbanCard
  // and updateKanbanCard fail with `table kanban_cards has no column
  // named project` and no card can be saved.
  try {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN project TEXT')
  } catch {
    // column already exists
  }
  try {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN parent_id TEXT REFERENCES kanban_cards(id)')
  } catch {
    // column already exists
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_kanban_parent ON kanban_cards(parent_id)')
  // Migration: add dispatched_at to kanban_cards (kanban -> agent dispatch
  // once-only guard). Older installs created the table without it.
  try {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN dispatched_at INTEGER')
  } catch {
    // column already exists
  }
  // Migration: add 'testing' status to kanban_cards CHECK constraint.
  // SQLite can't ALTER a CHECK constraint, so we recreate the table when the
  // current schema doesn't yet include 'testing'. Idempotent on fresh DBs.
  try {
    const kcSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='kanban_cards'").get() as { sql: string } | undefined
    if (kcSchema?.sql && !kcSchema.sql.includes("'testing'")) {
      db.exec(`
        CREATE TABLE kanban_cards_new (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','testing','waiting','done')),
          assignee TEXT,
          priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
          project TEXT,
          due_date INTEGER,
          sort_order REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived_at INTEGER,
          parent_id TEXT REFERENCES kanban_cards_new(id),
          dispatched_at INTEGER
        );
        INSERT INTO kanban_cards_new
          SELECT id, title, description, status, assignee, priority, project, due_date,
                 sort_order, created_at, updated_at, archived_at, parent_id, dispatched_at
          FROM kanban_cards;
        DROP TABLE kanban_cards;
        ALTER TABLE kanban_cards_new RENAME TO kanban_cards;
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_kanban_parent ON kanban_cards(parent_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_kanban_status ON kanban_cards(status, archived_at)`)
    }
  } catch (err) {
    logger.warn({ err }, 'kanban_cards testing-status migration failed -- continuing')
  }
  // Migration: add agent_id, category, auto_generated columns to memories
  try {
    db.exec("ALTER TABLE memories ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'marveen'")
  } catch {
    // column already exists
  }
  try {
    db.exec("ALTER TABLE memories ADD COLUMN category TEXT NOT NULL DEFAULT 'general' CHECK(category IN ('user_pref','project','feedback','learning','shared','general'))")
  } catch {
    // column already exists
  }
  try {
    db.exec('ALTER TABLE memories ADD COLUMN auto_generated INTEGER NOT NULL DEFAULT 0')
  } catch {
    // column already exists
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, category)`)

  // --- Conversation-continuity ledger (deterministic; P0 2026-06-02) ---
  // A durable ROLLING TRANSCRIPT of every channel turn -- inbound user messages
  // AND outbound replies -- per agent_id + chat_id. On a respawn (a fresh
  // --channels session with no memory of the live conversation) the SessionStart
  // replay hook injects the last ~20 turns of context PLUS highlights the open
  // question (the most recent inbound with no later outbound), so the fresh
  // session continues exactly where the connection dropped -- ZERO agent
  // discretion. Generic across all three channel agents (marveen/dia/erno-ba);
  // agent_id is derived from the session cwd so each session only sees its own
  // chat. Written by the settings.json hooks (UserPromptSubmit capture +
  // PostToolUse outbound). UNIQUE(...) makes inbound capture idempotent; outbound
  // rows carry message_id=NULL so they are never deduped against each other.
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('in','out')),
      message_id TEXT,
      text TEXT,
      ts TEXT,
      created_at INTEGER NOT NULL,
      attachment_kind TEXT,
      attachment_file_id TEXT,
      UNIQUE(agent_id, chat_id, direction, message_id)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_convlog_agent ON conversation_log(agent_id, created_at)`)
  // Migration for pre-existing DBs: transcript-less voice/video_note inbounds
  // keep their attachment identity so a respawned session can still download
  // and transcribe them (mirrors _MIGRATION_COLUMNS in scripts/hooks/ledger_lib.py).
  for (const col of ['attachment_kind', 'attachment_file_id']) {
    const cols = db.prepare("PRAGMA table_info(conversation_log)").all() as { name: string }[]
    if (!cols.some(c => c.name === col)) {
      db.exec(`ALTER TABLE conversation_log ADD COLUMN ${col} TEXT`)
    }
  }

  // Migration: hot/warm/cold/shared tier system with an enforced CHECK.
  // Rebuilds the table whenever its current schema doesn't include the
  // canonical CHECK -- covers both the legacy ('user_pref'...) and the
  // post-refactor-no-check states, and is idempotent on fresh DBs.
  try {
    const current = db.prepare("SELECT sql FROM sqlite_master WHERE name='memories'").get() as { sql: string } | undefined
    const hasCanonicalCheck = !!current?.sql?.match(/CHECK\s*\(\s*category\s+IN\s*\(\s*'hot'\s*,\s*'warm'\s*,\s*'cold'\s*,\s*'shared'\s*\)\s*\)/i)
    if (current?.sql && !hasCanonicalCheck) {
      // Preserve keywords if the column exists; older DBs rebuilt this table
      // before the keywords ADD COLUMN ran, so NULL out in that case.
      const cols = db.prepare("PRAGMA table_info(memories)").all() as { name: string }[]
      const keywordsExpr = cols.some(c => c.name === 'keywords') ? 'keywords' : 'NULL'
      db.exec(`
        CREATE TABLE memories_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT NOT NULL,
          topic_key TEXT,
          content TEXT NOT NULL,
          sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
          salience REAL NOT NULL DEFAULT 1.0,
          created_at INTEGER NOT NULL,
          accessed_at INTEGER NOT NULL,
          agent_id TEXT NOT NULL DEFAULT 'marveen',
          category TEXT NOT NULL DEFAULT 'warm' CHECK(category IN ('hot','warm','cold','shared')),
          auto_generated INTEGER NOT NULL DEFAULT 0,
          keywords TEXT
        );
        INSERT INTO memories_new SELECT id, chat_id, topic_key, content, sector, salience, created_at, accessed_at, agent_id,
          CASE category
            WHEN 'hot' THEN 'hot'
            WHEN 'warm' THEN 'warm'
            WHEN 'cold' THEN 'cold'
            WHEN 'shared' THEN 'shared'
            WHEN 'user_pref' THEN 'warm'
            WHEN 'project' THEN 'warm'
            WHEN 'general' THEN 'warm'
            WHEN 'feedback' THEN 'cold'
            WHEN 'learning' THEN 'cold'
            ELSE 'warm'
          END,
          auto_generated,
          ${keywordsExpr}
        FROM memories;
        DROP TABLE memories;
        ALTER TABLE memories_new RENAME TO memories;
      `)
      // Recreate FTS and triggers for new schema (now includes keywords)
      db.exec(`DROP TABLE IF EXISTS memories_fts`)
      db.exec(`CREATE VIRTUAL TABLE memories_fts USING fts5(content, keywords, content='memories', content_rowid='id')`)
      db.exec(`DROP TRIGGER IF EXISTS memories_ai`)
      db.exec(`DROP TRIGGER IF EXISTS memories_ad`)
      db.exec(`DROP TRIGGER IF EXISTS memories_au`)
      db.exec(`CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords); END`)
      db.exec(`CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES('delete', old.id, old.content, old.keywords); END`)
      db.exec(`CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES('delete', old.id, old.content, old.keywords); INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords); END`)
      db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, category)`)
    }
  } catch (err) {
    // Previously this silently swallowed every error which masked the
    // CHECK-constraint drop that Bug #2 described. Log loudly instead so
    // a broken migration is obvious in the dashboard log.
    const msg = err instanceof Error ? err.message : String(err)
    if (!/already exists/i.test(msg)) {
      console.error('[db] memories migration failed:', msg)
    }
  }

  // If the table already has the new schema but no keywords column (edge case)
  try {
    db.exec('ALTER TABLE memories ADD COLUMN keywords TEXT')
  } catch {
    // column already exists
  }

  // Migration: embedding column for vector search
  try {
    db.exec('ALTER TABLE memories ADD COLUMN embedding TEXT')
  } catch {
    // column already exists
  }

  // Daily logs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      date TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_daily_logs_date ON daily_logs(agent_id, date)`)

  db.exec(`CREATE INDEX IF NOT EXISTS idx_kanban_status ON kanban_cards(status, archived_at)`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_kanban_comments_card ON kanban_comments(card_id)`)

  // Line-level (diff) comments (card 906c130f, vibe-kanban idea 227f4cc1): today's gate
  // verdicts/REVIEWs only live as free-text kanban_comments rows, with no link to a specific
  // file+line in a specific commit's diff. This table adds that binding; adatmodel+API only here,
  // rendering is the paired Fron Ted card's (c12abc67) job.
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_line_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL,
      sha TEXT NOT NULL,
      file TEXT NOT NULL,
      line INTEGER NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_kanban_line_comments_card_sha ON kanban_line_comments(card_id, sha)`)

  // Status-change audit trail: one row per real status transition so the board
  // can answer "who moved this card, when, from/to status". Written by
  // moveKanbanCard only when the status actually changes.
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_card_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor TEXT,
      created_at INTEGER NOT NULL,
      forced INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_kanban_events_card ON kanban_card_events(card_id, created_at)`)

  // --- Non-status field changes (card 51878c59) --------------------------------------------
  //
  // kanban_card_events above records STATUS transitions and nothing else, so every other edit was
  // traceless: no actor, no timestamp. That is not a cosmetic gap. The fleet keeps its PROGRESS
  // marker in the card TITLE ([NN%], working rule 2), so the field that says how far along a piece
  // of work is had no audit at all -- measured on card 8d673233, where a [50%] appeared, the board
  // showed progress nobody had made, and afterwards NOBODY could say who wrote it.
  //
  // A SEPARATE TABLE, deliberately, rather than more rows in kanban_card_events. That table's rows
  // mean "a status transition happened": `to_status` is NOT NULL, GET /api/kanban/:id/events hands
  // them out as a transition list, and fleet-transfer dedups them on (card_id, created_at,
  // to_status). A row carrying an unchanged status would be indistinguishable from a real move for
  // every one of those readers. Keeping the two apart costs one table and breaks nothing.
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_card_field_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      actor TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_kanban_field_events_card ON kanban_card_field_events(card_id, created_at)`)

  // --- Pending self-advance /clear (card 5003f37e) ------------------------------------------
  //
  // The auto-dispatch path (card 900178fa) /clears an agent's pane BEFORE delivering a new task
  // message, checked live because the caller (MikroB/the API) and the target (the dispatched agent)
  // are different processes -- the target's pane really can be idle right then. Self-advance has no
  // such gap: the agent that just moved its OWN card to in_progress IS the pane in question, and it
  // is, by construction, busy at that exact moment (it just issued the call). A synchronous idle-wait
  // there would almost always time out. So self-advance only RECORDS that a clear is owed; a separate
  // watcher (self-advance-clear-watcher.ts), running as an independent process, delivers it the next
  // time it observes that agent's pane genuinely idle -- the same live-idle-check the auto-dispatch
  // path relies on, just from a vantage point where it can actually be true.
  //
  // One row per agent (PRIMARY KEY): a second genuine switch before the first clear lands just
  // overwrites card_id/set_at -- the outstanding debt is still "one clear", not "one per switch".
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_pending_clear (
      agent_id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      set_at INTEGER NOT NULL
    )
  `)

  // --- Card dependencies: predecessor / successor edges (card 2bb82943) --------------------
  //
  // A DIRECTED edge that is deliberately SEPARATE from parent_id. parent_id is containment (a
  // phase owns its tasks); this is ordering (this card cannot proceed until that one is done).
  // The two answer different questions and a card can have both, so they must not share a column.
  //
  //   from_card_id = the card that is BLOCKED
  //   to_card_id   = its PREDECESSOR, the card that must finish first
  //
  // A "successor" is the same row read from the other end -- one edge, two views, so there is no
  // second table to keep in sync and no way for the two directions to disagree.
  //
  // THE FOREIGN KEYS ARE ENFORCED FOR THE APP, AND NOT FOR EVERY WRITER -- correcting my own
  // earlier claim here (card 37c5605a, Cybered F-2). I first wrote that they were documentation
  // only, on a `PRAGMA foreign_keys` -> 0 reading taken with PYTHON's sqlite3 client, which
  // defaults to OFF. better-sqlite3 -- the client this application actually uses -- defaults to
  // ON: measured 1 both in-process and on the live file. So through the app these REFERENCES do
  // bite, and a card DELETE would FAIL rather than orphan an edge if nothing cleared it first.
  //
  // That is exactly why deleteKanbanCard removes these rows inside its own transaction BEFORE
  // deleting the card, in both directions. It is not belt-and-braces: with FKs on it is what
  // makes the delete possible at all.
  //
  // The reason a dangling row is still worth defending against: this fleet's agents write to the
  // database DIRECTLY with the sqlite3 CLI and python, both of which default FKs OFF -- the same
  // habit that made the timestamp-integrity triggers below necessary. A row inserted that way can
  // point at a card that does not exist, so the read path must not treat it as absent.
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_dependencies (
      from_card_id TEXT NOT NULL REFERENCES kanban_cards(id),
      to_card_id   TEXT NOT NULL REFERENCES kanban_cards(id),
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (from_card_id, to_card_id),
      CHECK (from_card_id <> to_card_id)
    )
  `)
  // The PRIMARY KEY already indexes (from_card_id, to_card_id) -- that covers "what blocks me".
  // The reverse question ("what am I blocking") has no index without this one, and the status
  // guard asks it on every close.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_kanban_deps_to ON kanban_dependencies(to_card_id)`)

  // --- Typed relation graph (card 9d7a247a, Fazis fe3eff9f) -----------------
  // A POLYMORPHIC edge table: "this card touched that file", "this decision belongs to that card",
  // "this card was gated at that sha". The fleet already writes these facts as structured text in
  // card comments (Gate-SHA:, Pair-FE:/Pair-BE:, parent_id), so the backfill (card 6cd61430) can
  // extract them -- no new tagging burden on the building agents.
  //
  // NO `REFERENCES` ON EITHER SIDE, deliberately, and it is not a relaxation. `to_id` may be a file
  // path or a commit sha, which cannot reference kanban_cards(id); a foreign key that only holds
  // for some rows is not a foreign key. The same posture the kanban_dependencies comment above
  // takes therefore applies here with no escape hatch: a reader must treat a dangling id as a
  // dangling id, not as "absent". deleteKanbanCard sweeps the card-side rows for that reason --
  // for data hygiene, since there is no FK to force it.
  //
  // `blocks` IS EXCLUDED, and that is the load-bearing constraint of the table. Blocking already
  // has kanban_dependencies, which the card-close guard reads on EVERY close. A `blocks` row
  // written here would be invisible to that guard: it would look like a blocker and block nothing.
  // It is a denial of ONE value rather than an allow-list, so the extraction pass can introduce a
  // new relation_type without a schema change -- only the real collision is closed.
  //
  // BY TRIGGER, NOT BY CHECK, and the difference is not stylistic: `INSERT OR IGNORE` -- the form
  // that makes the backfill re-runnable, two paragraphs down -- SILENTLY SKIPS a row that violates
  // a CHECK. Measured, not assumed: a CHECK-guarded insert of 'blocks' under OR IGNORE exits 0 and
  // writes nothing, while a trigger's RAISE(ABORT) still aborts (sqlite 19). A CHECK here would
  // therefore have told the backfill author that a blocks edge had been recorded. Same reasoning,
  // same mechanism as the epoch guards below (card a06314ea). The other constraints stay declared
  // (NOT NULL, PRIMARY KEY) because under OR IGNORE they mean exactly what the caller wants -- skip
  // this row -- and the caller can see it in the returned `changes` count.
  //
  // The PRIMARY KEY is what makes the backfill RE-RUNNABLE: with INSERT OR IGNORE, running it twice
  // is a no-op instead of doubling every row. Putting that guarantee in the schema rather than in
  // the script means "the backfill does not duplicate" stops depending on the script's discipline.
  // `source` (e.g. 'backfill-v1' / 'live' / 'manual') is the other half of that: a bad extraction is
  // undone with DELETE WHERE source = ..., surgically, without dropping the table.
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_relations (
      from_type     TEXT NOT NULL,
      from_id       TEXT NOT NULL,
      to_type       TEXT NOT NULL,
      to_id         TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      source        TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (from_type, from_id, to_type, to_id, relation_type)
    )
  `)
  // The PRIMARY KEY indexes the from-side prefix, which answers "what does card X touch". The
  // query endpoint's OTHER question -- "which cards touched file Y" -- reads the to-side, and has
  // no index without this one.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_kanban_relations_to ON kanban_relations(to_type, to_id, relation_type)`,
  )
  // Both directions of the denial: an UPDATE could otherwise land a 'blocks' edge that the INSERT
  // guard refused, by writing an allowed type first and renaming it after.
  for (const when of ['INSERT', 'UPDATE OF relation_type'] as const) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_kanban_relations_no_blocks_${when.split(' ')[0]!.toLowerCase()}
      BEFORE ${when} ON kanban_relations
      WHEN NEW.relation_type = 'blocks'
      BEGIN
        SELECT RAISE(ABORT, 'kanban_relations does not carry "blocks" -- blocking edges live in kanban_dependencies, which the card-close guard reads');
      END;
    `)
  }

  // --- Timestamp integrity (card a06314ea) ---------------------------------
  // Every timestamp in this schema is a UNIX EPOCH INTEGER, and every reader assumes it: the
  // stuck-card monitor and the re-dispatch guard both do epoch arithmetic. A row written with a
  // "2026-07-31 14:53:49" TEXT value does not fail anywhere -- it silently poisons those
  // calculations, which is how it was found.
  //
  // The API never writes text (db.ts uses Math.floor(Date.now()/1000) throughout). The rows that
  // went wrong came from agents writing DIRECTLY into SQLite with datetime('now') or a Python ISO
  // string, so a TypeScript-side fix could not have caught them. A TRIGGER can: it fires for the
  // sqlite3 CLI exactly as it does for the app, and it fails LOUDLY with the correct form in the
  // message instead of letting a bad value land.
  //
  // Repair first (the trigger would otherwise reject an UPDATE touching an already-bad row).
  db.exec(`
    UPDATE kanban_cards SET created_at = CAST(strftime('%s', created_at) AS INTEGER)
     WHERE typeof(created_at) <> 'integer' AND strftime('%s', created_at) IS NOT NULL;
    UPDATE kanban_cards SET updated_at = CAST(strftime('%s', updated_at) AS INTEGER)
     WHERE typeof(updated_at) <> 'integer' AND strftime('%s', updated_at) IS NOT NULL;
    UPDATE kanban_comments SET created_at = CAST(strftime('%s', created_at) AS INTEGER)
     WHERE typeof(created_at) <> 'integer' AND strftime('%s', created_at) IS NOT NULL;
  `)
  for (const [table, column] of [
    ['kanban_cards', 'created_at'],
    ['kanban_cards', 'updated_at'],
    ['kanban_comments', 'created_at'],
    // Card 9d7a247a: the new relation table joins the same guard. It needs no entry in the repair
    // UPDATE above -- it is created empty in this same function, so it has no legacy rows to fix.
    ['kanban_relations', 'created_at'],
  ] as const) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${table}_${column}_epoch_insert
      BEFORE INSERT ON ${table}
      WHEN typeof(NEW.${column}) <> 'integer'
      BEGIN
        SELECT RAISE(ABORT, '${table}.${column} must be a unix epoch INTEGER (use unixepoch(), not datetime()/an ISO string)');
      END;
    `)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${table}_${column}_epoch_update
      BEFORE UPDATE OF ${column} ON ${table}
      WHEN typeof(NEW.${column}) <> 'integer'
      BEGIN
        SELECT RAISE(ABORT, '${table}.${column} must be a unix epoch INTEGER (use unixepoch(), not datetime()/an ISO string)');
      END;
    `)
  }
  // Migration (card c4f2de32, Cybered follow-up): mark the transitions that only happened because a
  // caller passed `force`. Without it a forced re-open is indistinguishable afterwards from a
  // regular one -- and the whole point of the guard is that re-opening reviewed work leaves a trace.
  try {
    db.exec('ALTER TABLE kanban_card_events ADD COLUMN forced INTEGER NOT NULL DEFAULT 0')
  } catch {
    // column already exists
  }

  // listKanbanCards()'s auto-archive sweep (below) treats a card's updated_at
  // as "when did this card last change", and archives a done card once that
  // timestamp is older than KANBAN_ARCHIVE_DONE_DAYS. Both production status
  // writers (updateKanbanCard, moveKanbanCard) always bump updated_at in the
  // same statement as the status change -- but a raw SQL UPDATE that only
  // touches status (kanban 0664aadf: an ad hoc status fix) leaves the OLD
  // updated_at in place, so a card that just became 'done' looks like it has
  // been sitting untouched for weeks and gets archived on the very next page
  // load, before anyone sees it. Self-healing rather than a CHECK constraint,
  // same reasoning as agent_messages_delivered_needs_ts above: the point is
  // to keep updated_at honest for any writer, not to police the write path.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS kanban_cards_status_bumps_updated_at
    AFTER UPDATE OF status ON kanban_cards
    FOR EACH ROW WHEN NEW.status != OLD.status AND NEW.updated_at = OLD.updated_at
    BEGIN
      UPDATE kanban_cards SET updated_at = CAST(strftime('%s','now') AS INTEGER) WHERE id = NEW.id;
    END
  `)

  // KANBANCTXDEAD824 follow-up: paragraph-length card titles cost tokens in
  // every agent that reads the board, and the 2026-08-24 sweep moved ~1.3 MB
  // of accreted title text into comments by hand. These triggers automate that
  // exact transformation for future writes so the debt cannot re-accumulate.
  //
  // Deliberately NOT a CHECK constraint: agents write this table with raw
  // sqlite3 and rarely inspect exit codes, so a rejected INSERT would lose the
  // card silently -- worse than any long title. Self-healing instead, same
  // philosophy as kanban_cards_status_bumps_updated_at above: the full
  // original title is preserved as a comment on the same card (marked so the
  // reader knows a trigger wrote it), then the title is cut to fit.
  //
  // The truncated title is substr(...,1,299) || '…' = 300 chars, deliberately
  // NOT > 300: even with PRAGMA recursive_triggers=ON the re-fired WHEN
  // clause is false, so the trigger cannot loop. Existing long titles are
  // untouched (AFTER INSERT / AFTER UPDATE only) -- the 2026-08-24 sweep
  // already migrated the backlog, and re-running it is explicitly out of
  // scope here.
  //
  // The `OF title` restriction and the NEW.title != OLD.title guard are
  // deliberately REDUNDANT and both load-bearing: either alone keeps a plain
  // status flip from silently truncating one of the remaining legacy
  // long-titled cards. A regression pin covers the behavior (a non-title
  // UPDATE leaves a legacy long title byte-identical) and fails only when
  // BOTH are removed -- kanban-title-gate-trigger.test.ts.
  //
  // Second-order effect for writers: a strict write-readback comparing the
  // just-written title against the stored row sees a mismatch above 300
  // chars -- the trigger rewrote it. That divergence is the trigger WORKING,
  // not a lost write; readbacks must compare against the truncated form (or
  // look for the trigger comment) instead of raw equality.
  const titleGateBody = `
    BEGIN
      INSERT INTO kanban_comments (card_id, author, content, created_at)
      VALUES (
        NEW.id,
        'cim-kapu (trigger)',
        '[CIM-KAPU TRIGGER] A kartyara ' || length(NEW.title)
          || ' karakteres cim erkezett; a 300 feletti cimeket a tabla-olvasok'
          || ' token-koltsege miatt a trigger levagja (KANBANCTXDEAD824).'
          || ' A teljes eredeti cim valtozatlanul:' || char(10) || char(10)
          || NEW.title,
        CAST(strftime('%s','now') AS INTEGER)
      );
      UPDATE kanban_cards SET title = substr(NEW.title, 1, 299) || '…' WHERE id = NEW.id;
    END
  `
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS kanban_cards_title_gate_insert
    AFTER INSERT ON kanban_cards
    FOR EACH ROW WHEN length(NEW.title) > 300
    ${titleGateBody}
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS kanban_cards_title_gate_update
    AFTER UPDATE OF title ON kanban_cards
    FOR EACH ROW WHEN NEW.title != OLD.title AND length(NEW.title) > 300
    ${titleGateBody}
  `)

  // --- Kanban labels (tags) -----------------------------------------------
  // Labels are a separate registry (not hardcoded per-card strings) so the
  // same label can be reused across many cards and recolored in one place.
  // The colour itself is validated against the configured palette
  // (KANBAN_LABEL_COLORS) at the route layer, not hardcoded here.
  db.exec(`
    CREATE TABLE IF NOT EXISTS labels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_card_labels (
      card_id TEXT NOT NULL,
      label_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (card_id, label_id)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_card_labels_label ON kanban_card_labels(label_id)`)

  // --- Agent Messages ---
  // DDL lives in src/schema/agent-messages-ddl.ts, shared with the channel-coordinator's own
  // defensive CREATE TABLE (src/channel-coordinator/ingest.ts) -- see that module's comment for
  // why (card 26ad5302: the two copies drifted silently before this).
  // origin_note (card 06f062e4): the bus has no sender authentication -- from_agent is
  // self-declared and every sub-agent spawned under a parent shares that
  // parent's from_agent string, invisibly to the parent session and its
  // siblings (the 2026-07-12 self-fill-sweep incident's root cause: a
  // uat sub-session's message was indistinguishable from any other uat
  // session's, producing an unpinnable ~15-message contradictory dispute).
  // This does NOT add authentication (that needs per-agent bus credentials,
  // a bigger cross-fleet rollout, tracked separately) -- it's the cheap
  // half: an OPTIONAL, caller-supplied free-text tag a sub-agent can set to
  // distinguish itself from siblings sharing its parent identity, carried
  // through to delivery so a human/agent reading the message has SOMETHING
  // to go on. Self-declared, so it's an attributability aid, not a trust
  // boundary -- do not treat a present origin_note as proof of anything.
  // trace_id/span_id/parent_span_id (card def5a189): distributed trace context propagated by
  // message-router middleware. trace_id is the root trace identifier spanning an entire agent
  // chain (e.g. morning-chain); span_id is this message's own span identifier (nanoid);
  // parent_span_id is the sender's span_id, linking child back to parent in the waterfall.
  for (const stmt of AGENT_MESSAGES_DDL) db.exec(stmt)
  for (const stmt of AGENT_MESSAGES_ALTER_COLUMNS) {
    try {
      db.exec(stmt)
    } catch {
      // column already exists
    }
  }

  // INVARIANT: a row that says 'delivered' must carry a delivered_at.
  //
  // On 2026-07-27 an operator bulk-closed a 28-row backlog with raw SQL that
  // set status without a timestamp. Nothing broke loudly -- but the queue,
  // which is the only signal we have for "what actually went out", started
  // claiming that messages had been delivered when they never left. It took an
  // hour of log archaeology to work out which of them the recipients had
  // genuinely received and which they had only read out of band, and the answer
  // was recoverable that day purely by luck.
  //
  // Enforced with a trigger rather than a CHECK constraint because SQLite
  // cannot add a CHECK to an existing table without rebuilding it, and this is
  // not worth a rebuild of the message log. Self-healing rather than ABORT:
  // aborting would turn a bookkeeping slip into a failed operation for the
  // caller, and the point is to keep the RECORD honest, not to police writers.
  // The row gets a timestamp AND -- if nothing else explains it -- a marker
  // saying it was closed without ever being delivered, so the distinction
  // survives in the data instead of in someone's memory.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS agent_messages_delivered_needs_ts
    AFTER UPDATE OF status ON agent_messages
    FOR EACH ROW WHEN NEW.status = 'delivered' AND NEW.delivered_at IS NULL
    BEGIN
      UPDATE agent_messages
         SET delivered_at = CAST(strftime('%s','now') AS INTEGER),
             result = COALESCE(result, 'closed-without-delivery')
       WHERE id = NEW.id;
    END
  `)

  // One-time L1 backfill: federation system ids are now stored lowercase, but
  // rows written by a pre-L1 build (an install that federated with a
  // display-cased id like "Teodor/agent") keep their old case. Left alone,
  // thread grouping and conversation history key on the exact string and
  // silently SPLIT such a peer into two threads once new lowercase rows
  // arrive. Fold the SYSTEM prefix of qualified rows in place (the agent
  // segment keeps its case -- it is the peer's namespace). Idempotent: an
  // already-lowercase prefix compares equal and is skipped, so this is a
  // safe no-op after the first run and on fresh installs.
  db.exec(`
    UPDATE agent_messages
       SET from_agent = lower(substr(from_agent, 1, instr(from_agent, '/') - 1)) || substr(from_agent, instr(from_agent, '/'))
     WHERE instr(from_agent, '/') > 0
       AND substr(from_agent, 1, instr(from_agent, '/') - 1) <> lower(substr(from_agent, 1, instr(from_agent, '/') - 1))
  `)
  db.exec(`
    UPDATE agent_messages
       SET to_agent = lower(substr(to_agent, 1, instr(to_agent, '/') - 1)) || substr(to_agent, instr(to_agent, '/'))
     WHERE instr(to_agent, '/') > 0
       AND substr(to_agent, 1, instr(to_agent, '/') - 1) <> lower(substr(to_agent, 1, instr(to_agent, '/') - 1))
  `)

  // --- Pending Channel Requests (Slack channel opt-in workflow) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_channel_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT,
      user_id TEXT,
      requested_at INTEGER NOT NULL,
      resolved_at INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied'))
    )
  `)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pcr_agent_channel ON pending_channel_requests(agent, channel_id) WHERE status = 'pending'`)
  try { db.exec('ALTER TABLE pending_channel_requests ADD COLUMN resolved_at INTEGER') } catch { /* already exists */ }

  // --- Task Run History ---
  // Log every scheduled-task firing so the dashboard overview's "tasksToday"
  // survives dashboard restarts. Replaces the old store/task-run-history.json
  // which had a plain read-modify-write race under concurrent/restart.
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      agent TEXT NOT NULL,
      ts INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_runs_ts ON task_runs(ts)`)
  // Migration: add status column to task_runs (introduced 2026-06-13)
  try { db.exec(`ALTER TABLE task_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'fired'`) } catch { /* already present */ }

  // --- Pending Scheduled Task Retries ---
  // Busy-skipped scheduled tasks used to live in an in-memory Map. On a
  // dashboard restart (or crash), the queue was lost -- even though the
  // operator had asked for the task to run, it silently disappeared.
  // This table persists each busy-retry across restarts so nothing is
  // dropped. When a row crosses the alert threshold, the alerting layer
  // stamps alert_sent_at before each Telegram send and clears it on
  // delivery failure, yielding at-least-once delivery with no double-
  // alerting on concurrent ticks. The scheduler itself never abandons:
  // it keeps retrying until the session frees up or the operator
  // cancels from the UI.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_task_retries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_name TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      first_attempt INTEGER NOT NULL,
      last_attempt INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      last_reason TEXT,
      alert_sent_at INTEGER,
      UNIQUE(task_name, agent_name)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_retries_first_attempt ON pending_task_retries(first_attempt)`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS background_tasks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','failed','timeout')),
      tmux_session TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      output TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bg_tasks_agent ON background_tasks(agent_id, status)`)

  // --- Token Usage Monitoring ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      thinking_tokens INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      content_preview TEXT,
      tool_name TEXT,
      task_title TEXT,
      project TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_ts ON token_usage(timestamp)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_agent_ts ON token_usage(agent, timestamp)`)
  // Migrations for columns added after initial release
  try { db.exec('ALTER TABLE token_usage ADD COLUMN thinking_tokens INTEGER NOT NULL DEFAULT 0') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE token_usage ADD COLUMN model TEXT') } catch { /* already exists */ }

  // Deduplicate existing rows before creating unique index
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_dedup ON token_usage(agent, session_id, timestamp, input_tokens, output_tokens)`)
  } catch {
    db.exec(`
      DELETE FROM token_usage WHERE id NOT IN (
        SELECT MIN(id) FROM token_usage
        GROUP BY agent, session_id, timestamp, input_tokens, output_tokens
      )
    `)
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_dedup ON token_usage(agent, session_id, timestamp, input_tokens, output_tokens)`)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage_cursors (
      file_path TEXT PRIMARY KEY,
      last_line INTEGER NOT NULL DEFAULT 0,
      last_size INTEGER NOT NULL DEFAULT 0
    )
  `)

  // --- Idea Box ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS idea_box (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL DEFAULT 'Egyéb',
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewed','kanban','rejected')),
      source TEXT NOT NULL DEFAULT 'marveen',
      kanban_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_idea_box_status ON idea_box(status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_idea_box_category ON idea_box(category)`)
  // impact/effort scoring -- added after initial release; safe ALTER on existing DBs
  try { db.exec('ALTER TABLE idea_box ADD COLUMN impact INTEGER') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE idea_box ADD COLUMN effort INTEGER') } catch { /* already exists */ }

  // --- Idea Comments ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS idea_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idea_id TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_idea_comments_idea ON idea_comments(idea_id)`)

  // --- Idea Status Log ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS idea_status_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idea_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'system',
      note TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_idea_status_log_idea ON idea_status_log(idea_id, created_at)`)

  // --- Tool Call Log (auto-recorder) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_call_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input_summary TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_log_session ON tool_call_log(session_id, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_log_ts ON tool_call_log(created_at)`)
  // Idempotent column additions -- guard with PRAGMA so second run does not error.
  const toolLogCols = (db.prepare('PRAGMA table_info(tool_call_log)').all() as { name: string }[]).map(r => r.name)
  if (!toolLogCols.includes('agent_id'))    db.exec('ALTER TABLE tool_call_log ADD COLUMN agent_id TEXT')
  if (!toolLogCols.includes('trace_id'))    db.exec('ALTER TABLE tool_call_log ADD COLUMN trace_id TEXT')
  if (!toolLogCols.includes('duration_ms')) db.exec('ALTER TABLE tool_call_log ADD COLUMN duration_ms INTEGER')

  // --- Skill Usage Log (persistent, no prune -- feeds dream-engine skill health) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('tool_call', 'skill_read')),
      session_id TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_skill_usage_agent ON skill_usage(agent_id, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_skill_usage_skill ON skill_usage(skill_name, created_at)`)

  // --- Config Change Log (audit trail for /api/settings writes) ---
  // Background-only: no UI surfaces this table yet (product decision). For
  // secret settings, callers must pass null for old_value/new_value -- this
  // table only ever holds plaintext for non-secret registry entries.
  db.exec(`
    CREATE TABLE IF NOT EXISTS config_change_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      actor TEXT NOT NULL DEFAULT 'unknown',
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_config_change_log_key ON config_change_log(key, created_at)`)

  // --- Store File Audit (fs-watch events on store/) ---
  // Records every write/rename in the store/ directory. Content is NEVER
  // stored -- only path, event type and file size. Sensitive files
  // (.dashboard-token, vault.json, .vault-key) are flagged so the UI can
  // render them without leaking values.
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_file_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rel_path TEXT NOT NULL,
      event_type TEXT NOT NULL,
      is_sensitive INTEGER NOT NULL DEFAULT 0,
      file_size INTEGER,
      agent TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_store_file_audit_ts ON store_file_audit(created_at)`)
  // Migration: add agent column to installs that created the table before this column existed.
  try { db.exec(`ALTER TABLE store_file_audit ADD COLUMN agent TEXT`) } catch { /* column already exists */ }

  // --- CostOps (local cost ledger) ---
  // Read-mostly, FOCUS-inspired. cost_sources = provider/subscription origin,
  // cost_line_items = individual charge rows (estimate or provider-sourced).
  // No secrets/account IDs stored raw. Budgets are config-driven (costops/config.ts's
  // BudgetEntry, from store/costops-config.json) -- there is deliberately no separate
  // `budgets` DB table: an earlier draft of this schema had one, but it was never
  // read from or written to (config.budgets was always the actual source), so it was
  // a dead, unused second source of truth. Removed rather than wired up, since the
  // config file already covers this fully and a DB table would just be a sync burden
  // for no benefit.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      source_type TEXT NOT NULL,
      account_ref TEXT,
      currency TEXT NOT NULL DEFAULT 'HUF',
      active INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_line_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL REFERENCES cost_sources(id),
      charge_period_start INTEGER NOT NULL,
      charge_period_end INTEGER NOT NULL,
      charge_category TEXT NOT NULL,
      service_name TEXT,
      usage_type TEXT,
      consumed_quantity REAL,
      consumed_unit TEXT,
      billed_cost REAL NOT NULL,
      effective_cost REAL,
      currency TEXT NOT NULL DEFAULT 'HUF',
      confidence TEXT NOT NULL,
      data_freshness INTEGER NOT NULL,
      source_ref TEXT,
      dedup_key TEXT UNIQUE,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_line_items_period ON cost_line_items(charge_period_start, charge_period_end)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_line_items_source ON cost_line_items(source_id)`)

  // --- Vault SSH Keys (shared pool) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_ssh_keys (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      username TEXT NOT NULL,
      vault_key_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      key_type TEXT NOT NULL DEFAULT 'ed25519',
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_vault_ssh_keys_label ON vault_ssh_keys(label)`)

  // --- Vault SSH Servers ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_ssh_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 22,
      username TEXT NOT NULL,
      ssh_key_id TEXT REFERENCES vault_ssh_keys(id),
      description TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_vault_ssh_servers_name ON vault_ssh_servers(name)`)
  // Migrations for installs that ran earlier schema versions. MUST run before
  // the ssh_key_id index below: on an install where vault_ssh_servers already
  // existed (pre-dating this column), CREATE TABLE IF NOT EXISTS above is a
  // no-op and never adds ssh_key_id -- indexing it before this ALTER TABLE
  // runs throws "no such column: ssh_key_id" and crashes startup entirely
  // (2026-07-01 incident: dashboard 502'd, crash-looped on every restart).
  // Drop legacy per-server key columns that are no longer written or read.
  // On older installs these were added via ALTER TABLE; fresh installs never had them.
  // SQLite 3.35+ is required; try-catch makes this a no-op on either scenario.
  try { db.exec('ALTER TABLE vault_ssh_servers DROP COLUMN key_type') } catch { /* column absent or SQLite pre-3.35 */ }
  try { db.exec('ALTER TABLE vault_ssh_servers DROP COLUMN fingerprint') } catch { /* column absent or SQLite pre-3.35 */ }
  try { db.exec('ALTER TABLE vault_ssh_servers DROP COLUMN vault_key_id') } catch { /* column absent or SQLite pre-3.35 */ }
  try { db.exec('ALTER TABLE vault_ssh_servers DROP COLUMN key_expires_at') } catch { /* column absent or SQLite pre-3.35 */ }
  try { db.exec('ALTER TABLE vault_ssh_servers ADD COLUMN ssh_key_id TEXT REFERENCES vault_ssh_keys(id)') } catch { /* already exists */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_vault_ssh_servers_key ON vault_ssh_servers(ssh_key_id)`)

  // --- Approvals (HITL) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      category TEXT NOT NULL,
      action_description TEXT NOT NULL,
      action_payload TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','approved','rejected','timeout')),
      timeout_at INTEGER,
      telegram_message_id INTEGER,
      requested_at INTEGER NOT NULL DEFAULT (unixepoch()),
      resolved_at INTEGER,
      resolved_by TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, requested_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_approvals_agent ON approvals(agent_id, requested_at)`)

  // --- Dashboard browser login (OPTIONAL; the bearer token stays primary) ---
  // Zero rows here = exactly the token-only behavior. A row is created only when
  // the operator opts in (Settings card or the dashboard-user CLI). No seeded
  // credentials -- the byte-copy-fresh-install rule forbids any default user.
  // password_hash is a PHC string (see web/password-hash.ts). username is
  // UNIQUE COLLATE NOCASE so logins are case-insensitive.
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0
    )
  `)
  // Browser login sessions. NOT named `sessions` -- that table already maps
  // Telegram chats to Claude session ids. Only sha256(session_id) is stored, so
  // a DB leak does not hand out live sessions. Rows survive dashboard restarts;
  // the in-memory cache in web/auth-sessions.ts rehydrates from here lazily.
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      user_agent TEXT,
      remote_note TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id)`)

  // Per-device dashboard keys (AUTHPLAN1 #1). One row per enrolled device
  // (Bridge install, phone) so a single device can be revoked without rotating
  // the shared dashboard token. Only sha256(key) is stored -- the raw value is
  // shown once at mint time. expires_at is OPT-IN (null = lives until revoked;
  // a rarely used phone must not die silently). Zero rows = feature off; the
  // auth gate falls through exactly as before, so fresh installs see no change.
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      expires_at INTEGER,
      install_id TEXT
    )
  `)
  // Bridge pairing (AUTHPLAN1 #2): links a device key to the SSH enrollment's
  // marveen-remote:<uuid> so revoking the key can drop the authorized_keys
  // line in the same step. Null for keys minted outside the pairing flow.
  try { db.exec(`ALTER TABLE device_keys ADD COLUMN install_id TEXT`) } catch { /* column already exists */ }

  // --- OTel Distributed Tracing (card def5a189) ---
  // SQLite-native span store. No external OTel SDK: spans are written via
  // /api/spans and the message-router middleware injects trace context into
  // agent_messages rows transparently (agents don't need to know about tracing).
  // trace_id: root identifier shared across the entire chain (generated once
  //   by the message-router for the root message, inherited by all children).
  // span_id: per-message unique id (nanoid).
  // parent_span_id: null for root; sender's span_id for downstream messages.
  // The tool_call_log.trace_id column (added by #274) holds the Claude Code
  // native tool_use_id (per-call span) -- a DIFFERENT, narrower concept. The
  // waterfall UI joins otel_spans (inter-agent latency) with tool_call_log
  // (intra-agent tool timing) via agent_id + time overlap.
  db.exec(`
    CREATE TABLE IF NOT EXISTS otel_spans (
      trace_id        TEXT NOT NULL,
      span_id         TEXT NOT NULL,
      parent_span_id  TEXT,
      agent_id        TEXT NOT NULL,
      operation       TEXT NOT NULL,
      start_ms        INTEGER NOT NULL,
      end_ms          INTEGER,
      status          TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok','error','timeout','running')),
      attributes      TEXT,
      PRIMARY KEY (trace_id, span_id)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_otel_spans_trace ON otel_spans(trace_id, start_ms)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_otel_spans_agent ON otel_spans(agent_id, start_ms)`)

  // One-shot migration from the old JSON file (which had a read-modify-write
  // race). Import rows if they exist, then rename the file so we don't keep
  // re-importing. Wrapped in a transaction so a crash mid-import is safe.
  migrateTaskRunsFromJson()
}

function migrateTaskRunsFromJson(): void {
  const legacyPath = join(STORE_DIR, 'task-run-history.json')
  if (!existsSync(legacyPath)) return
  const existingCount = (db.prepare('SELECT COUNT(*) as c FROM task_runs').get() as { c: number }).c
  if (existingCount > 0) {
    // Already migrated in a previous run. Rename the file out of the way if
    // still present so the migration doesn't keep re-running with zero effect.
    try { renameSync(legacyPath, `${legacyPath}.migrated`) } catch { /* fine */ }
    return
  }
  try {
    const raw = readFileSync(legacyPath, 'utf-8')
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return
    const insert = db.prepare('INSERT INTO task_runs (name, agent, ts) VALUES (?, ?, ?)')
    const tx = db.transaction((rows: unknown[]) => {
      for (const e of rows) {
        if (!e || typeof e !== 'object') continue
        const { name, agent, ts } = e as { name?: unknown; agent?: unknown; ts?: unknown }
        if (typeof name !== 'string' || typeof agent !== 'string' || typeof ts !== 'number') continue
        insert.run(name, agent, ts)
      }
    })
    tx(arr)
    try { renameSync(legacyPath, `${legacyPath}.migrated`) } catch { /* fine */ }
  } catch { /* corrupt file, skip */ }
}

export function getDb(): Database.Database {
  return db
}

// --- Munkamenetek ---

export function getSession(chatId: string): { sessionId: string; messageCount: number } | undefined {
  const row = db
    .prepare('SELECT session_id, message_count FROM sessions WHERE chat_id = ?')
    .get(chatId) as { session_id: string; message_count: number } | undefined
  if (!row) return undefined
  return { sessionId: row.session_id, messageCount: row.message_count }
}

export function setSession(chatId: string, sessionId: string, messageCount = 0): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (chat_id, session_id, updated_at, message_count) VALUES (?, ?, ?, ?)'
  ).run(chatId, sessionId, Math.floor(Date.now() / 1000), messageCount)
}

export function incrementSessionCount(chatId: string): number {
  db.prepare('UPDATE sessions SET message_count = message_count + 1 WHERE chat_id = ?').run(chatId)
  const row = db.prepare('SELECT message_count FROM sessions WHERE chat_id = ?').get(chatId) as { message_count: number } | undefined
  return row?.message_count ?? 0
}

export function clearSession(chatId: string): void {
  db.prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId)
}

// --- Dashboard users (optional browser login) ---

export interface DashboardUser {
  id: number
  username: string
  password_hash: string
  created_at: number
  updated_at: number
  disabled: number
}

export type DashboardUserPublic = Omit<DashboardUser, 'password_hash'>

export function createDashboardUser(username: string, passwordHash: string): DashboardUser {
  const now = Math.floor(Date.now() / 1000)
  const info = db
    .prepare('INSERT INTO dashboard_users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(username, passwordHash, now, now)
  return { id: Number(info.lastInsertRowid), username, password_hash: passwordHash, created_at: now, updated_at: now, disabled: 0 }
}

export function getDashboardUser(username: string): DashboardUser | undefined {
  return db
    .prepare('SELECT * FROM dashboard_users WHERE username = ? COLLATE NOCASE')
    .get(username) as DashboardUser | undefined
}

export function listDashboardUsers(): DashboardUserPublic[] {
  return db
    .prepare('SELECT id, username, created_at, updated_at, disabled FROM dashboard_users ORDER BY username COLLATE NOCASE')
    .all() as DashboardUserPublic[]
}

// enabled-only count feeds `login_available`; total count feeds `setup_required`.
export function countDashboardUsers(includeDisabled = false): number {
  const sql = includeDisabled
    ? 'SELECT COUNT(*) AS c FROM dashboard_users'
    : 'SELECT COUNT(*) AS c FROM dashboard_users WHERE disabled = 0'
  return (db.prepare(sql).get() as { c: number }).c
}

export function updateDashboardUserPassword(userId: number, passwordHash: string): void {
  db.prepare('UPDATE dashboard_users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(passwordHash, Math.floor(Date.now() / 1000), userId)
}

export function deleteDashboardUser(username: string): boolean {
  const info = db.prepare('DELETE FROM dashboard_users WHERE username = ? COLLATE NOCASE').run(username)
  return info.changes > 0
}

// --- Memória ---

export interface Memory {
  id: number
  chat_id: string
  topic_key: string | null
  content: string
  sector: 'semantic' | 'episodic'
  salience: number
  created_at: number
  accessed_at: number
  agent_id: string
  category: string  // 'hot' | 'warm' | 'cold' | 'shared'
  auto_generated: number
  keywords: string | null
  embedding: string | null
}

export function saveMemory(
  chatId: string,
  content: string,
  sector: 'semantic' | 'episodic',
  topicKey?: string
): void {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    'INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, ?, 1.0, ?, ?)'
  ).run(chatId, topicKey ?? null, content, sector, now, now)
  const id = Number(info.lastInsertRowid)

  // Fire-and-forget embedding, the same shape saveAgentMemory already uses (card f27c999b,
  // adopted from upstream). This path had none, so a row written here reached semantic search
  // only after backfillEmbeddings() ran -- and that runs at STARTUP (index.ts), not on a timer.
  //
  // MEASURED before adopting, because the note that asked for this (and my own restatement of it)
  // overstated the effect: 0 of 1509 rows on this install are unvectorised, including all 20
  // nightly daily-log digest rows. The backfill is doing its job. What this fixes is the WINDOW,
  // not a permanent hole: a memory written at 02:00 is unsearchable until the next restart, which
  // can be a day away, and the guarantee currently depends on a sweep nobody schedules.
  generateEmbedding(content).then(emb => {
    if (emb) {
      db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(JSON.stringify(emb), id)
    }
  }).catch(() => {})
}

// Build a safe FTS5 MATCH expression from a free-form user query.
//
// FTS5 treats AND / OR / NOT / NEAR as reserved operators only when uppercase
// and unquoted -- so we lowercase everything, which turns them into ordinary
// search terms. We also cap the number and length of tokens to bound query
// cost (the sanitizer previously allowed an arbitrary-length prefix expansion
// that could make a single request scan the entire index).
export function buildFtsMatchExpression(query: string): string {
  const MAX_TOKENS = 20
  const MAX_TOKEN_LEN = 64
  const sanitized = query
    .toLowerCase()
    // Replace punctuation with a space (not delete) so "rank-check" / "serper.dev"
    // tokenize the same way unicode61 indexed them (rank + check), instead of
    // fusing into a single unfindable token "rankcheck".
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
  if (!sanitized) return ''
  const tokens = sanitized
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, MAX_TOKENS)
    .map((t) => t.slice(0, MAX_TOKEN_LEN) + '*')
  return tokens.join(' ')
}

// -- Recency-weighted retrieval (Roitman 17.4.2) --
//
// score = λ·relevance + (1−λ)·recency, where recency = exp(−age/τ). Pure
// keyword rank returns whichever memory FTS scores highest regardless of age,
// so a stale fact ("reply tool down") can outrank its own correction ("reply
// tool up"). The blend keeps relevance dominant (λ = 0.7) but breaks
// near-ties in favour of the newer memory.
//
// FTS5 `rank` is bm25: negative, more negative = better. Normalized to 0..1
// via −rank/(1−rank) (monotonic, no unbounded tail). The blend runs in JS on
// an oversampled candidate set rather than in SQL so it does not depend on
// SQLite being compiled with math functions, and stays unit-testable.
export const RECENCY_LAMBDA = 0.7
export const RECENCY_TAU_SEC = 7 * 86400
// Candidates fetched per requested row before re-ranking. Bounded so a broad
// query still touches at most 4x the requested rows.
const RECENCY_OVERSAMPLE = 4

export interface RecencyRankable {
  rank: number
  created_at: number
}

export function recencyWeightedScore(
  row: RecencyRankable,
  nowSec: number,
  lambda = RECENCY_LAMBDA,
  tauSec = RECENCY_TAU_SEC,
): number {
  const relevance = row.rank < 0 ? -row.rank / (1 - row.rank) : 0
  const ageSec = Math.max(0, nowSec - row.created_at)
  const recency = Math.exp(-ageSec / tauSec)
  return lambda * relevance + (1 - lambda) * recency
}

export function reRankByRecency<T extends RecencyRankable>(
  rows: T[],
  limit: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): T[] {
  return rows
    .map((row) => ({ row, score: recencyWeightedScore(row, nowSec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.row)
}

// Strip the FTS rank column the oversampled queries select for re-ranking, so
// the public return shape stays exactly Memory.
function withoutRank<T extends { rank: number }>(rows: T[]): Omit<T, 'rank'>[] {
  return rows.map(({ rank: _rank, ...rest }) => rest)
}

export function searchMemories(query: string, chatId: string, limit = 3): Memory[] {
  const terms = buildFtsMatchExpression(query)
  if (!terms) return []
  try {
    const candidates = db
      .prepare(
        `SELECT m.*, f.rank AS rank FROM memories m
         JOIN memories_fts f ON m.id = f.rowid
         WHERE f.content MATCH ? AND m.chat_id = ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(terms, chatId, limit * RECENCY_OVERSAMPLE) as (Memory & { rank: number })[]
    return withoutRank(reRankByRecency(candidates, limit)) as Memory[]
  } catch {
    return []
  }
}

export function recentMemories(chatId: string, limit = 5): Memory[] {
  return db
    .prepare('SELECT * FROM memories WHERE chat_id = ? ORDER BY accessed_at DESC LIMIT ?')
    .all(chatId, limit) as Memory[]
}

export function touchMemory(id: number): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'UPDATE memories SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE id = ?'
  ).run(now, id)
}

// Mark a batch of memories as just-recalled (bumps accessed_at only). Used by
// the agent-memory read endpoint so that accessed_at reflects real usage --
// without this, agent memories keep accessed_at == created_at forever and any
// "not accessed in N days" staleness check (e.g. the Dream Engine hygiene pass)
// treats even freshly-recalled memories as stale. Salience is intentionally
// left untouched here; this is a lightweight recency stamp, not a ranking bump.
export function touchMemoriesAccessed(ids: number[]): void {
  if (ids.length === 0) return
  const now = Math.floor(Date.now() / 1000)
  const placeholders = ids.map(() => '?').join(',')
  db.prepare(`UPDATE memories SET accessed_at = ? WHERE id IN (${placeholders})`).run(now, ...ids)
}

export function decayMemories(): void {
  const oneWeekAgo = Math.floor(Date.now() / 1000) - 7 * 86400
  // Gentler decay: 0.5% per day, only for memories older than 1 week
  // Never delete -- salience just goes lower but memories persist
  db.prepare('UPDATE memories SET salience = MAX(salience * 0.995, 0.01) WHERE created_at < ?').run(oneWeekAgo)
}

export function getMemoriesForChat(chatId: string, limit = 10): Memory[] {
  return db
    .prepare('SELECT * FROM memories WHERE chat_id = ? ORDER BY accessed_at DESC LIMIT ?')
    .all(chatId, limit) as Memory[]
}

// --- In-process memory cache (TTL-based) ---
//
// Avoids a SQLite round-trip on every context-fetch by keeping the most
// recently read agent memory lists in a Map for up to MEMORY_CACHE_TTL_MS.
// Writers are responsible for evicting what they invalidate: saveAgentMemory
// and updateMemory evict the affected agent(s), and a write touching a
// 'shared' memory clears everything, because a shared row appears in EVERY
// agent's list (see getAgentMemories). Miss an eviction and the listing serves
// pre-write data for up to a minute, with nothing in the response to show it.
// The cache is intentionally coarse-grained (per agentId+limit+category) to
// stay simple and safe under concurrent async paths.

const MEMORY_CACHE_TTL_MS = 60_000

interface MemoryCacheEntry {
  value: Memory[]
  expiresAt: number
}

const memoryCache = new Map<string, MemoryCacheEntry>()

function memoryCacheGet(key: string): Memory[] | null {
  const entry = memoryCache.get(key)
  if (!entry || Date.now() > entry.expiresAt) {
    memoryCache.delete(key)
    return null
  }
  return entry.value
}

function memoryCacheSet(key: string, value: Memory[]): void {
  memoryCache.set(key, { value, expiresAt: Date.now() + MEMORY_CACHE_TTL_MS })
}

function memoryCacheInvalidate(agentId: string): void {
  for (const key of memoryCache.keys()) {
    if (key.startsWith(`${agentId}:`)) memoryCache.delete(key)
  }
}

/** Exposed for tests and diagnostics only. */
export function clearMemoryCache(): void {
  memoryCache.clear()
}

/** Exposed for tests only. */
export function getMemoryCacheSize(): number {
  return memoryCache.size
}

export function saveAgentMemory(
  agentId: string,
  content: string,
  category: string,  // hot, warm, cold, shared
  keywords?: string,
  autoGenerated: boolean = false
): { id: number } {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    'INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at, agent_id, category, auto_generated, keywords) VALUES (?, ?, ?, ?, 1.0, ?, ?, ?, ?, ?, ?)'
  ).run(ALLOWED_CHAT_ID, null, content, 'semantic', now, now, agentId, category, autoGenerated ? 1 : 0, keywords ?? null)
  const id = Number(info.lastInsertRowid)

  // A new 'shared' row joins EVERY agent's list, not just the author's, so
  // evicting the author alone would leave every other agent serving a list
  // that is missing it. Same call the update path makes, for the same reason.
  if (category === 'shared') clearMemoryCache()
  else memoryCacheInvalidate(agentId)

  // Fire-and-forget: generate embedding asynchronously
  generateEmbedding(content + (keywords ? ' ' + keywords : '')).then(emb => {
    if (emb) {
      db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(JSON.stringify(emb), id)
    }
  }).catch(() => {})

  return { id }
}

// The category filter belongs in SQL, ahead of the LIMIT. Filtering the rows
// afterwards would answer "the <category> ones among the N most recently
// accessed memories" instead of "the N most recent <category> memories", so an
// older-but-still-active memory would drop out of the list with no truncation
// signal -- invisible to the caller, and worst right after a restart.
export function getAgentMemories(agentId: string, limit: number = 20, category?: string): Memory[] {
  const key = `${agentId}:${limit}:${category ?? ''}`
  const cached = memoryCacheGet(key)
  if (cached) return cached
  const result = (category
    ? db.prepare(
        "SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND category = ? ORDER BY accessed_at DESC LIMIT ?"
      ).all(agentId, category, limit)
    : db.prepare(
        "SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') ORDER BY accessed_at DESC LIMIT ?"
      ).all(agentId, limit)) as Memory[]
  memoryCacheSet(key, result)
  return result
}

// Content-SHAPE prefixes the activity_memory_capture.py PostToolUse hook writes (card 3bcc1242
// part 1). Deliberately NOT keyed off `auto_generated` -- that flag also marks 475 hand-written
// fleet memories (the whole shared tier, most of warm), so filtering on it would make those
// invisible/effectively-deleted from search with no error to signal it. The SHAPE is what
// actually distinguishes a raw tool-call trace from a written-down memory, regardless of how the
// row got there. Measured live: 844 of 858 backend auto_generated rows (98%) start with one of
// these exact prefixes.
export const TOOL_LOG_CONTENT_PREFIXES = [
  'Bash: ', 'Write: ', 'Edit: ', 'Read: ', 'NotebookEdit: ', 'Agent spawned: ', 'Workflow: ',
] as const

/** `AND`-able SQL fragment (one `NOT LIKE ?` per prefix) plus its bind params, in order. Applied
 *  INSIDE the query (not as a post-filter) so RECENCY_OVERSAMPLE's candidate pool is already
 *  clean -- a post-filter on an oversampled batch would starve results on a corpus that is
 *  mostly tool-log noise (measured: 77-98% for a heavy tool-using agent). */
export function excludeToolLogShapeSql(): { sql: string; params: string[] } {
  return {
    sql: TOOL_LOG_CONTENT_PREFIXES.map(() => 'm.content NOT LIKE ?').join(' AND '),
    params: TOOL_LOG_CONTENT_PREFIXES.map((p) => `${p}%`),
  }
}

export function searchAgentMemories(agentId: string, query: string, limit: number = 10): Memory[] {
  const terms = buildFtsMatchExpression(query)
  if (!terms) return []
  const shapeFilter = excludeToolLogShapeSql()
  try {
    const candidates = db.prepare(
      `SELECT m.*, f.rank AS rank FROM memories m
       JOIN memories_fts f ON m.id = f.rowid
       WHERE f.memories_fts MATCH ? AND (m.agent_id = ? OR m.category = 'shared')
         AND (${shapeFilter.sql})
       ORDER BY rank LIMIT ?`
    ).all(terms, agentId, ...shapeFilter.params, limit * RECENCY_OVERSAMPLE) as (Memory & { rank: number })[]
    return withoutRank(reRankByRecency(candidates, limit)) as Memory[]
  } catch {
    // `FROM memories m`: the shape fragment above is alias-qualified for the FTS join (see
    // excludeToolLogShapeSql). Without the alias here this catch raised `no such column:
    // m.content` -- so the designated safety net for an FTS failure threw a SECOND, unrelated
    // error instead of degrading, turning a recoverable outage into a hard 500 (card ad209cdf).
    return db.prepare(
      `SELECT * FROM memories m WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? OR keywords LIKE ?)
       AND (${shapeFilter.sql}) ORDER BY accessed_at DESC LIMIT ?`
    ).all(agentId, `%${query}%`, `%${query}%`, ...shapeFilter.params, limit) as Memory[]
  }
}

export function getMemoryStats(): { total: number; byAgent: Record<string, number>; byTier: Record<string, number>; withEmbedding: number } {
  const total = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as {c:number}).c
  const withEmbedding = (db.prepare('SELECT COUNT(*) as c FROM memories WHERE embedding IS NOT NULL').get() as {c:number}).c
  const agentRows = db.prepare('SELECT agent_id, COUNT(*) as c FROM memories GROUP BY agent_id').all() as {agent_id:string, c:number}[]
  const tierRows = db.prepare('SELECT category, COUNT(*) as c FROM memories GROUP BY category').all() as {category:string, c:number}[]
  const byAgent: Record<string, number> = {}
  const byTier: Record<string, number> = {}
  for (const r of agentRows) byAgent[r.agent_id] = r.c
  for (const r of tierRows) byTier[r.category] = r.c
  return { total, byAgent, byTier, withEmbedding }
}

// --- Episodic: failed-episode lessons (card baeddb21) ---

export interface FailedEpisodeParams {
  agentId: string
  task: string       // what was attempted
  attempt: string    // how it was tried
  error: string      // what went wrong
  lesson: string     // what to do instead
  keywords?: string  // optional extra search terms
}

export interface FailedEpisodeMemory {
  id: number
  agentId: string
  topicKey: string
  content: string
}

let _failedEpisodeSeq = 0
export function saveFailedEpisode(params: FailedEpisodeParams): FailedEpisodeMemory {
  const { agentId, task, attempt, error, lesson, keywords } = params
  const now = Math.floor(Date.now() / 1000)
  const seq = ++_failedEpisodeSeq
  // slug: first 24 chars of task, safe for topic_key
  const slug = task.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 24).replace(/-+$/, '')
  const topicKey = `failed_episode:${slug}:${now}:${seq}`
  const content = `[BUKOTT_EPIZÓD] Feladat: ${task} | Próbálkozás: ${attempt} | Hiba: ${error} | Tanulság: ${lesson}`
  const kw = [
    'bukott epizod tanulsag hiba',
    task.slice(0, 60),
    keywords || '',
  ].filter(Boolean).join(' ')

  const info = db.prepare(
    'INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at, agent_id, category, auto_generated, keywords) VALUES (?, ?, ?, ?, 1.5, ?, ?, ?, ?, ?, ?)'
  ).run(ALLOWED_CHAT_ID, topicKey, content, 'episodic', now, now, agentId, 'cold', 1, kw)
  const id = Number(info.lastInsertRowid)

  generateEmbedding(content + ' ' + kw).then(emb => {
    if (emb) db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(JSON.stringify(emb), id)
  }).catch(() => {})

  return { id, agentId, topicKey, content }
}

export function listFailedEpisodes(agentId: string, limit: number = 20): Memory[] {
  return db.prepare(
    "SELECT * FROM memories WHERE agent_id = ? AND sector = 'episodic' AND topic_key LIKE 'failed_episode:%' ORDER BY created_at DESC LIMIT ?"
  ).all(agentId, limit) as Memory[]
}

// --- LoCoMo-inspired recall audit (card baeddb21) ---

export interface MemoryRecallAudit {
  sampleSize: number
  testedCount: number
  keywordPrecisionAtK: number      // % of keyword-tagged memories found in top-10 search
  staleRatio: number               // % memories never accessed after creation
  tierDistribution: Record<string, number>
  failedEpisodeCount: number       // total failed_episode entries for agent
  ftsHealthy: boolean              // basic FTS5 self-check
  runAt: number
}

export function auditMemoryRecall(agentId: string, sampleSize: number = 50): MemoryRecallAudit {
  const now = Math.floor(Date.now() / 1000)

  // FTS5 health check: run a harmless wildcard query, no throw = healthy
  let ftsHealthy = true
  try {
    db.prepare(
      "SELECT m.id FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE f.memories_fts MATCH ? AND (m.agent_id = ? OR m.category = 'shared') LIMIT 1"
    ).all('health*', agentId)
  } catch {
    ftsHealthy = false
  }

  // Sample memories for the agent
  const sampled = db.prepare(
    "SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') ORDER BY RANDOM() LIMIT ?"
  ).all(agentId, sampleSize) as Memory[]

  // Tier distribution
  const tierDistribution: Record<string, number> = { hot: 0, warm: 0, cold: 0, shared: 0 }
  let staleCount = 0
  for (const m of sampled) {
    tierDistribution[m.category] = (tierDistribution[m.category] ?? 0) + 1
    if (m.accessed_at <= m.created_at + 2) staleCount++  // +2s tolerance for write race
  }

  // Keyword precision@10: test memories that have keywords
  const withKeywords = sampled.filter(m => m.keywords && m.keywords.trim().length > 3)
  let hits = 0
  for (const m of withKeywords) {
    const firstKeyword = (m.keywords ?? '').split(/[,\s]+/).find(t => t.trim().length > 2) ?? ''
    if (!firstKeyword) continue
    const terms = buildFtsMatchExpression(firstKeyword)
    if (!terms) continue
    try {
      const found = db.prepare(
        "SELECT m2.id FROM memories m2 JOIN memories_fts f ON m2.id = f.rowid WHERE f.memories_fts MATCH ? AND (m2.agent_id = ? OR m2.category = 'shared') ORDER BY rank LIMIT 10"
      ).all(terms, agentId) as { id: number }[]
      if (found.some(r => r.id === m.id)) hits++
    } catch {
      // FTS error on this row -- skip
    }
  }
  const testedCount = withKeywords.length
  const keywordPrecisionAtK = testedCount > 0 ? hits / testedCount : 0

  // Failed episode count for agent
  const failedEpisodeCount = (db.prepare(
    "SELECT COUNT(*) as c FROM memories WHERE agent_id = ? AND sector = 'episodic' AND topic_key LIKE 'failed_episode:%'"
  ).get(agentId) as { c: number }).c

  return {
    sampleSize,
    testedCount,
    keywordPrecisionAtK: Math.round(keywordPrecisionAtK * 1000) / 1000,
    staleRatio: sampled.length > 0 ? Math.round(staleCount / sampled.length * 1000) / 1000 : 0,
    tierDistribution,
    failedEpisodeCount,
    ftsHealthy,
    runAt: now,
  }
}

export function updateMemory(id: number, content: string, category?: string, agentId?: string, keywords?: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  // Read the row's CURRENT owner and category before writing. The agentId
  // parameter is optional and means "reassign to this agent", so it is absent
  // on the ordinary edit -- it cannot be used to decide whose cache went
  // stale. Only the row itself knows that.
  const before = db.prepare('SELECT agent_id, category FROM memories WHERE id = ?').get(id) as
    { agent_id: string | null; category: string | null } | undefined
  const sets: string[] = ['content = ?', 'accessed_at = ?']
  const params: unknown[] = [content, now]
  if (category) { sets.push('category = ?'); params.push(category) }
  if (agentId) { sets.push('agent_id = ?'); params.push(agentId) }
  if (keywords !== undefined) { sets.push('keywords = ?'); params.push(keywords) }
  params.push(id)
  const changed = db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0
  if (changed) {
    if (before?.category === 'shared' || category === 'shared') {
      // A shared row is listed for every agent, so evicting one owner is not
      // enough. Same blunt call the DELETE route makes, for the same reason.
      clearMemoryCache()
    } else {
      if (before?.agent_id) memoryCacheInvalidate(before.agent_id)
      if (agentId && agentId !== before?.agent_id) memoryCacheInvalidate(agentId)
    }
  }
  return changed
}

// --- Daily logs ---

export function appendDailyLog(agentId: string, content: string): void {
  const now = Math.floor(Date.now() / 1000)
  // Budapest calendar day, not UTC -- otherwise an entry written 00:00-02:00
  // local time lands on the previous day and the "ma" recall query misses it.
  // en-CA formats as YYYY-MM-DD.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: APP_TZ })
  db.prepare('INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES (?, ?, ?, ?)').run(agentId, today, content, now)
}

export function getDailyLog(agentId: string, date: string): { id: number; content: string; created_at: number }[] {
  return db.prepare('SELECT id, content, created_at FROM daily_logs WHERE agent_id = ? AND date = ? ORDER BY created_at ASC').all(agentId, date) as { id: number; content: string; created_at: number }[]
}

export function getDailyLogDates(agentId: string, limit: number = 14): string[] {
  return (db.prepare('SELECT DISTINCT date FROM daily_logs WHERE agent_id = ? ORDER BY date DESC LIMIT ?').all(agentId, limit) as { date: string }[]).map(r => r.date)
}

// --- Session Recall ---

export interface RecallResult {
  logs: { id: number; agent_id: string; date: string; content: string; created_at: number }[]
  memories: Memory[]
  dateRange: { from: string; to: string }
}

function toBudapestTs(dateStr: string, endOfDay: boolean): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const refDate = new Date(`${dateStr}T${endOfDay ? '23:59:59' : '00:00:00'}`)
  const parts = fmt.formatToParts(refDate)
  const get = (t: string) => parts.find(p => p.type === t)?.value || '0'
  const localStr = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
  const localMs = new Date(localStr + 'Z').getTime()
  const offsetMs = localMs - refDate.getTime()
  const target = new Date(`${dateStr}T${endOfDay ? '23:59:59' : '00:00:00'}Z`)
  return Math.floor((target.getTime() - offsetMs) / 1000)
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

export function recallByDateRange(from: string, to: string, agentId?: string): RecallResult {
  const logSql = agentId
    ? 'SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE date >= ? AND date <= ? AND agent_id = ? ORDER BY date ASC, created_at ASC'
    : 'SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE date >= ? AND date <= ? ORDER BY date ASC, created_at ASC'
  const logParams = agentId ? [from, to, agentId] : [from, to]
  const logs = db.prepare(logSql).all(...logParams) as RecallResult['logs']

  const fromTs = toBudapestTs(from, false)
  const toTs = toBudapestTs(to, true)
  const memSql = agentId
    ? "SELECT * FROM memories WHERE created_at >= ? AND created_at <= ? AND (agent_id = ? OR category = 'shared') ORDER BY created_at ASC"
    : 'SELECT * FROM memories WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC'
  const memParams = agentId ? [fromTs, toTs, agentId] : [fromTs, toTs]
  const memories = db.prepare(memSql).all(...memParams) as Memory[]

  return { logs, memories, dateRange: { from, to } }
}

export function recallSearch(query: string, agentId?: string, limit = 50): RecallResult {
  const terms = buildFtsMatchExpression(query)
  let memories: Memory[] = []
  const escaped = escapeLike(query)
  if (terms) {
    try {
      // Was ORDER BY created_at DESC (pure recency, relevance ignored); now the
      // same λ-blend as the other search paths, so a strongly matching older
      // memory can still surface above barely-matching fresh noise.
      const sql = agentId
        ? `SELECT m.*, f.rank AS rank FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE f.memories_fts MATCH ? AND (m.agent_id = ? OR m.category = 'shared') ORDER BY rank LIMIT ?`
        : `SELECT m.*, f.rank AS rank FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE f.memories_fts MATCH ? ORDER BY rank LIMIT ?`
      const candidates = agentId
        ? db.prepare(sql).all(terms, agentId, limit * RECENCY_OVERSAMPLE) as (Memory & { rank: number })[]
        : db.prepare(sql).all(terms, limit * RECENCY_OVERSAMPLE) as (Memory & { rank: number })[]
      memories = withoutRank(reRankByRecency(candidates, limit)) as Memory[]
    } catch {
      const sql = agentId
        ? "SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?"
        : "SELECT * FROM memories WHERE (content LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?"
      const pat = `%${escaped}%`
      memories = agentId
        ? db.prepare(sql).all(agentId, pat, pat, limit) as Memory[]
        : db.prepare(sql).all(pat, pat, limit) as Memory[]
    }
  }

  const logSql = agentId
    ? "SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE content LIKE ? ESCAPE '\\' AND agent_id = ? ORDER BY date DESC, created_at DESC LIMIT ?"
    : "SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE content LIKE ? ESCAPE '\\' ORDER BY date DESC, created_at DESC LIMIT ?"
  const logPat = `%${escaped}%`
  const logs = agentId
    ? db.prepare(logSql).all(logPat, agentId, limit) as RecallResult['logs']
    : db.prepare(logSql).all(logPat, limit) as RecallResult['logs']

  const dates = logs.map(l => l.date)
  const from = dates.length ? dates[dates.length - 1] : ''
  const to = dates.length ? dates[0] : ''

  return { logs, memories, dateRange: { from, to } }
}

// --- Background tasks ---

export interface BackgroundTask {
  id: string
  agent_id: string
  prompt: string
  status: 'running' | 'done' | 'failed' | 'timeout'
  tmux_session: string | null
  started_at: number
  finished_at: number | null
  output: string | null
}

export function createBackgroundTaskAtomic(id: string, agentId: string, prompt: string, tmuxSession: string, maxConcurrent: number): BackgroundTask | null {
  const now = Math.floor(Date.now() / 1000)
  const result = db.transaction(() => {
    const running = (db.prepare("SELECT COUNT(*) as c FROM background_tasks WHERE agent_id = ? AND status = 'running'").get(agentId) as { c: number }).c
    if (running >= maxConcurrent) return null
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, agentId, prompt, 'running', tmuxSession, now)
    return { id, agent_id: agentId, prompt, status: 'running' as const, tmux_session: tmuxSession, started_at: now, finished_at: null, output: null }
  })()
  return result
}

export function getRunningBackgroundTasks(): BackgroundTask[] {
  return db.prepare("SELECT * FROM background_tasks WHERE status = 'running'").all() as BackgroundTask[]
}

export function finishBackgroundTask(id: string, status: 'done' | 'failed' | 'timeout', output: string | null): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare('UPDATE background_tasks SET status = ?, finished_at = ?, output = ? WHERE id = ?')
    .run(status, now, output, id)
}

export function getBackgroundTasks(agentId?: string, includeFinished = false): BackgroundTask[] {
  if (agentId) {
    const sql = includeFinished
      ? 'SELECT * FROM background_tasks WHERE agent_id = ? ORDER BY started_at DESC LIMIT 50'
      : "SELECT * FROM background_tasks WHERE agent_id = ? AND status = 'running' ORDER BY started_at DESC"
    return db.prepare(sql).all(agentId) as BackgroundTask[]
  }
  const sql = includeFinished
    ? 'SELECT * FROM background_tasks ORDER BY started_at DESC LIMIT 50'
    : "SELECT * FROM background_tasks WHERE status = 'running' ORDER BY started_at DESC"
  return db.prepare(sql).all() as BackgroundTask[]
}

export function getBackgroundTask(id: string): BackgroundTask | undefined {
  return db.prepare('SELECT * FROM background_tasks WHERE id = ?').get(id) as BackgroundTask | undefined
}

export function markOrphanedTasksFailed(): number {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare("UPDATE background_tasks SET status = 'failed', finished_at = ?, output = '(orphaned on restart)' WHERE status = 'running'")
    .run(now)
  return info.changes
}

// --- Ütemezett feladatok ---

export interface ScheduledTask {
  id: string
  chat_id: string
  prompt: string
  schedule: string
  next_run: number
  last_run: number | null
  last_result: string | null
  status: 'active' | 'paused'
  created_at: number
}

export function createTask(
  id: string,
  chatId: string,
  prompt: string,
  schedule: string,
  nextRun: number
): void {
  db.prepare(
    'INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, chatId, prompt, schedule, nextRun, Math.floor(Date.now() / 1000))
}

export function getDueTasks(): ScheduledTask[] {
  const now = Math.floor(Date.now() / 1000)
  return db
    .prepare("SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ?")
    .all(now) as ScheduledTask[]
}

export function updateTaskAfterRun(id: string, nextRun: number, result: string): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'UPDATE scheduled_tasks SET last_run = ?, next_run = ?, last_result = ? WHERE id = ?'
  ).run(now, nextRun, result, id)
}

export function listTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[]
}

export function deleteTask(id: string): boolean {
  return db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id).changes > 0
}

export function pauseTask(id: string): boolean {
  return (
    db.prepare("UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?").run(id).changes > 0
  )
}

export function resumeTask(id: string): boolean {
  return (
    db.prepare("UPDATE scheduled_tasks SET status = 'active' WHERE id = ?").run(id).changes > 0
  )
}

export function getTask(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined
}

export function updateTask(id: string, prompt: string, schedule: string, nextRun: number): boolean {
  return db.prepare('UPDATE scheduled_tasks SET prompt = ?, schedule = ?, next_run = ? WHERE id = ?').run(prompt, schedule, nextRun, id).changes > 0
}

// --- Kanban ---

export interface KanbanCard {
  id: string
  // Stable running number derived from the SQLite rowid (insertion order, never
  // reused) -- a human-friendly "#N" shown next to the 8-char hex id.
  seq?: number
  title: string
  description: string | null
  status: 'planned' | 'in_progress' | 'waiting' | 'testing' | 'done'
  assignee: string | null
  priority: 'low' | 'normal' | 'high' | 'urgent'
  project: string | null
  parent_id: string | null
  due_date: number | null
  sort_order: number
  created_at: number
  updated_at: number
  archived_at: number | null
  // Set the first time the card is moved to in_progress and the assigned agent
  // is woken (kanban -> agent dispatch). NULL = never dispatched; the once-only
  // guard so re-dragging a card does not re-prompt the agent.
  dispatched_at: number | null
}

export interface KanbanComment {
  id: number
  card_id: string
  author: string
  content: string
  created_at: number
}

export interface KanbanLineComment {
  id: number
  card_id: string
  sha: string
  file: string
  line: number
  author: string
  content: string
  created_at: number
}

export function listKanbanCards(): KanbanCard[] {
  const archiveDays = Number(getEffectiveSettingValue('KANBAN_ARCHIVE_DONE_DAYS'))
  const archiveCutoff = Math.floor(Date.now() / 1000) - archiveDays * 86400
  // Auto-archive done cards older than KANBAN_ARCHIVE_DONE_DAYS days
  db.prepare(
    "UPDATE kanban_cards SET archived_at = ? WHERE status = 'done' AND archived_at IS NULL AND updated_at < ?"
  ).run(Math.floor(Date.now() / 1000), archiveCutoff)
  return db
    .prepare('SELECT rowid AS seq, * FROM kanban_cards WHERE archived_at IS NULL ORDER BY sort_order ASC')
    .all() as KanbanCard[]
}

export function getKanbanCard(id: string): KanbanCard | undefined {
  return db.prepare('SELECT rowid AS seq, * FROM kanban_cards WHERE id = ?').get(id) as KanbanCard | undefined
}

/** All non-archived in_progress cards for one assignee. Card 900178fa: used to tell a genuine
 *  card SWITCH apart from a re-dispatch of the same card (caller excludes the card in question). */
export function getInProgressCardsForAssignee(assignee: string): KanbanCard[] {
  return db
    .prepare("SELECT rowid AS seq, * FROM kanban_cards WHERE archived_at IS NULL AND status = 'in_progress' AND assignee = ?")
    .all(assignee) as KanbanCard[]
}

/**
 * The card this actor most recently moved to in_progress, EXCLUDING the just-inserted event for
 * the move currently being processed (card 5003f37e). Relies on moveKanbanCard's INSERT into
 * kanban_card_events already having happened synchronously, earlier in the SAME request, than this
 * call -- true for every caller in this codebase (a single synchronous better-sqlite3 connection,
 * so no other writer can land a competing row in between). null means no PRIOR in_progress move by
 * this actor exists at all (first-ever pickup).
 */
export function priorInProgressCardForActor(actor: string): string | null {
  const row = db
    .prepare(
      `SELECT card_id FROM kanban_card_events WHERE to_status = 'in_progress' AND actor = ?
       ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET 1`,
    )
    .get(actor) as { card_id: string } | undefined
  return row?.card_id ?? null
}

export interface PendingSelfAdvanceClear {
  agent_id: string
  card_id: string
  set_at: number
}

/** Records that `agentId` owes itself a /clear before its next real work (card 5003f37e). One row
 *  per agent: a later call before the first clear lands just overwrites card_id/set_at. */
export function setPendingSelfAdvanceClear(agentId: string, cardId: string, nowMs: number): void {
  db.prepare(
    `INSERT INTO agent_pending_clear (agent_id, card_id, set_at) VALUES (?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET card_id = excluded.card_id, set_at = excluded.set_at`,
  ).run(agentId, cardId, nowMs)
}

export function getPendingSelfAdvanceClears(): PendingSelfAdvanceClear[] {
  return db.prepare('SELECT agent_id, card_id, set_at FROM agent_pending_clear').all() as PendingSelfAdvanceClear[]
}

/** Clears the debt only if it still names `cardId` -- a newer switch may have overwritten it
 *  between the watcher reading the row and delivering the /clear, in which case the debt for that
 *  newer switch must survive. Returns true iff this call actually removed a row. */
export function clearPendingSelfAdvanceClear(agentId: string, cardId: string): boolean {
  return db.prepare('DELETE FROM agent_pending_clear WHERE agent_id = ? AND card_id = ?').run(agentId, cardId).changes > 0
}

/** How far up a parent chain one stamp will walk. The fleet's own decomposition rule is four levels
 *  (Phase -> Task -> subtask -> step); 16 is slack, not a target, and the limit exists so a malformed
 *  chain cannot spin. */
const ANCESTOR_DEPTH_LIMIT = 16

/**
 * Stamp `updated_at` up the whole parent chain (adopted from upstream, card 4b03a88d).
 *
 * WHY THE FORK NEEDS THIS, measured on the live board while taking this card: phase card 607254fb
 * read as 4.7 HOURS stale while one of its children had been touched 1 minute earlier and another 11
 * minutes earlier. That is not cosmetic -- working rule 3 detects a stuck card from `updated_at`, and
 * the orchestrator acted on exactly this reading, judging the lane idle while it was mid-task. A
 * parent whose children are moving is not stale, and until now nothing said so.
 *
 * Cycle- and depth-guarded: `parent_id` is editable through the API, so a looping or runaway chain is
 * reachable input rather than a theoretical worry. Both cases stop and warn instead of throwing -- a
 * bad edge must not take down the write that triggered the stamp.
 */
function touchAncestorChain(parentId: string | null | undefined, now: number, startedAt: string): void {
  if (!parentId) return // root card: the common case, and it costs nothing
  const readParent = db.prepare('SELECT parent_id FROM kanban_cards WHERE id = ?')
  const stamp = db.prepare('UPDATE kanban_cards SET updated_at = ? WHERE id = ?')
  const seen = new Set<string>([startedAt])
  let current: string | null = parentId
  let depth = 0
  while (current) {
    if (seen.has(current)) {
      logger.warn({ cycleAt: current, from: startedAt }, 'kanban: parent_id cycle -- ancestor stamping stopped')
      return
    }
    if (++depth > ANCESTOR_DEPTH_LIMIT) {
      logger.warn({ from: startedAt, limit: ANCESTOR_DEPTH_LIMIT }, 'kanban: parent chain too deep -- ancestor stamping stopped')
      return
    }
    seen.add(current)
    stamp.run(now, current)
    current = (readParent.get(current) as { parent_id: string | null } | undefined)?.parent_id ?? null
  }
}

/** Look the card's parent up and stamp from there -- for call sites that already wrote the card row
 *  and do not otherwise need its parent_id. */
function touchAncestorsOf(cardId: string, now: number): void {
  const row = db.prepare('SELECT parent_id FROM kanban_cards WHERE id=?').get(cardId) as { parent_id: string | null } | undefined
  touchAncestorChain(row?.parent_id, now, cardId)
}

export function createKanbanCard(card: {
  id: string
  title: string
  description?: string
  status?: KanbanCard['status']
  assignee?: string
  priority?: KanbanCard['priority']
  project?: string
  parent_id?: string
  due_date?: number
}): void {
  const now = Math.floor(Date.now() / 1000)
  const status = card.status ?? 'planned'
  const maxRow = db.prepare(
    'SELECT MAX(sort_order) as m FROM kanban_cards WHERE status = ? AND archived_at IS NULL'
  ).get(status) as { m: number | null }
  const sortOrder = (maxRow?.m ?? -1) + 1

  db.prepare(
    `INSERT INTO kanban_cards (id, title, description, status, assignee, priority, project, parent_id, due_date, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    card.id, card.title, card.description ?? null, status,
    card.assignee ?? null, card.priority ?? 'normal',
    card.project ?? null, card.parent_id ?? null, card.due_date ?? null, sortOrder, now, now
  )
  touchAncestorChain(card.parent_id, now, card.id)
  // Card 6cd61430: a new card can already state its pair and its parent.
  noteRelations(cardEdges({ id: card.id, description: card.description, parent_id: card.parent_id }))
}

/**
 * The last signal a card carries in its comments:
 *   'review'  -- the author reported the work done and nothing has judged it yet;
 *   'verdict' -- a gate answered after that REVIEW (PASS/GO or FAIL/NO-GO);
 *   'none'    -- neither.
 *
 * Used by {@link reviewedCardBlocksInProgress}: a card sitting on an unanswered REVIEW must not be
 * yanked back into in_progress, but one that has been FAILED (or passed) may legitimately move.
 */
/** Authors whose PASS/FAIL/GO/NO-GO counts as a gate verdict -- the same set the gate-scan scripts
 *  filter on. The orchestrator is deliberately NOT here (card c4f2de32, Cybered): MikroB's routine
 *  tiering sentence ("DONE csak QA PASS + Cybersec GO") reads exactly like a verdict, so counting it
 *  would silently switch the guard off for that card and bring the churn straight back. Nor is the
 *  card's own author -- a "REVIEW ... tests PASS" must not clear its own review. */
const GATE_AUTHORS = ['qa', 'qa2', 'cybersec', 'cybersec2', 'cybered']

/** A verdict is ANCHORED at the start of the comment (card c4f2de32, Cybersec NO-GO). Matching
 *  anywhere in the opening 200 characters let a passing MENTION of a verdict -- "the paired card got
 *  its GO", a progress note written after the QA PASS -- clear the guard. */
const VERDICT_HEAD_RE = /^\W*(?:\[[^\]]{0,32}\]\s*)?(?:[A-Z][A-Z0-9_-]{0,16}\s+){0,3}(PASS|FAIL|GO|NO-GO)\b/i

/** Comments the offload script posts on the card automatically. They are 7B free text, so a phrase
 *  inside one must never decide whether a workflow control holds (same class as the 3307b428
 *  draft-guard finding). Skipped before any classification. */
const DRAFT_MARKER_RE = /^\W*(\[)?LOCAL[- ]?LLM/i

function isDraftComment(content: string): boolean {
  return DRAFT_MARKER_RE.test((content || '').trimStart())
}

function firstLine(content: string): string {
  return (content || '').trim().split('\n')[0] ?? ''
}

/**
 * The last signal a card carries in its comments:
 *   'review'  -- the author reported the work done and no GATE has judged it since;
 *   'verdict' -- a gate answered after that REVIEW (PASS/GO or FAIL/NO-GO);
 *   'none'    -- neither exists.
 *
 * Each class is looked up on its OWN (newest REVIEW, newest gate verdict) rather than scanned in a
 * fixed window (card c4f2de32, Cybersec NO-GO): with a 20-comment window, a chatty card pushed its
 * own REVIEW out of view and the guard stopped seeing it -- comment volume must not decide whether a
 * control holds.
 */
export function latestKanbanSignal(cardId: string): 'review' | 'verdict' | 'none' {
  const rows = db.prepare(
    'SELECT id, author, content FROM kanban_comments WHERE card_id = ? ORDER BY id DESC'
  ).all(cardId) as { id: number; author: string; content: string }[]

  let lastReviewId = 0
  let lastVerdictId = 0
  for (const r of rows) {
    if (isDraftComment(r.content)) continue
    const head = firstLine(r.content)
    const author = (r.author || '').toLowerCase()
    if (lastVerdictId === 0 && GATE_AUTHORS.includes(author) && VERDICT_HEAD_RE.test(head)) {
      lastVerdictId = r.id
    }
    if (lastReviewId === 0 && /^\W*REVIEW\b/i.test(head)) lastReviewId = r.id
    if (lastReviewId !== 0 && lastVerdictId !== 0) break
  }

  if (lastReviewId === 0 && lastVerdictId === 0) return 'none'
  return lastVerdictId > lastReviewId ? 'verdict' : 'review'
}

/**
 * True when moving `id` to `in_progress` would re-open work that is finished and waiting to be
 * judged (card c4f2de32).
 *
 * The failure this prevents, seen three times in one afternoon: a card sits at waiting with a
 * REVIEW comment and a commit, something flips it back to in_progress, and the next agent to look
 * at the board sees "in progress, no movement" and rebuilds work that already exists. A gate FAIL
 * is the legitimate way back into in_progress -- and that leaves a verdict comment, which is
 * exactly what distinguishes the two cases.
 */
export function reviewedCardBlocksInProgress(id: string, nextStatus: string): boolean {
  if (nextStatus !== 'in_progress') return false
  const current = (db.prepare('SELECT status FROM kanban_cards WHERE id=?').get(id) as { status: string } | undefined)?.status
  if (current !== 'waiting') return false
  // FAIL-CLOSED (card c4f2de32, Cybersec NO-GO): only a gate verdict newer than the last REVIEW
  // opens the way back. An unclassifiable card blocks too -- a waiting card whose comments say
  // nothing is exactly the case where re-opening it silently is most likely to be a mistake, and
  // `force` (recorded as such) is the deliberate way through.
  return latestKanbanSignal(id) !== 'verdict'
}

/**
 * The unmet predecessors that BLOCK a transition, or [] when it may proceed (card a8aa9ae5).
 *
 * ONE PREDICATE, EVERY WRITER. The enforcement lives in moveKanbanCard and updateKanbanCard rather
 * than in the HTTP handlers, because there are THREE doors into a status change -- PUT
 * /api/kanban/:id, POST /api/kanban/:id/move, and the scheduler's direct moveKanbanCard() call in
 * this file -- and a route-level guard sees two of them. The routes still call this to build the
 * 409 body; they get the same answer because it is the same function, not a second copy.
 *
 * BOTH DIRECTIONS ARE GUARDED (in_progress AND done), per Peti: the dependency has to be met for
 * the work to be COMPLETED, not merely to be started. `waiting` is deliberately NOT guarded -- a
 * builder must be able to hand finished work to a gate; the block lands at the close.
 */
export function dependencyBlockers(id: string, nextStatus: string): KanbanCard[] {
  if (nextStatus !== 'in_progress' && nextStatus !== 'done') return []
  return getUnmetKanbanPredecessors(id)
}

/**
 * Update a card's fields. A status change made THROUGH THIS PATH is audited like a move
 * ({@link moveKanbanCard}) instead of silently rewriting the column: an unaudited status write is
 * how a waiting+REVIEW card kept reappearing as in_progress with nothing in kanban_card_events to
 * show for it (card c4f2de32).
 *
 * Returns false and changes NOTHING when the status change is blocked by
 * {@link reviewedCardBlocksInProgress} -- pass `force` for the rare deliberate override.
 */
export function updateKanbanCard(
  id: string,
  fields: Partial<Omit<KanbanCard, 'id' | 'created_at'>>,
  opts?: { actor?: string; force?: boolean }
): boolean {
  const card = getKanbanCard(id)
  if (!card) return false
  const statusChanges = fields.status !== undefined && fields.status !== card.status
  const blocked = statusChanges && reviewedCardBlocksInProgress(id, fields.status as string)
  if (blocked && !opts?.force) return false
  // Card a8aa9ae5: an unmet predecessor blocks the same two transitions here as everywhere else.
  // Card a8aa9ae5 / Cybersec F-1: `force` alone is NOT the bypass -- the three sibling guards on
  // this state machine all require an allowlisted actor with it, and the one place that did not
  // (newDevStop, before 31cc1cd4) was abused. `force` without an actor is now just a refusal.
  const depBlocked = statusChanges && dependencyBlockers(id, fields.status as string).length > 0
  if (depBlocked && !isForceActor(opts?.force === true, opts?.actor)) return false
  // `forced` records only whether THIS transition actually needed the reviewed-card-reopen
  // override -- an ordinary in_progress move that happens to carry `force:true` (e.g. an exempt
  // agent's client always sends it) is not itself a guard override and must not read as one; see
  // the sibling fix in moveKanbanCard (kanban-review-guard.test.ts pins the same contract there).
  const forcedFlag = blocked || depBlocked ? 1 : 0
  const now = Math.floor(Date.now() / 1000)
  const f = { ...card, ...fields, updated_at: now }
  const changed = db.prepare(
    `UPDATE kanban_cards SET title=?, description=?, status=?, assignee=?, priority=?, project=?, parent_id=?, due_date=?, sort_order=?, updated_at=?, archived_at=?
     WHERE id=?`
  ).run(f.title, f.description, f.status, f.assignee, f.priority, f.project, f.parent_id, f.due_date, f.sort_order, f.updated_at, f.archived_at, id).changes > 0
  if (changed && statusChanges) {
    db.prepare(
      'INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at, forced) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, card.status, f.status, opts?.actor ?? null, now, forcedFlag)
  }
  if (changed) {
    touchAncestorChain(f.parent_id, now, id)
    // A re-parent leaves the OLD chain stale too: that subtree just lost a child, which is a change
    // to it even though no row beneath it was written.
    if (card.parent_id && card.parent_id !== f.parent_id) touchAncestorChain(card.parent_id, now, id)
  }
  if (changed) recordKanbanFieldChanges(id, card, f, opts?.actor, now)
  // Card 6cd61430: an edit can ADD a Pair-* line or a parent. It can also REMOVE one, and this
  // insert-only path cannot see that -- reconcileKanbanRelations() is what deletes the stale edge,
  // which is why the sweep is a reconcile and not a backfill.
  if (changed) noteRelations(cardEdges({ id, description: f.description, parent_id: f.parent_id }))
  return changed
}

/** The fields whose changes are audited here. `status` is excluded because kanban_card_events
 *  already owns it, and `updated_at` because it changes on every write and would say nothing. */
const AUDITED_CARD_FIELDS = [
  'title',
  'description',
  'assignee',
  'priority',
  'project',
  'parent_id',
  'due_date',
  'archived_at',
] as const

/** `sort_order` is deliberately NOT audited: a drag inside a column rewrites it on every card that
 *  shifted, so auditing it would bury the edits somebody actually wants to find under reordering
 *  noise. The question this table exists to answer is "who changed what this card SAYS". */
/** How much of a changed value the trail keeps (card 7fd6dd23, Cybersec F-3).
 *
 *  `title` and `description` are free text, so without a cap this table would keep EVERY past
 *  version of a long description for ever, and the endpoint hands them back. Two consequences the
 *  parent card did not consider: unbounded growth, and text that an editor removed from a card
 *  living on in the audit unless it is deleted in TWO places.
 *
 *  A cap, not a hash: a hash bounds the growth and destroys the only thing the row is for --
 *  telling a reader WHAT it used to say. 500 characters answers "who put the [50%] there", which
 *  is the question this table exists for, and a truncated tail is marked so nobody reads a cut
 *  value as the whole one. The two-place-deletion point stays TRUE and is documented rather than
 *  pretended away -- it is inherent to keeping any history at all. */
export const FIELD_AUDIT_VALUE_MAX = 500

function clipAuditValue(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v)
  return s.length <= FIELD_AUDIT_VALUE_MAX ? s : `${s.slice(0, FIELD_AUDIT_VALUE_MAX)}…[levágva]`
}

function recordKanbanFieldChanges(
  id: string,
  before: KanbanCard,
  after: KanbanCard,
  actor: string | undefined,
  nowMs: number,
): void {
  const stmt = db.prepare(
    'INSERT INTO kanban_card_field_events (card_id, field, old_value, new_value, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (const field of AUDITED_CARD_FIELDS) {
    const a = (before as unknown as Record<string, unknown>)[field]
    const b = (after as unknown as Record<string, unknown>)[field]
    if (a === b) continue
    stmt.run(id, field, clipAuditValue(a), clipAuditValue(b), actor ?? null, nowMs)
  }
}

/** One audited field change. Used by the paths that write a column with their own UPDATE and so
 *  never pass through updateKanbanCard's comparison loop. */
function recordKanbanFieldEvent(
  cardId: string,
  field: string,
  oldValue: string | null,
  newValue: string | null,
  actor: string | undefined,
  nowMs: number,
): void {
  db.prepare(
    'INSERT INTO kanban_card_field_events (card_id, field, old_value, new_value, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(cardId, field, clipAuditValue(oldValue), clipAuditValue(newValue), actor ?? null, nowMs)
}

export interface KanbanCardFieldEvent {
  readonly id: number
  readonly card_id: string
  readonly field: string
  readonly old_value: string | null
  readonly new_value: string | null
  readonly actor: string | null
  readonly created_at: number
}

/** Who changed what on this card, oldest first. The consumer is whoever has to answer "where did
 *  this come from" after the fact -- the question nobody could answer on 8d673233. */
export function getKanbanCardFieldEvents(cardId: string): KanbanCardFieldEvent[] {
  return db
    .prepare('SELECT * FROM kanban_card_field_events WHERE card_id = ? ORDER BY created_at ASC, id ASC')
    .all(cardId) as KanbanCardFieldEvent[]
}

export function getChildCards(parentId: string): KanbanCard[] {
  return db.prepare('SELECT * FROM kanban_cards WHERE parent_id = ? AND archived_at IS NULL ORDER BY sort_order ASC').all(parentId) as KanbanCard[]
}

export function moveKanbanCard(id: string, status: KanbanCard['status'], sortOrder: number, actor?: string, force?: boolean): boolean {
  const now = Math.floor(Date.now() / 1000)
  // Card c4f2de32: a card waiting on an unanswered REVIEW is finished work, not stalled work --
  // pulling it back to in_progress is what made other agents rebuild it. A gate FAIL leaves a
  // verdict comment and is allowed through; `force` covers a deliberate human override.
  const forcedOverride = reviewedCardBlocksInProgress(id, status)
  if (forcedOverride && !force) return false
  // Read the previous status first so we only record an audit event on a real
  // status transition (not a pure sort_order reorder within the same column).
  const prev = (db.prepare('SELECT status FROM kanban_cards WHERE id=?').get(id) as { status: string } | undefined)?.status
  // Card a8aa9ae5. Gated on a REAL transition, not on the target status alone: this function is
  // also the reorder path, so an unchanged status must stay writable. Otherwise a card already in
  // in_progress with an open predecessor could never be dragged within its own column.
  const depBlocked = prev !== undefined && prev !== status && dependencyBlockers(id, status).length > 0
  // Card a8aa9ae5 / Cybersec F-1: the bypass is force AND an allowlisted actor, like every sibling
  // guard on this state machine. A bare force:true from an unnamed caller does not open it.
  if (depBlocked && !isForceActor(force === true, actor)) return false
  // dispatched_at guards ONE in_progress spell (one activation -> one wake-up message), it is not a
  // permanent tombstone. Nothing used to clear it, so a card pulled to in_progress and put BACK
  // (planned/waiting) burned its dispatch forever: the board showed it alive while the next pull
  // woke nobody. Clearing it on every move that does not land in in_progress re-arms the next
  // activation -- and heals a row already stuck this way, since the clear does not depend on the
  // previous status.
  const changed = db.prepare(
    status === 'in_progress'
      ? 'UPDATE kanban_cards SET status=?, sort_order=?, updated_at=? WHERE id=?'
      : 'UPDATE kanban_cards SET status=?, sort_order=?, updated_at=?, dispatched_at=NULL WHERE id=?'
  ).run(status, sortOrder, now, id).changes > 0
  if (changed && prev !== undefined && prev !== status) {
    // `forced` records only whether THIS transition actually needed the reviewed-card-reopen
    // override -- an ordinary move that happens to carry `force:true` (e.g. an exempt agent's
    // client always sends it) is not itself a guard override and must not read as one; a caller
    // that wants the newDevStop route-layer bypass in the audit trail records that separately.
    db.prepare(
      'INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at, forced) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, prev, status, actor ?? null, now, forcedOverride || depBlocked ? 1 : 0)
  }
  if (changed) touchAncestorsOf(id, now)
  return changed
}

// Stamp the once-only kanban -> agent dispatch guard. Returns false if the
// card id does not exist.
export function markKanbanCardDispatched(id: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare('UPDATE kanban_cards SET dispatched_at=? WHERE id=?').run(now, id).changes > 0
}

export type ArchiveKanbanCardResult =
  | { ok: true }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'already-archived' }
  | { ok: false; reason: 'open-children'; openChildren: string[] }

// Card 037277a0 (onaudit finding 317b39f7): archiving used to ignore children entirely -- a
// parent could be archived while non-done children still pointed parent_id at it, orphaning
// them from every parent-based summary/dispatch view with no signal that it happened. Refuses
// by default when open (non-done) children exist; `force` is the deliberate override (matches
// the force+actor convention already used for card moves elsewhere in this file/route).
export function archiveKanbanCard(id: string, opts?: { force?: boolean; actor?: string }): ArchiveKanbanCardResult {
  const openChildren = getChildCards(id).filter(c => c.status !== 'done').map(c => c.id)
  if (openChildren.length > 0 && !opts?.force) {
    return { ok: false, reason: 'open-children', openChildren }
  }
  const now = Math.floor(Date.now() / 1000)
  // `AND archived_at IS NULL` mirrors the sibling unarchive below (card 394fb5ce, Cybersec L-1).
  // Without it, archiving an ALREADY archived card overwrote the original archival timestamp --
  // the one fact the column exists to record -- and wrote a second audit row claiming null -> T,
  // i.e. that the card had not been archived before. It had, and the row that said when was just
  // replaced by the row denying it.
  const changed = db.prepare('UPDATE kanban_cards SET archived_at=?, updated_at=? WHERE id=? AND archived_at IS NULL').run(now, now, id).changes > 0
  // Card 7fd6dd23, Cybersec F-1: `archived_at` was DECLARED in the audited-field list and could
  // never fire, because this function writes the column with its own UPDATE and nobody reaches it
  // through updateKanbanCard. A declared-but-unreachable audit field claims coverage it does not
  // have -- worse than an honest gap, because a reader stops looking. It writes its own row now,
  // and takes an actor so the row can name somebody.
  if (changed) {
    recordKanbanFieldEvent(id, 'archived_at', null, String(now), opts?.actor, now)
    return { ok: true }
  }
  // Nothing changed, and the two reasons are not the same answer: reporting 'not-found' for a card
  // that is sitting right there in the archive sends the reader looking for a sync bug (the exact
  // wrong-diagnosis loop card ebf7d95c is about). The caller decides what an idempotent re-archive
  // should mean; this only refuses to guess.
  const row = db.prepare('SELECT archived_at FROM kanban_cards WHERE id=?').get(id) as { archived_at: number | null } | undefined
  if (row === undefined) return { ok: false, reason: 'not-found' }
  return { ok: false, reason: 'already-archived' }
}

export function unarchiveKanbanCard(id: string, opts?: { actor?: string }): boolean {
  const now = Math.floor(Date.now() / 1000)
  const prev = (db.prepare('SELECT archived_at FROM kanban_cards WHERE id=?').get(id) as { archived_at: number | null } | undefined)?.archived_at
  const changed = db.prepare('UPDATE kanban_cards SET archived_at=NULL, updated_at=? WHERE id=? AND archived_at IS NOT NULL').run(now, id).changes > 0
  if (changed) recordKanbanFieldEvent(id, 'archived_at', prev === null || prev === undefined ? null : String(prev), null, opts?.actor, now)
  return changed
}

export interface ArchivedKanbanCard {
  id: string
  title: string
  status: string
  project: string | null
  priority: string
  assignee: string | null
  archived_at: number
  updated_at: number
}

export function listArchivedKanbanCards(opts: {
  q?: string
  project?: string
  label?: string
  from?: number
  to?: number
  limit: number
}): ArchivedKanbanCard[] {
  const { q, project, label, from, to, limit } = opts
  let sql = `
    SELECT DISTINCT kc.id, kc.title, kc.status, kc.project, kc.priority, kc.assignee, kc.archived_at, kc.updated_at
    FROM kanban_cards kc
  `
  const params: unknown[] = []
  if (label) {
    sql += `
      JOIN kanban_card_labels kcl ON kcl.card_id = kc.id
      JOIN labels l ON l.id = kcl.label_id AND l.name = ?
    `
    params.push(label)
  }
  sql += ' WHERE kc.archived_at IS NOT NULL'
  if (project) { sql += ' AND kc.project = ?'; params.push(project) }
  if (from)    { sql += ' AND kc.archived_at >= ?'; params.push(from) }
  if (to)      { sql += ' AND kc.archived_at <= ?'; params.push(to) }
  if (q) {
    sql += ' AND (kc.title LIKE ? OR kc.project LIKE ? OR kc.assignee LIKE ?)'
    const like = `%${q}%`
    params.push(like, like, like)
  }
  sql += ' ORDER BY kc.archived_at DESC LIMIT ?'
  params.push(limit)
  return db.prepare(sql).all(...params) as ArchivedKanbanCard[]
}

export function listKanbanProjects(): string[] {
  const rows = db.prepare(
    "SELECT DISTINCT project FROM kanban_cards WHERE project IS NOT NULL AND project != '' AND archived_at IS NULL ORDER BY project"
  ).all() as Array<{ project: string }>
  return rows.map(r => r.project)
}

export function deleteKanbanCard(id: string, actor?: string): boolean {
  // Wrapped in a transaction to ensure atomicity: all mutations succeed
  // together or none of them do. Steps in FK-safe order:
  //   1. Delete comments that reference this card (FK: kanban_comments.card_id).
  //   2. Delete this card's label associations (FK: kanban_card_labels.card_id)
  //      -- the labels themselves stay in the registry, only the link goes.
  //   3. Null-out child cards that reference this card as their parent
  //      (FK: kanban_cards.parent_id). Setting parent_id = NULL keeps the
  //      children alive as root-level cards rather than leaving them with a
  //      dangling reference. kanban_cards.parent_id carries no REFERENCES
  //      clause at all (unlike kanban_dependencies below), so this step is not
  //      about FK enforcement either way -- the dangling parent_id is a data
  //      bug regardless: orphaned children do not appear under any parent and
  //      are invisible in hierarchy views.
  //   4. Delete every dependency edge touching this card, in BOTH directions
  //      (card 2bb82943), AND audit every successor it unblocks (card
  //      d3f8d2c3, Cybered): a successor that was blocked by this card
  //      becomes unblocked because the requirement is GONE, not because it
  //      was met, and that silent unblock deserves the same kind of audit
  //      trail a `force` bypass already gets -- see recordKanbanFieldEvent
  //      below. FK enforcement on kanban_dependencies IS on for this app's
  //      own better-sqlite3 connection (measured 1, corrected 2026-08-23 --
  //      see the CREATE TABLE comment above), so this DELETE is not optional
  //      belt-and-braces: without it, deleting a card with a live edge would
  //      fail outright. A dangling edge is still reachable, though, from an
  //      agent writing SQL directly with FKs off (sqlite3 CLI/python default).
  //   5. Delete the card itself.
  return db.transaction((cardId: string, deleteActor: string | undefined, nowMs: number) => {
    db.prepare('DELETE FROM kanban_comments WHERE card_id = ?').run(cardId)
    db.prepare('DELETE FROM kanban_line_comments WHERE card_id = ?').run(cardId)
    db.prepare('DELETE FROM kanban_card_labels WHERE card_id = ?').run(cardId)
    db.prepare('UPDATE kanban_cards SET parent_id = NULL WHERE parent_id = ?').run(cardId)
    // AUDIT the unblock BEFORE cutting the edges (card d3f8d2c3, Cybered): a `force` bypass of the
    // dependency guard writes an audited row (kanban_card_events.forced); deleting the predecessor
    // achieved the SAME outcome -- the successor proceeds without its requirement being met -- with
    // NOTHING recorded on either card. One row per successor this deletion unblocks, so a later
    // reader of getKanbanCardFieldEvents(successorId) can see WHY it stopped being blocked.
    const successors = db
      .prepare('SELECT from_card_id AS id FROM kanban_dependencies WHERE to_card_id = ?')
      .all(cardId) as { id: string }[]
    for (const { id: successorId } of successors) {
      recordKanbanFieldEvent(successorId, 'predecessor_removed', cardId, null, deleteActor, nowMs)
    }
    db.prepare('DELETE FROM kanban_dependencies WHERE from_card_id = ? OR to_card_id = ?').run(cardId, cardId)
    // Card 9d7a247a: relation edges on BOTH sides, but only where the END IS A CARD -- a row whose
    // other end is a file path or a sha is not this card's to delete, and card ids are short hex,
    // so a bare id comparison would collide with one. kanban_relations carries no
    // REFERENCES (see its CREATE TABLE), so nothing forces this: without it the relation query
    // endpoint would serve edges pointing at a card that no longer exists.
    db
      .prepare(
        "DELETE FROM kanban_relations WHERE (from_type = 'card' AND from_id = ?) OR (to_type = 'card' AND to_id = ?)",
      )
      .run(cardId, cardId)
    return db.prepare('DELETE FROM kanban_cards WHERE id = ?').run(cardId).changes > 0
  })(id, actor, Math.floor(Date.now() / 1000)) as boolean
}

// --- Relation extraction (card 6cd61430) ----------------------------------------------------
//
// The write side of kanban_relations for everything derived from the fleet's existing markers.
// The rules themselves live in kanban-relations.ts and are pure; this file only decides WHEN they
// run and what happens when they fail.

/** Write extracted edges. INSERT OR IGNORE, so re-running is a no-op rather than a duplicate --
 *  the guarantee sits in the table's 5-part PRIMARY KEY (card 9d7a247a), not in a caller's care.
 *  Returns how many rows were actually new. */
function writeRelationEdges(
  edges: readonly RelationEdge[],
  now: number,
  source: string = MARKER_SOURCE,
): number {
  if (edges.length === 0) return 0
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO kanban_relations
       (from_type, from_id, to_type, to_id, relation_type, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  let inserted = 0
  for (const e of edges) {
    inserted += stmt.run(e.from_type, e.from_id, e.to_type, e.to_id, e.relation_type, source, now)
      .changes
  }
  return inserted
}

/**
 * The live half of "folyamatos beszuras": run the extractor after a card or comment is written.
 *
 * ISOLATED FROM ITS CALLER ON PURPOSE, and this is the one judgement call in the file worth
 * arguing. kanban_relations carries a trigger that ABORTS on relation_type 'blocks' (card
 * 9d7a247a) -- a RAISE(ABORT) raised inside addKanbanComment's write would take the COMMENT down
 * with it. The extractor never emits 'blocks', so this should never fire; the isolation is for the
 * class, not the instance. The asymmetry decides it: kanban_relations is a DERIVED index that
 * reconcileKanbanRelations() recomputes from scratch, so a dropped edge heals on the next sweep,
 * while a refused REVIEW comment does not heal at all and the fleet's whole gate flow runs on
 * those comments. Logged at warn, never swallowed silently.
 */
function noteRelations(edges: readonly RelationEdge[]): void {
  try {
    writeRelationEdges(dedupeEdges(edges), Math.floor(Date.now() / 1000))
  } catch (err) {
    logger.warn({ err }, 'kanban_relations: live extraction failed (the reconcile sweep will heal it)')
  }
}

export interface ReconcileRelationsReport {
  readonly scannedCards: number
  readonly scannedComments: number
  /** Distinct edges the corpus states right now. */
  readonly edges: number
  /** Edges the corpus states that the table does not hold yet. */
  readonly missing: number
  /** `source='marker-v1'` rows the corpus no longer states. */
  readonly stale: number
  /** Whether the two counts above were actually written. False on a dry run.
   *
   *  The counts are reported EITHER WAY, deliberately: a dry run whose report reads 0/0 because
   *  nothing was written tells the operator nothing about what --yes would do, which is the only
   *  question a dry run exists to answer. */
  readonly applied: boolean
}

/**
 * Full recompute of every `source='marker-v1'` edge: insert what the corpus states and is missing,
 * DELETE what the table holds and the corpus no longer states.
 *
 * A RECONCILE RATHER THAN A BACKFILL, for two failures an insert-only pass cannot reach, neither
 * of them hypothetical:
 *   - ORDER. Rule 8a has the backend card name its `Pair-FE:` partner, and the two cards are
 *     opened together -- but nothing guarantees the partner exists when the first one is written.
 *     A one-shot live hook that only fires on write would miss that edge permanently.
 *   - EDITS. Correct a mistyped `Pair-FE:`, or re-parent a card, and the insert-only pass adds the
 *     new edge and leaves the old one next to it. `parent_id` is materialised here precisely
 *     because this sweep makes that safe: the derived copy cannot drift from the column for longer
 *     than one sweep.
 *
 * Only `source='marker-v1'` rows are considered on the delete side, so a hand-inserted edge under
 * any other source is never touched by this.
 *
 * `apply: false` computes and reports without writing -- the default for the CLI, because a tool
 * that deletes rows on a bare invocation is a foot-gun in a fleet where agents run scripts out of
 * card text.
 */
export function reconcileKanbanRelations(opts?: { apply?: boolean }): ReconcileRelationsReport {
  const cards = db
    .prepare('SELECT id, description, parent_id FROM kanban_cards')
    .all() as RelationSourceCard[]
  const comments = db
    .prepare('SELECT card_id, content FROM kanban_comments')
    .all() as { card_id: string; content: string }[]

  const wanted: RelationEdge[] = []
  for (const card of cards) wanted.push(...cardEdges(card))
  for (const c of comments) wanted.push(...commentEdges(c.card_id, c.content))

  return {
    ...reconcileRelationSource(MARKER_SOURCE, wanted, opts),
    scannedCards: cards.length,
    scannedComments: comments.length,
  }
}

/**
 * The reconcile itself, for ONE `source` tag: make the table's rows under that tag equal `wanted`.
 * Insert what is missing, DELETE what the caller no longer states, touch nothing under any other
 * source.
 *
 * Split out of reconcileKanbanRelations (card 1f1e3ae4) because the git-derived sweep needs the
 * exact same insert-and-delete mechanics under its own tag. Two copies of "reconcile a source"
 * would be two chances to get the delete predicate subtly different -- and the delete side is the
 * half that can lose data.
 *
 * The caller may pass duplicates; they are collapsed here on the table's PRIMARY KEY identity.
 */
export function reconcileRelationSource(
  source: string,
  wanted: readonly RelationEdge[],
  opts?: { apply?: boolean },
): Omit<ReconcileRelationsReport, 'scannedCards' | 'scannedComments'> {
  const apply = opts?.apply === true
  const deduped = dedupeEdges(wanted)
  const wantedKeys = new Set(deduped.map(edgeKey))

  const existing = db
    .prepare(
      `SELECT from_type, from_id, to_type, to_id, relation_type
         FROM kanban_relations WHERE source = ?`,
    )
    .all(source) as RelationEdge[]
  const existingKeys = new Set(existing.map(edgeKey))
  const missing = deduped.filter((e) => !existingKeys.has(edgeKey(e)))
  const stale = existing.filter((e) => !wantedKeys.has(edgeKey(e)))

  if (apply && (missing.length > 0 || stale.length > 0)) {
    const now = Math.floor(Date.now() / 1000)
    db.transaction(() => {
      writeRelationEdges(missing, now, source)
      const del = db.prepare(
        `DELETE FROM kanban_relations
          WHERE source = ? AND from_type = ? AND from_id = ? AND to_type = ? AND to_id = ?
            AND relation_type = ?`,
      )
      for (const e of stale) {
        del.run(source, e.from_type, e.from_id, e.to_type, e.to_id, e.relation_type)
      }
    })()
  }

  return {
    edges: deduped.length,
    missing: missing.length,
    stale: stale.length,
    applied: apply,
  }
}

/** Every distinct sha the marker extraction currently points a `gate-sha` edge at -- the input the
 *  git sweep (card 1f1e3ae4) resolves to files. Read from the TABLE rather than re-parsed from the
 *  comments, so the two hops are keyed on exactly the same strings and the join cannot miss. */
export function gateShaTargets(): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT to_id FROM kanban_relations
          WHERE relation_type = ? AND to_type = ? ORDER BY to_id`,
      )
      .all(REL_GATE_SHA, NODE_SHA) as { to_id: string }[]
  ).map((r) => r.to_id)
}

// --- Relation queries (card 69396b63, FELADAT 3/4) ------------------------------------------
//
// The READ side of kanban_relations. Three questions, and the third is why this is not a single
// row filter: "which cards touched file X" is TWO hops (card -gate-sha-> sha -touches-file-> file),
// so a caller given only a row filter would fetch the shas and then issue one request per sha --
// the N+1 this file already refuses elsewhere, against 4919 file edges.

/** The columns a caller may filter on. An ALLOWLIST because the name reaches the SQL as a COLUMN,
 *  where a placeholder cannot stand in for it -- and because a filter that is accepted and then
 *  ignored is the defect card 37ea2f96 documented (the caller trusts it and reads the wrong set).
 *  Values are always bound, never interpolated. */
export const RELATION_FILTER_COLUMNS = [
  'from_type',
  'from_id',
  'to_type',
  'to_id',
  'relation_type',
  'source',
] as const
export type RelationFilterColumn = (typeof RELATION_FILTER_COLUMNS)[number]

export interface RelationRow extends RelationEdge {
  readonly source: string
  readonly created_at: number
}

export interface RelationQuery {
  readonly filters?: Partial<Record<RelationFilterColumn, readonly string[]>>
  readonly limit: number
  readonly offset: number
}

export interface RelationQueryResult {
  /** The count BEFORE limit/offset -- what the filter actually matches. */
  readonly total: number
  readonly limit: number
  readonly offset: number
  readonly edges: RelationRow[]
}

/** Rows matching the filters, bounded. `total` is the unbounded count, so a caller can tell "this
 *  is everything" apart from "this is the first page" without a second request. */
export function queryKanbanRelations(q: RelationQuery): RelationQueryResult {
  const where: string[] = []
  const params: string[] = []
  for (const column of RELATION_FILTER_COLUMNS) {
    const values = q.filters?.[column]
    if (!values || values.length === 0) continue
    where.push(`${column} IN (${values.map(() => '?').join(', ')})`)
    params.push(...values)
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM kanban_relations${clause}`).get(...params) as { n: number }
  ).n
  // ORDER BY the PRIMARY KEY prefix: a stable total order, so `offset` pages over a fixed sequence
  // rather than whatever order the planner happens to produce for a given filter.
  const edges = db
    .prepare(
      `SELECT from_type, from_id, to_type, to_id, relation_type, source, created_at
         FROM kanban_relations${clause}
        ORDER BY from_type, from_id, to_type, to_id, relation_type
        LIMIT ? OFFSET ?`,
    )
    .all(...params, q.limit, q.offset) as RelationRow[]
  return { total, limit: q.limit, offset: q.offset, edges }
}

export interface CardTouchingFile {
  readonly id: string
  /** Null when the edge names a card the board no longer holds. Reported rather than dropped:
   *  deleteKanbanCard sweeps card-ended edges (card 9d7a247a), so a null here is a real anomaly
   *  worth seeing, and silently filtering it would hide it. */
  readonly title: string | null
  readonly status: string | null
  readonly assignee: string | null
  readonly project: string | null
  /** The gate-shas of THIS card that touch the file, as stated. */
  readonly shas: string[]
}

export interface CardsTouchingFileResult {
  readonly file: string
  readonly shaCount: number
  readonly cardCount: number
  readonly cards: CardTouchingFile[]
}

/** Which cards touched a file -- the question the whole relation layer exists to answer.
 *
 *  `file` is the REPO-QUALIFIED id ("marveen:src/db.ts"), because both repos have a README.md and
 *  a package.json -- a bare path would fuse two projects' cards into one answer.
 *
 *  ON THE PLAN, measured rather than assumed (8284 live edges, 2026-09-02): SQLite serves this from
 *  the PRIMARY KEY's covering index in both loops -- NOT from idx_kanban_relations_to, even though
 *  the file hop matches that index's three columns exactly. The reason is that the join also needs
 *  `from_id`, which that index does not carry, so the PK index wins on coverage. Left alone at
 *  0.6 ms/query: forcing the other order with CROSS JOIN was MEASURED at 3.3 ms, five times worse,
 *  so the planner's choice is the right one and an index hint here would be a pessimisation. */
export function cardsTouchingFile(file: string): CardsTouchingFileResult {
  const rows = db
    .prepare(
      `SELECT gate.from_id AS card_id, touch.from_id AS sha,
              c.title AS title, c.status AS status, c.assignee AS assignee, c.project AS project
         FROM kanban_relations touch
         JOIN kanban_relations gate
           ON gate.to_type = ? AND gate.to_id = touch.from_id
          AND gate.relation_type = ? AND gate.from_type = ?
    LEFT JOIN kanban_cards c ON c.id = gate.from_id
        WHERE touch.to_type = ? AND touch.to_id = ? AND touch.relation_type = ?
          AND touch.from_type = ?
        ORDER BY gate.from_id, touch.from_id`,
    )
    .all(NODE_SHA, REL_GATE_SHA, NODE_CARD, NODE_FILE, file, REL_TOUCHES_FILE, NODE_SHA) as {
    card_id: string
    sha: string
    title: string | null
    status: string | null
    assignee: string | null
    project: string | null
  }[]

  const byCard = new Map<string, CardTouchingFile & { shas: string[] }>()
  const shas = new Set<string>()
  for (const r of rows) {
    shas.add(r.sha)
    let card = byCard.get(r.card_id)
    if (!card) {
      card = {
        id: r.card_id,
        title: r.title,
        status: r.status,
        assignee: r.assignee,
        project: r.project,
        shas: [],
      }
      byCard.set(r.card_id, card)
    }
    if (!card.shas.includes(r.sha)) card.shas.push(r.sha)
  }
  const cards = [...byCard.values()]
  return { file, shaCount: shas.size, cardCount: cards.length, cards }
}

export interface FileTouchedByCard {
  /** The stored, repo-qualified id -- what a follow-up query on this endpoint takes back. */
  readonly id: string
  readonly repo: string | null
  readonly path: string
  readonly shas: string[]
}

export interface FilesTouchedByCardResult {
  readonly card: string
  readonly shaCount: number
  readonly fileCount: number
  /** Every sha the card states, INCLUDING ones that resolved to no file (a sha git could not find,
   *  or one whose commit touched nothing this sweep saw). Without them a card whose shas are all
   *  unresolvable is indistinguishable from a card that states none. */
  readonly shas: string[]
  readonly files: FileTouchedByCard[]
}

/** Which files a card touched, through the shas its comments stated. The mirror of
 *  {@link cardsTouchingFile}, and the same measured plan: the PK covering index on both loops,
 *  1.7 ms for the busiest card on the board today (27 files). */
export function filesTouchedByCard(cardId: string): FilesTouchedByCardResult {
  const stated = (
    db
      .prepare(
        `SELECT DISTINCT to_id FROM kanban_relations
          WHERE from_type = ? AND from_id = ? AND relation_type = ? AND to_type = ?
          ORDER BY to_id`,
      )
      .all(NODE_CARD, cardId, REL_GATE_SHA, NODE_SHA) as { to_id: string }[]
  ).map((r) => r.to_id)

  const rows = db
    .prepare(
      `SELECT touch.to_id AS file, gate.to_id AS sha
         FROM kanban_relations gate
         JOIN kanban_relations touch
           ON touch.from_type = ? AND touch.from_id = gate.to_id AND touch.relation_type = ?
          AND touch.to_type = ?
        WHERE gate.from_type = ? AND gate.from_id = ? AND gate.relation_type = ?
          AND gate.to_type = ?
        ORDER BY touch.to_id, gate.to_id`,
    )
    .all(NODE_SHA, REL_TOUCHES_FILE, NODE_FILE, NODE_CARD, cardId, REL_GATE_SHA, NODE_SHA) as {
    file: string
    sha: string
  }[]

  const byFile = new Map<string, FileTouchedByCard & { shas: string[] }>()
  for (const r of rows) {
    let file = byFile.get(r.file)
    if (!file) {
      const { repo, path } = parseQualifiedPath(r.file)
      file = { id: r.file, repo, path, shas: [] }
      byFile.set(r.file, file)
    }
    if (!file.shas.includes(r.sha)) file.shas.push(r.sha)
  }
  const files = [...byFile.values()]
  return { card: cardId, shaCount: stated.length, fileCount: files.length, shas: stated, files }
}

// --- Card dependencies (card 2bb82943) ------------------------------------------------------

/** Why an edge was refused. `ok` carries no reason. */
export type AddDependencyResult =
  | { ok: true }
  | { ok: false; reason: 'self' }
  | { ok: false; reason: 'not-found'; missing: string }
  | { ok: false; reason: 'cycle'; path: string[] }
  | { ok: false; reason: 'duplicate' }

/**
 * Would adding `from -> to` ("from is blocked by to") close a loop? It does exactly when `from` is
 * ALREADY reachable from `to` by following predecessors, i.e. to depends on ... depends on from.
 *
 * TRANSITIVE, not just the A<->B pair, and that is the point: a two-card check would let A->B,
 * B->C, C->A through, and the result is worse than a rejected edge -- every card in the loop
 * blocks every other one, so the status guard can never pass and only `force` gets anyone out.
 * The recursion is bounded by UNION (not UNION ALL), which stops on a node already seen, so an
 * ALREADY-cyclic table cannot hang this query either.
 */
function predecessorClosure(startId: string): string[] {
  return (
    db
      .prepare(
        `WITH RECURSIVE reach(id) AS (
           SELECT to_card_id FROM kanban_dependencies WHERE from_card_id = ?
           UNION
           SELECT d.to_card_id FROM kanban_dependencies d JOIN reach r ON d.from_card_id = r.id
         )
         SELECT id FROM reach`,
      )
      .all(startId) as { id: string }[]
  ).map((r) => r.id)
}

/** Add "fromCardId depends on toCardId". Refuses self-edges, unknown cards, duplicates and cycles. */
export function addKanbanDependency(fromCardId: string, toCardId: string): AddDependencyResult {
  if (fromCardId === toCardId) return { ok: false, reason: 'self' }
  if (!getKanbanCard(fromCardId)) return { ok: false, reason: 'not-found', missing: fromCardId }
  if (!getKanbanCard(toCardId)) return { ok: false, reason: 'not-found', missing: toCardId }
  const closure = predecessorClosure(toCardId)
  if (closure.includes(fromCardId)) return { ok: false, reason: 'cycle', path: closure }
  const now = Math.floor(Date.now() / 1000)
  const changes = db
    .prepare('INSERT OR IGNORE INTO kanban_dependencies (from_card_id, to_card_id, created_at) VALUES (?, ?, ?)')
    .run(fromCardId, toCardId, now).changes
  return changes > 0 ? { ok: true } : { ok: false, reason: 'duplicate' }
}

export function removeKanbanDependency(fromCardId: string, toCardId: string): boolean {
  return (
    db
      .prepare('DELETE FROM kanban_dependencies WHERE from_card_id = ? AND to_card_id = ?')
      .run(fromCardId, toCardId).changes > 0
  )
}

/** The status a dangling edge reports. NOT a real card status -- it exists so a predecessor that
 *  cannot be resolved is visibly unresolved rather than quietly absent. */
export const MISSING_PREDECESSOR_STATUS = 'missing'

/**
 * A dependency row whose predecessor cannot be found (card 37c5605a, Cybered F-2).
 *
 * An INNER JOIN drops such a row, and dropping it is FAIL-OPEN: the edge still exists, the card is
 * still marked as depending on something, and the guard would report "nothing blocks you". A
 * predecessor we cannot resolve is an UNKNOWN state, and unknown must block -- the alternative is a
 * silent unblock that nobody can see. Rendered with the id in the title so a human can go look.
 */
function missingPredecessor(id: string): KanbanCard {
  return {
    id,
    title: `(hiányzó kártya: ${id})`,
    status: MISSING_PREDECESSOR_STATUS,
  } as unknown as KanbanCard
}

/** Drop the join-only `dep_id` column so it never travels out as part of a card object. Written
 *  as a delete rather than a `{ dep_id: _unused, ...rest }` destructure because the lint rule here
 *  counts that binding as unused however it is named. */
function withoutDepId(row: Record<string, unknown>): KanbanCard {
  const card = { ...row }
  delete card['dep_id']
  return card as unknown as KanbanCard
}

/** The cards THIS card is waiting for. A predecessor that no longer exists is reported as missing,
 *  never omitted -- see missingPredecessor(). */
export function getKanbanPredecessors(cardId: string): KanbanCard[] {
  const rows = db
    .prepare(
      `SELECT d.to_card_id AS dep_id, c.* FROM kanban_dependencies d
         LEFT JOIN kanban_cards c ON c.id = d.to_card_id
        WHERE d.from_card_id = ? ORDER BY c.status, c.sort_order ASC`,
    )
    .all(cardId) as (Partial<KanbanCard> & { dep_id: string })[]
  return rows.map((r) => (r.id === null || r.id === undefined ? missingPredecessor(r.dep_id) : withoutDepId(r)))
}

/** The cards waiting for THIS card. */
export function getKanbanSuccessors(cardId: string): KanbanCard[] {
  return db
    .prepare(
      `SELECT c.* FROM kanban_dependencies d JOIN kanban_cards c ON c.id = d.from_card_id
        WHERE d.to_card_id = ? ORDER BY c.status, c.sort_order ASC`,
    )
    .all(cardId) as KanbanCard[]
}

/**
 * The predecessors that are NOT satisfied yet -- the list the status guard refuses on, and the list
 * the board shows as "blocked by".
 *
 * SATISFIED MEANS `status = 'done'`, AND NOTHING ELSE. The plan said "done OR archived", on the
 * premise that archiving only ever happens to done cards. That premise holds for the AUTOMATIC
 * sweep (db.ts: `UPDATE ... SET archived_at = ? WHERE status = 'done' AND ...`) but NOT for the
 * manual one: archiveKanbanCard() checks only that the card's CHILDREN are done and never looks at
 * the card's own status, so `POST /api/kanban/:id/archive` archives a `planned` leaf happily. Under
 * "done OR archived" that single unauthenticated-by-force call would silently satisfy a dependency
 * nobody finished -- a one-call bypass of this whole guard, with no force flag and no audit row.
 *
 * Reading `status` alone loses nothing the plan wanted: archiving does not change `status`, so an
 * auto-archived predecessor still reads `done` here and still counts.
 */
export function getUnmetKanbanPredecessors(cardId: string): KanbanCard[] {
  return getKanbanPredecessors(cardId).filter((c) => c.status !== 'done')
}

/**
 * Every card's UNMET predecessors, in ONE query (card 38788337).
 *
 * The board list returns the whole board, so asking per card would be an N+1 over a few hundred
 * rows on every dashboard poll. Same reason and same shape as getLabelsForAllCards, which the list
 * handler already uses for exactly this. Cards with no unmet predecessor are simply absent from
 * the map -- the caller treats a missing key as "not blocked".
 *
 * "Unmet" is `status <> 'done'`, the same rule getUnmetKanbanPredecessors applies, for the reason
 * written there: archiving does not change `status`, and archiving a card is NOT a way to satisfy
 * a dependency nobody finished.
 */
export function getUnmetPredecessorsForAllCards(): Map<string, KanbanCard[]> {
  // LEFT JOIN and an explicit `c.id IS NULL` arm, for the reason spelled out on
  // missingPredecessor(): an INNER JOIN would DROP an edge pointing at a card that is gone, which
  // reads as "not blocked" -- fail-open. Unknown blocks.
  const rows = db
    .prepare(
      `SELECT d.from_card_id AS blocked_id, d.to_card_id AS dep_id, c.*
         FROM kanban_dependencies d
         LEFT JOIN kanban_cards c ON c.id = d.to_card_id
        WHERE c.id IS NULL OR c.status <> 'done'
        ORDER BY c.status, c.sort_order ASC`,
    )
    .all() as (Partial<KanbanCard> & { blocked_id: string; dep_id: string })[]
  const out = new Map<string, KanbanCard[]>()
  for (const row of rows) {
    const { blocked_id: blockedId, dep_id: depId, ...rest } = row
    const card = rest.id === null || rest.id === undefined ? missingPredecessor(depId) : (rest as KanbanCard)
    const list = out.get(blockedId)
    if (list) list.push(card)
    else out.set(blockedId, [card])
  }
  return out
}

export function getKanbanComments(cardId: string): KanbanComment[] {
  return db.prepare('SELECT * FROM kanban_comments WHERE card_id = ? ORDER BY created_at ASC').all(cardId) as KanbanComment[]
}

export function addKanbanLineComment(
  cardId: string,
  sha: string,
  file: string,
  line: number,
  author: string,
  content: string,
): KanbanLineComment {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    'INSERT INTO kanban_line_comments (card_id, sha, file, line, author, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(cardId, sha, file, line, author, content, now)
  db.prepare('UPDATE kanban_cards SET updated_at = ? WHERE id = ?').run(now, cardId)
  touchAncestorsOf(cardId, now)
  return { id: Number(info.lastInsertRowid), card_id: cardId, sha, file, line, author, content, created_at: now }
}

// `sha` narrows to one commit's diff (the common case: a gate reviewing one Gate-SHA); omitted
// returns every line comment ever recorded on the card, across every sha it has been reviewed at.
export function getKanbanLineComments(cardId: string, sha?: string): KanbanLineComment[] {
  if (sha) {
    return db.prepare(
      'SELECT * FROM kanban_line_comments WHERE card_id = ? AND sha = ? ORDER BY created_at ASC'
    ).all(cardId, sha) as KanbanLineComment[]
  }
  return db.prepare(
    'SELECT * FROM kanban_line_comments WHERE card_id = ? ORDER BY created_at ASC'
  ).all(cardId) as KanbanLineComment[]
}

export interface KanbanCardEvent {
  id: number
  card_id: string
  from_status: string | null
  to_status: string
  actor: string | null
  created_at: number
  /** 1 when the transition only happened because the caller passed `force` past the
   *  reviewed-card guard (card c4f2de32). 0 for every ordinary move. */
  forced: number
}

export function getKanbanCardEvents(cardId: string): KanbanCardEvent[] {
  return db.prepare('SELECT * FROM kanban_card_events WHERE card_id = ? ORDER BY created_at ASC, id ASC').all(cardId) as KanbanCardEvent[]
}

// Lookup a kanban card's `seq` (its sqlite rowid) by the 8-char hex id stored
// in `kanban_cards.id`. Used by the kanban-ref normalizer to rewrite hex
// references to the human-facing `#<seq>` form. Returns null when the prefix
// matches zero rows OR more than one row (ambiguous → leave the message
// untouched rather than guess). Case-insensitive: breakdown subtask ids are
// uppercased while createKanbanCard ids stay lowercase.
export function getKanbanSeqByIdPrefix(prefix: string): number | null {
  const rows = db.prepare(
    'SELECT rowid AS seq FROM kanban_cards WHERE id = ? COLLATE NOCASE LIMIT 2'
  ).all(prefix) as { seq: number }[]
  if (rows.length !== 1) return null
  return rows[0].seq
}

/**
 * The board's CURRENT view of one card, for the send-time state stamp (card ffaa4ff1).
 *
 * Prefix-safe like getKanbanSeqByIdPrefix: `LIMIT 2` and a rows.length !== 1 bail, so an ambiguous
 * prefix resolves to nothing rather than to whichever row SQLite happened to return first. Archived
 * cards are included on purpose -- "this card is archived" is exactly the staleness the stamp exists
 * to surface, and hiding it would make an archived card look like a live one.
 */
export function getKanbanCardStateByIdPrefix(
  prefix: string,
): { id: string; status: string; updatedAt: number } | null {
  const rows = db
    .prepare('SELECT id, status, updated_at FROM kanban_cards WHERE id = ? COLLATE NOCASE LIMIT 2')
    .all(prefix) as { id: string; status: string; updated_at: number }[]
  if (rows.length !== 1) return null
  const r = rows[0]
  return { id: r.id, status: r.status, updatedAt: r.updated_at }
}

// Find an active (non-archived) kanban card by exact title match, or
// undefined when none exists.
export function findActiveKanbanCardByTitle(title: string): KanbanCard | undefined {
  return db.prepare(
    'SELECT rowid AS seq, * FROM kanban_cards WHERE title = ? AND archived_at IS NULL LIMIT 1'
  ).get(title) as KanbanCard | undefined
}

// Move the first active kanban card whose title equals `taskName` to the
// 'waiting' status, appending it at the end of the waiting column.
// Returns the card id when a match was found and updated, null otherwise.
// Used by the scheduled-task fire-timeout watchdog when alerting about a
// potentially stuck task.
export function markScheduledTaskKanbanWaiting(taskName: string): string | null {
  const card = findActiveKanbanCardByTitle(taskName)
  if (!card) return null
  const maxResult = db.prepare(
    "SELECT MAX(sort_order) as m FROM kanban_cards WHERE status = 'waiting' AND archived_at IS NULL"
  ).get() as { m: number | null }
  const sortOrder = (maxResult.m ?? 0) + 100
  moveKanbanCard(card.id, 'waiting', sortOrder, 'scheduler')
  return card.id
}

export function addKanbanComment(cardId: string, author: string, content: string): KanbanComment {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    'INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?, ?, ?, ?)'
  ).run(cardId, author, content, now)
  db.prepare('UPDATE kanban_cards SET updated_at = ? WHERE id = ?').run(now, cardId)
  touchAncestorsOf(cardId, now)
  // Card 6cd61430: the REVIEW comment carrying `Gate-SHA:` is the fleet's most common marker, and
  // it arrives here. noteRelations cannot fail this write -- see its own comment for why that
  // isolation is deliberate rather than defensive.
  noteRelations(commentEdges(cardId, content))
  return { id: Number(info.lastInsertRowid), card_id: cardId, author, content, created_at: now }
}

// --- Kanban labels (tags) ---

export interface Label {
  id: string
  name: string
  color: string
  created_at: number
}

export function listLabels(): Label[] {
  return db.prepare('SELECT * FROM labels ORDER BY name ASC').all() as Label[]
}

export function getLabel(id: string): Label | undefined {
  return db.prepare('SELECT * FROM labels WHERE id = ?').get(id) as Label | undefined
}

export function createLabel(label: { id: string; name: string; color: string }): Label {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO labels (id, name, color, created_at) VALUES (?, ?, ?, ?)'
  ).run(label.id, label.name, label.color, now)
  return { ...label, created_at: now }
}

export function updateLabel(id: string, fields: Partial<Pick<Label, 'name' | 'color'>>): boolean {
  const label = getLabel(id)
  if (!label) return false
  const f = { ...label, ...fields }
  return db.prepare('UPDATE labels SET name=?, color=? WHERE id=?').run(f.name, f.color, id).changes > 0
}

export function deleteLabel(id: string): boolean {
  // Transaction: drop every card<->label link before the label row itself,
  // otherwise the join table keeps dangling references to a label that no
  // longer exists (FK enforcement is off by default, but the orphan rows
  // would still silently resurrect a "deleted" label in card detail views).
  return db.transaction((labelId: string) => {
    db.prepare('DELETE FROM kanban_card_labels WHERE label_id = ?').run(labelId)
    return db.prepare('DELETE FROM labels WHERE id = ?').run(labelId).changes > 0
  })(id) as boolean
}

export function addLabelToCard(cardId: string, labelId: string): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT OR IGNORE INTO kanban_card_labels (card_id, label_id, created_at) VALUES (?, ?, ?)'
  ).run(cardId, labelId, now)
}

export function removeLabelFromCard(cardId: string, labelId: string): boolean {
  return db.prepare(
    'DELETE FROM kanban_card_labels WHERE card_id = ? AND label_id = ?'
  ).run(cardId, labelId).changes > 0
}

export function getLabelsForCard(cardId: string): Label[] {
  return db.prepare(`
    SELECT l.* FROM labels l
    JOIN kanban_card_labels cl ON cl.label_id = l.id
    WHERE cl.card_id = ?
    ORDER BY l.name ASC
  `).all(cardId) as Label[]
}

// Bulk variant for the board list view -- one JOIN query instead of an N+1
// per-card lookup when rendering footer pills for every card at once.
export function getLabelsForAllCards(): Map<string, Label[]> {
  const rows = db.prepare(`
    SELECT cl.card_id AS card_id, l.id AS id, l.name AS name, l.color AS color, l.created_at AS created_at
    FROM kanban_card_labels cl
    JOIN labels l ON l.id = cl.label_id
    ORDER BY l.name ASC
  `).all() as Array<Label & { card_id: string }>
  const map = new Map<string, Label[]>()
  for (const row of rows) {
    const { card_id, ...label } = row
    const list = map.get(card_id)
    if (list) list.push(label)
    else map.set(card_id, [label])
  }
  return map
}

// --- Heartbeat helpers ---

export interface HeartbeatKanbanSummary {
  urgent: KanbanCard[]
  in_progress: KanbanCard[]
  waiting: KanbanCard[]
}

/**
 * The ONE definition of "what the heartbeat lists". Both consumers read it from
 * here: the built-in heartbeat prompt (heartbeat.ts) and the heartbeat AGENT,
 * which gets it over /api/kanban/heartbeat-summary instead of composing its own
 * query. Two hand-written copies of the same filter is how they drift apart.
 *
 * `urgent` means urgent and NOT FINISHED: priority='urgent', not archived, not
 * `done`. `planned` stays IN on purpose -- "urgent and nobody has touched it" is
 * one of the states most worth seeing, and a list that hides it would be quiet
 * for the wrong reason. (A first draft of this change narrowed it to
 * waiting/in_progress; that was withdrawn precisely because it would have hidden
 * untouched urgent work.)
 *
 * What DID have to go is closed work: on 2026-08-04 the 09:00 report listed five
 * items of which three were already `done`, and the 08-03 count was 22 done
 * against 2 waiting -- the most prominent line of an hourly report was mostly
 * finished cards, so it stopped being read. Those 22 were only reachable through
 * a hand-written query; this statement never returned them, which is why the real
 * fix is that the heartbeat agent no longer writes its own query.
 */
/** Exported so a test can execute the SHIPPED statement against a fixture DB
 *  instead of re-typing an equivalent one and proving nothing. */
export const HEARTBEAT_URGENT_SQL =
  "SELECT * FROM kanban_cards WHERE archived_at IS NULL AND priority = 'urgent' AND status != 'done'"
export const HEARTBEAT_IN_PROGRESS_SQL =
  "SELECT * FROM kanban_cards WHERE archived_at IS NULL AND status = 'in_progress'"
export const HEARTBEAT_WAITING_SQL =
  "SELECT * FROM kanban_cards WHERE archived_at IS NULL AND status = 'waiting'"

// HBKANBANDRIFT819 follow-up: the heartbeat report format asks for a planned
// line, so the number needs a sanctioned server-side source like every other
// count -- without it the agent manufactures the value (measured: planned: 0
// reported against a real 305). COUNT only: no card list is served for
// planned, the line is a bare number.
export const HEARTBEAT_PLANNED_COUNT_SQL =
  "SELECT COUNT(*) AS n FROM kanban_cards WHERE archived_at IS NULL AND status = 'planned'"

export function countPlannedKanbanCards(): number {
  const row = db.prepare(HEARTBEAT_PLANNED_COUNT_SQL).get() as { n: number } | undefined
  return row?.n ?? 0
}

export function getHeartbeatKanbanSummary(): HeartbeatKanbanSummary {
  const urgent = db.prepare(HEARTBEAT_URGENT_SQL).all() as KanbanCard[]
  const in_progress = db.prepare(HEARTBEAT_IN_PROGRESS_SQL).all() as KanbanCard[]
  const waiting = db.prepare(HEARTBEAT_WAITING_SQL).all() as KanbanCard[]
  return { urgent, in_progress, waiting }
}

/**
 * HBMEMBLIND819: the heartbeat's "new hot memories (1h)" number is computed
 * HERE, server-side, and served over /api/kanban/heartbeat-summary -- the
 * heartbeat agent copies it like the kanban counts, it never runs the query.
 *
 * This is the SECOND failure of the prescribe-the-query pattern for this
 * metric. HBMEMBLIND807 (2026-08-07): the agent composed its own SQL and
 * reported 0 beside three hot memories; the fix prescribed a ready-made query
 * with "do not rewrite the query". HBMEMBLIND819 (2026-08-19): measured
 * 14/14 rounds reporting 0 over 24h with real values of 2 in three of them --
 * the agent ran the prescribed query SHAPE but with agent_id='heartbeat'
 * substituted for the main agent's id. Timeline over 8 sessions / 196 runs:
 * the identity rewrite appears on post-compact rounds (the agent reconstructs
 * the query from memory as "count MY hot memories" instead of re-reading the
 * prescription) and then persists as its own precedent. A prescription the
 * measured party must re-copy every round is not a mechanism; the kanban
 * counts on the SAME agent never drifted, because an endpoint number has no
 * query to rewrite. Same closure as getHeartbeatKanbanSummary above.
 */
/** Exported so a test can execute the SHIPPED statement against a fixture DB
 *  instead of re-typing an equivalent one and proving nothing. */
export const HEARTBEAT_NEW_HOT_MEMORIES_SQL =
  "SELECT COUNT(*) AS n FROM memories WHERE agent_id = ? AND category = 'hot' AND created_at > unixepoch() - 3600"

export function countNewHotMemories(agentId: string): number {
  const row = db.prepare(HEARTBEAT_NEW_HOT_MEMORIES_SQL).get(agentId) as { n: number } | undefined
  return row?.n ?? 0
}

/**
 * HBDBMERET822: the heartbeat's "DB size" number is computed HERE, server-side,
 * and served over /api/kanban/heartbeat-summary -- same closure as the kanban
 * counts and countNewHotMemories above. Before this, the scaffold's template
 * had a bare `DB size: <X> MB` placeholder with no sanctioned source, so each
 * session re-invented the measurement: the format drifted round to round
 * (`158 MB` -> `160M`, a du -h shape) and on 2026-08-22 15:00 the report said
 * `0.0 MB` against a real 159 MB. A zero here is the dangerous direction --
 * the metric exists as a GROWTH signal, and a permanent 0.0 does not die
 * loudly, it just looks calm.
 *
 * Returns null (never 0) when the size cannot be measured: for ':memory:'
 * databases and on stat failure. 0 is a plausible reading; null is not --
 * the consumer renders it as "nincs adat". Same lesson as the silent
 * `catch { return 0 }` this replaces in heartbeat.ts collectSystem.
 */
export function getDbFileSizeMb(): number | null {
  if (!openedDbPath) return null
  try {
    return Math.round((statSync(openedDbPath).size / (1024 * 1024)) * 10) / 10
  } catch (err) {
    logger.warn({ err, dbPath: openedDbPath }, 'DB size stat failed; serving null, not 0')
    return null
  }
}

// --- Agent Messages ---

export interface AgentMessage {
  id: number
  from_agent: string
  to_agent: string
  content: string
  status: 'pending' | 'delivered' | 'done' | 'failed'
  result: string | null
  created_at: number
  delivered_at: number | null
  completed_at: number | null
  // Card 06f062e4: optional, self-declared attributability tag (e.g. a
  // sub-agent's own task/branch name) -- NOT an authentication mechanism,
  // see the table-creation comment. Null for every caller that doesn't pass one.
  origin_note: string | null
  // Card def5a189: distributed trace context (message-router middleware).
  trace_id: string | null
  span_id: string | null
  parent_span_id: string | null
}

export function createAgentMessage(
  from: string,
  to: string,
  content: string,
  originNote?: string | null,
  traceCtx?: { trace_id: string; span_id: string; parent_span_id: string | null } | null,
): AgentMessage {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    'INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at, origin_note, trace_id, span_id, parent_span_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(from, to, content, 'pending', now, originNote ?? null, traceCtx?.trace_id ?? null, traceCtx?.span_id ?? null, traceCtx?.parent_span_id ?? null)
  return {
    id: Number(info.lastInsertRowid),
    from_agent: from, to_agent: to, content, status: 'pending',
    result: null, created_at: now, delivered_at: null, completed_at: null,
    origin_note: originNote ?? null,
    trace_id: traceCtx?.trace_id ?? null,
    span_id: traceCtx?.span_id ?? null,
    parent_span_id: traceCtx?.parent_span_id ?? null,
  }
}

export function getPendingMessages(toAgent?: string): AgentMessage[] {
  if (toAgent) {
    return db.prepare("SELECT * FROM agent_messages WHERE status = 'pending' AND to_agent = ? ORDER BY created_at ASC")
      .all(toAgent) as AgentMessage[]
  }
  return db.prepare("SELECT * FROM agent_messages WHERE status = 'pending' ORDER BY created_at ASC")
    .all() as AgentMessage[]
}

// Status-guarded (pending only): the federation removal path bulk-fails
// pending rows CONCURRENTLY with an in-flight bridge send -- an unguarded
// UPDATE would flip such a row failed->delivered after the fact. If the row
// is no longer pending, this returns false and the caller must not record a
// result either.
export function markMessageDelivered(id: number): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare("UPDATE agent_messages SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'pending'").run(now, id).changes > 0
}

// Freshness input for the delivery annotation (adopted from upstream, card f27c999b). How many
// strictly-newer, non-failed messages the SAME sender has queued for the same recipient since this
// one. A queued message can be delivered long after it was written, describing an already-closed
// state, while the sender's newer -- current -- messages sit further down the queue; upstream
// measured that shape nearly re-executing a superseded PROD DEPLOY-GO on 2026-08-22.
//
// Deliberately distinct from this fork's own formatDeliveryStalenessNote, which asks a DIFFERENT
// question: it re-reads the kanban board for the cards the message was stamped with and reports
// which ones MOVED while it waited. One is "the world changed", the other is "the sender has since
// said more". Verified as non-overlapping before adopting; keeping both is the point.
export function countNewerMessagesFromSameSender(fromAgent: string, toAgent: string, msgId: number): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM agent_messages WHERE from_agent = ? AND to_agent = ? AND id > ? AND status != 'failed'"
  ).get(fromAgent, toAgent, msgId) as { n: number }
  return row.n
}

// Per-agent backlog: how many messages are waiting, and how old the oldest one
// is. The queue only surfaces when somebody opens a pane and notices, which is
// how an 18-row backlog went unseen on 2026-07-27 and got mistaken for data
// loss. Age matters more than count: three messages from a minute ago is a busy
// agent working normally, one message from two hours ago is an agent that is
// never going to pick it up.
export type AgentBacklog = { agent: string; pending: number; oldestAgeSeconds: number }

export function getPendingBacklogByAgent(): AgentBacklog[] {
  const now = Math.floor(Date.now() / 1000)
  const rows = db.prepare(
    `SELECT to_agent AS agent, COUNT(*) AS pending, MIN(created_at) AS oldest
       FROM agent_messages
      WHERE status = 'pending'
      GROUP BY to_agent`,
  ).all() as { agent: string; pending: number; oldest: number }[]
  return rows
    .map(r => ({ agent: r.agent, pending: r.pending, oldestAgeSeconds: Math.max(0, now - r.oldest) }))
    // oldest-first: whoever has been waiting longest is the one worth looking at
    .sort((a, b) => b.oldestAgeSeconds - a.oldestAgeSeconds)
}

/**
 * Contents of the `[session-stuck]` alerts the router has already sent about stuck agents.
 *
 * Card 1e7ba5c1 round 2 (Cybered F1): the message-backlog watcher is a SUPPLEMENT to that alert, not
 * a second channel -- `[session-stuck]` fires on the same phenomenon with strictly more information
 * (it reads the pane, so it can say busy vs idle, which the queue alone cannot). Measured: 174 of
 * them in 7 days. The backlog watcher only speaks where that one has been silent, so this is the
 * dedup input. Returning the raw text keeps the agent-name extraction in the watcher, next to the
 * test that pins it against the router's own formatter.
 */
// --- Task-event feed for the Swimlane Timeline (card a5bbfb98) ------------------------------------
//
// WHAT THE MEASUREMENT SAID, AND WHY THERE IS NO NEW TABLE. The card allowed for building an
// append-only event log if none existed, and asked to check first. Checked, on live data:
//
//   local_llm_queue  2473 rows, 2464 started / 2473 finished, task_type on 2447 -- real blocks
//   token_usage    371849 rows, model + agent + tokens, indexed (agent, timestamp)
//   otel_spans       9229 rows, but only 12 CLOSED (0.13%) and ZERO attributes
//   task_runs       22076 rows, but (name, agent, ts) only -- a firing, not a span
//
// otel_spans looked like the right source and was not: `operation` only ever holds
// `sender->recipient` for inter-agent messages, and at the time of measurement 9217 of 9229 rows
// sat in 'running' forever with no end_ms, carrying no duration, no category and no attributes.
//
// That was card dbc0b4bf, and it is now fixed at the source: the router closes each span when the
// message is DELIVERED, which is the operation the span opens and what this table's own header
// calls it (inter-agent latency). Note what the defect actually was -- the close path was never
// broken. Of the 12 traced messages that ever reached a terminal status, 12 had closed spans.
// Tracing and completion were on disjoint populations: nothing marks a tmux-injected message done,
// because there is no completion signal to observe.
//
// It still does not serve THIS endpoint. A send->deliver latency is not a task duration, and the
// `operation` column still holds only a sender->recipient pair, with no category. The timeline
// below is unchanged; this note is here so the next reader does not re-derive the same dead end.
//
// So the timeline is served from what actually holds the data, and the shape below is deliberately
// honest about the seam: local tasks HAVE real start/end blocks, online-model work has token counts
// but no per-task duration anywhere in this database. The endpoint reports that rather than
// inventing a block width.
//
// UNITS. local_llm_queue stamps MILLISECONDS (measured: 1788528687675), token_usage.timestamp and
// task_runs.ts stamp SECONDS. Mixing them silently puts blocks in 1970 or 56000 AD, so every
// boundary here converts to ms and the conversion is pinned by a test.

export interface TaskEvent {
  readonly id: number
  readonly lane: string
  readonly agent: string
  readonly category: string
  readonly startMs: number
  readonly endMs: number
  readonly durationMs: number
  readonly status: string
  readonly cardId: string | null
}

/** Finished local-LLM tasks overlapping [fromMs, toMs), oldest first. Only rows with a real
 *  start AND end become blocks -- a running task has no width yet, and guessing one would draw a
 *  block that shrinks on the next poll. */
export function getTaskEvents(fromMs: number, toMs: number, agent: string | null, limit: number): TaskEvent[] {
  const rows = db.prepare(
    `SELECT id, agent, COALESCE(task_type,'(uncategorised)') AS category,
            started_at, finished_at, status, card_id
       FROM local_llm_queue
      WHERE started_at IS NOT NULL AND finished_at IS NOT NULL
        AND finished_at > started_at
        AND started_at < ? AND finished_at >= ?
        AND (? IS NULL OR agent = ?)
      ORDER BY started_at ASC
      LIMIT ?`,
  ).all(toMs, fromMs, agent, agent, limit) as {
    id: number; agent: string; category: string; started_at: number; finished_at: number;
    status: string; card_id: string | null
  }[]
  return rows.map(r => ({
    id: r.id,
    lane: 'local',
    agent: r.agent,
    category: r.category,
    startMs: r.started_at,
    endMs: r.finished_at,
    durationMs: r.finished_at - r.started_at,
    status: r.status,
    cardId: r.card_id,
  }))
}

export interface ModelUsage {
  readonly model: string
  readonly requests: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly agents: number
}

export interface TaskSummary {
  readonly fromMs: number
  readonly toMs: number
  readonly models: ModelUsage[]
  readonly activeModels: number
  readonly taskCount: number
  readonly failedCount: number
  readonly byCategory: Record<string, number>
  readonly avgDurationMs: number | null
  /** Named seam, not decoration: which lanes can draw real blocks. A caller that assumes every
   *  model has task blocks would silently render an empty timeline and look like a bug. */
  readonly blockCoverage: { readonly lanes: string[]; readonly note: string }
}

export function getTaskSummary(fromMs: number, toMs: number): TaskSummary {
  const fromS = Math.floor(fromMs / 1000)
  const toS = Math.ceil(toMs / 1000)

  const models = db.prepare(
    `SELECT COALESCE(model,'(unreported)') AS model, COUNT(*) AS requests,
            SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
            COUNT(DISTINCT agent) AS agents
       FROM token_usage
      WHERE timestamp >= ? AND timestamp < ?
      GROUP BY 1 ORDER BY requests DESC`,
  ).all(fromS, toS) as { model: string; requests: number; inputTokens: number | null; outputTokens: number | null; agents: number }[]

  const tasks = db.prepare(
    `SELECT COALESCE(task_type,'(uncategorised)') AS category, COUNT(*) AS n,
            SUM(status = 'failed') AS failed,
            AVG(CASE WHEN finished_at > started_at THEN finished_at - started_at END) AS avgMs
       FROM local_llm_queue
      WHERE started_at IS NOT NULL AND started_at < ? AND COALESCE(finished_at, started_at) >= ?
      GROUP BY 1 ORDER BY n DESC`,
  ).all(toMs, fromMs) as { category: string; n: number; failed: number; avgMs: number | null }[]

  const byCategory: Record<string, number> = {}
  let taskCount = 0
  let failedCount = 0
  let weighted = 0
  let weightedN = 0
  for (const r of tasks) {
    byCategory[r.category] = r.n
    taskCount += r.n
    failedCount += r.failed
    if (r.avgMs !== null) { weighted += r.avgMs * r.n; weightedN += r.n }
  }

  return {
    fromMs,
    toMs,
    models: models.map(m => ({
      model: m.model,
      requests: m.requests,
      inputTokens: m.inputTokens ?? 0,
      outputTokens: m.outputTokens ?? 0,
      agents: m.agents,
    })),
    activeModels: models.length,
    taskCount,
    failedCount,
    byCategory,
    avgDurationMs: weightedN > 0 ? Math.round(weighted / weightedN) : null,
    blockCoverage: {
      lanes: ['local'],
      note: 'Only local-LLM tasks record start and end, so only the "local" lane can draw timeline blocks. Online-model work is counted and its tokens summed, but no per-task duration is stored anywhere in this database (otel_spans measures inter-agent send->deliver latency, not task work).',
    },
  }
}

export function recentStuckAlertContents(sinceEpochSeconds: number): string[] {
  const rows = db.prepare(
    `SELECT content FROM agent_messages
      WHERE from_agent = 'system' AND created_at >= ? AND content LIKE '[session-stuck]%'`,
  ).all(sinceEpochSeconds) as { content: string }[]
  return rows.map(r => r.content)
}

// Close a pending backlog that is NOT going to be delivered -- stale rows an
// operator does not want the router to replay (an old thank-you note, a legal
// warning whose content has since changed). Separate from markMessageDelivered
// because the two mean opposite things: one records that a message went out,
// this one records that it never will. Both leave a timestamp, and this one
// leaves a reason, so the log can still answer "was this actually delivered?"
// afterwards. Without it the only way to clear a backlog is raw SQL, which is
// how the queue got 24 rows claiming delivery they never had.
export function closeMessagesWithoutDelivery(ids: number[], reason: string): number {
  if (!ids.length) return 0
  const now = Math.floor(Date.now() / 1000)
  const note = `closed-without-delivery: ${reason}`
  const stmt = db.prepare(
    `UPDATE agent_messages SET status = 'delivered', delivered_at = ?, result = ?
      WHERE id = ? AND status = 'pending'`,
  )
  const run = db.transaction((rows: number[]) => {
    let n = 0
    for (const id of rows) n += stmt.run(now, note, id).changes
    return n
  })
  return run(ids)
}

// Supplementary result text WITHOUT a status change. The federation bridge
// records the peer-assigned id on delivered rows ("fed:<peer>:<remote id>")
// so a cross-system message can be traced without a schema migration.
export function setMessageResult(id: number, result: string): boolean {
  return db.prepare('UPDATE agent_messages SET result = ? WHERE id = ?').run(result, id).changes > 0
}

// Bulk-fail PENDING federated (slash-qualified to_agent) messages -- the
// deterministic counterpart of the bridge's drip-fail on disable/removal.
// ONE statement (claimPendingForAgent idiom: no SELECT-then-UPDATE window).
// pending only: delivered/done/failed rows are conversation history.
// Per-peer scoping compares the exact prefix segment via instr/substr -- a
// LIKE pattern would treat '_' in a peer id as a wildcard ('te_dor' purging
// 'teodor'). lower() on both sides: system ids are case-insensitive, and rows
// written before the lowercase normalization may carry an uppercase prefix
// that must still be purged with its peer (ASCII-only lower() is fine -- the
// id charset is [a-zA-Z0-9_-]).
export function failPendingFederatedMessages(peerId: string | undefined, reason: string): number[] {
  const now = Math.floor(Date.now() / 1000)
  const rows = peerId === undefined
    ? db.prepare(
        `UPDATE agent_messages SET status = 'failed', result = ?, completed_at = ?
           WHERE status = 'pending' AND instr(to_agent, '/') > 0
         RETURNING id`,
      ).all(reason, now) as Array<{ id: number }>
    : db.prepare(
        `UPDATE agent_messages SET status = 'failed', result = ?, completed_at = ?
           WHERE status = 'pending' AND instr(to_agent, '/') > 0
             AND lower(substr(to_agent, 1, instr(to_agent, '/') - 1)) = lower(?)
         RETURNING id`,
      ).all(reason, now, peerId) as Array<{ id: number }>
  return rows.map((r) => r.id)
}

// Atomically CLAIM (pending -> delivered) the oldest `limit` pending messages
// for an agent, returning the claimed rows. A SINGLE `UPDATE ... WHERE
// status='pending' RETURNING` (NOT a SELECT-then-UPDATE) so two concurrent
// drains can never double-claim the same message (-> no ghost double-delivery).
// Backs the main-agent inbox PULL model: the main agent drains its own inbox at
// each turn (via the drain-inbox endpoint + UserPromptSubmit hook) instead of
// the router tmux-injecting into its perpetually-busy channel session.
export function claimPendingForAgent(toAgent: string, limit: number): AgentMessage[] {
  const now = Math.floor(Date.now() / 1000)
  const rows = db.prepare(
    `UPDATE agent_messages SET status = 'delivered', delivered_at = ?
       WHERE id IN (
         SELECT id FROM agent_messages
         WHERE to_agent = ? AND status = 'pending'
         ORDER BY created_at ASC, id ASC
         LIMIT ?
       )
     RETURNING id, from_agent, to_agent, content, status, result, created_at, delivered_at, completed_at`,
  ).all(now, toAgent, limit) as AgentMessage[]
  // RETURNING row order is unspecified; restore FIFO (created_at, then id as the
  // tiebreaker for same-second inserts) for delivery.
  return rows.sort((a, b) => (a.created_at - b.created_at) || (a.id - b.id))
}

export function markMessageDone(id: number, result?: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  // COALESCE: some done-transitions skip the delivered step entirely (e.g. a
  // still-pending row marked done directly via PUT), so backfill delivered_at
  // only when it was never set -- don't clobber a real earlier delivery time.
  return db.prepare("UPDATE agent_messages SET status = 'done', result = ?, completed_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE id = ?").run(result ?? null, now, now, id).changes > 0
}

export function markMessageFailed(id: number, error?: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare("UPDATE agent_messages SET status = 'failed', result = ?, completed_at = ? WHERE id = ?").run(error ?? null, now, id).changes > 0
}

// Status-guarded fail for the federation bridge's terminal branches: it must
// only fire (and only bounce a failure notice) when THIS call actually closed
// a still-pending row. The unguarded markMessageFailed above would also
// "succeed" on a row a concurrent disable/removal purge already failed
// (result/completed_at change -> changes>0), producing a spurious second
// notice. The drain-inbox path deliberately keeps the unguarded variant (it
// fails an already-delivered row).
export function markPendingFederatedFailed(id: number, error: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare("UPDATE agent_messages SET status = 'failed', result = ?, completed_at = ? WHERE id = ? AND status = 'pending'").run(error, now, id).changes > 0
}

export function listAgentMessages(limit = 50): AgentMessage[] {
  return db.prepare('SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT ?').all(limit) as AgentMessage[]
}

// --- Context-restart gate helpers -------------------------------------------

export interface DispatchedPendingStats {
  /** Count of messages sent by fromAgent with status pending|delivered, within staleCutoffMs. */
  count: number
  /** Any messages sent by fromAgent that WOULD have blocked but are beyond staleCutoffMs. */
  hasStale: boolean
}

/**
 * Check how many outbound messages this agent dispatched that have not yet
 * received a result (status pending or delivered), separating live (within
 * staleCutoffMs) from stale (beyond it). Used by the context-restart gate.
 *
 * Completion reports are excluded. Closing an inbound message auto-creates an
 * `[Eredmény] msg_id:<n> status:<s>` message back to the sender (see the PUT
 * /api/messages/:id route, which uses this same prefix to avoid ping-pong).
 * Those are notifications, not dispatched work: nobody is expected to answer
 * them, and they are never marked done, so they accumulate. Counting them made
 * a busy agent permanently ineligible for a soft restart -- on 2026-08-12 the
 * gate reported 11 blocking messages for the main agent and several were its
 * own acknowledgements.
 */
export const COMPLETION_REPORT_PREFIX = '[Eredmény]'

export function getDispatchedPendingStats(
  fromAgent: string,
  nowMs: number,
  staleCutoffMs: number,
): DispatchedPendingStats {
  const cutoffEpoch = Math.floor((nowMs - staleCutoffMs) / 1000)
  // Bound parameter, not interpolation: the prefix contains no LIKE wildcards
  // today, but a future edit adding one would silently widen the exclusion.
  const ackPattern = `${COMPLETION_REPORT_PREFIX}%`
  const liveRow = db.prepare(
    `SELECT COUNT(*) AS cnt FROM agent_messages
       WHERE from_agent = ? AND status IN ('pending','delivered')
         AND content NOT LIKE ?
         AND CAST(created_at AS INTEGER) > ?`,
  ).get(fromAgent, ackPattern, cutoffEpoch) as { cnt: number }
  const staleRow = db.prepare(
    `SELECT COUNT(*) AS cnt FROM agent_messages
       WHERE from_agent = ? AND status IN ('pending','delivered')
         AND content NOT LIKE ?
         AND CAST(created_at AS INTEGER) <= ?`,
  ).get(fromAgent, ackPattern, cutoffEpoch) as { cnt: number }
  return {
    count:    liveRow?.cnt ?? 0,
    hasStale: (staleRow?.cnt ?? 0) > 0,
  }
}

/**
 * True when the agent's last inbound channel message has no later outbound
 * (unanswered question). Used by the context-restart gate.
 */
export function hasOpenInboundQuestion(agentId: string): boolean {
  const row = db.prepare(
    `SELECT id, created_at FROM conversation_log
       WHERE agent_id = ? AND direction = 'in'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(agentId) as { id: number; created_at: number } | undefined
  if (!row) return false
  const laterOut = db.prepare(
    `SELECT 1 FROM conversation_log
       WHERE agent_id = ? AND direction = 'out'
         AND (created_at > ? OR (created_at = ? AND id > ?))
       LIMIT 1`,
  ).get(agentId, row.created_at, row.created_at, row.id)
  return !laterOut
}

// System/automation participants that are not real conversation peers. They are
// excluded as THREAD rows in the dashboard sidebar (you don't chat with the
// heartbeat or the coordinator), but messages involving them still count toward
// the human/agent peer they are paired with (so a thread's count matches what
// getAgentConversation returns when you open it).
export const CHAT_SYSTEM_AGENTS = ['heartbeat', 'telegram-coordinator', 'channel-coordinator', 'system'] as const

const AGENT_MESSAGE_LIMIT_CAP = 200

// The actual last-N messages for ONE agent, filtered in SQL (NOT global-last-N
// then JS-filter -- that starved rarely-active agents' threads, dashboard bug
// 2026-06-03). `beforeId` pages older: pass the oldest id you already have to
// fetch the next-older batch (scroll-up pagination). Newest-first.
export function getAgentConversation(agent: string, limit = 50, beforeId?: number): AgentMessage[] {
  const cap = Math.min(Math.max(1, Math.floor(limit) || 1), AGENT_MESSAGE_LIMIT_CAP)
  if (beforeId !== undefined && Number.isFinite(beforeId)) {
    return db.prepare(
      'SELECT * FROM agent_messages WHERE (from_agent = ? OR to_agent = ?) AND id < ? ORDER BY created_at DESC, id DESC LIMIT ?'
    ).all(agent, agent, beforeId, cap) as AgentMessage[]
  }
  return db.prepare(
    'SELECT * FROM agent_messages WHERE (from_agent = ? OR to_agent = ?) ORDER BY created_at DESC, id DESC LIMIT ?'
  ).all(agent, agent, cap) as AgentMessage[]
}

export interface AgentThread {
  agent: string
  count: number
  lastMessage: AgentMessage | null
}

// One row per distinct conversation peer (from_agent OR to_agent), excluding
// CHAT_SYSTEM_AGENTS, each with its total message count and its most-recent
// message. Drives the dashboard sidebar. Recency is computed per-peer (max
// created_at) so a rarely-active peer's last message is never hidden behind the
// global recency window (the bug the JS-filter path had). Sorted newest-first.
export function getAgentConversationThreads(): AgentThread[] {
  const parties = db.prepare(`
    WITH parties AS (
      SELECT from_agent AS agent FROM agent_messages
      UNION
      SELECT to_agent AS agent FROM agent_messages
    )
    SELECT p.agent AS agent,
      (SELECT COUNT(*) FROM agent_messages m WHERE m.from_agent = p.agent OR m.to_agent = p.agent) AS count
    FROM parties p
  `).all() as { agent: string; count: number }[]

  const lastStmt = db.prepare(
    'SELECT * FROM agent_messages WHERE from_agent = ? OR to_agent = ? ORDER BY created_at DESC, id DESC LIMIT 1'
  )

  const system = new Set<string>(CHAT_SYSTEM_AGENTS)
  const threads: AgentThread[] = []
  for (const p of parties) {
    if (!p.agent || system.has(p.agent)) continue
    const lastMessage = (lastStmt.get(p.agent, p.agent) as AgentMessage | undefined) ?? null
    threads.push({ agent: p.agent, count: p.count, lastMessage })
  }
  threads.sort((a, b) => {
    const ca = a.lastMessage?.created_at ?? 0
    const cb = b.lastMessage?.created_at ?? 0
    if (cb !== ca) return cb - ca
    return (b.lastMessage?.id ?? 0) - (a.lastMessage?.id ?? 0) // tiebreak: newest id first
  })
  return threads
}

// --- Task Run History ---

export interface TaskRunEntry { name: string; agent: string; ts: number; status: string }

export interface TaskRunHistoryEntry { ts: number; status: string; tokens_est: number | null }

const TASK_RUN_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function appendTaskRun(name: string, agent: string, status = 'fired'): void {
  const now = Date.now()
  db.prepare('INSERT INTO task_runs (name, agent, ts, status) VALUES (?, ?, ?, ?)').run(name, agent, now, status)
  // Opportunistic TTL prune: cheap indexed DELETE, keeps the table bounded.
  db.prepare('DELETE FROM task_runs WHERE ts < ?').run(now - TASK_RUN_TTL_MS)
}

export function listTaskRunHistory(name: string, limit: number): TaskRunHistoryEntry[] {
  const rows = db.prepare(
    'SELECT ts, status, agent FROM task_runs WHERE name = ? ORDER BY ts DESC LIMIT ?'
  ).all(name, limit) as { ts: number; status: string; agent: string }[]

  // token_usage.timestamp is in seconds; task_runs.ts is in ms -- divide by 1000
  const tokenStmt = db.prepare(
    `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens), 0) as total
     FROM token_usage WHERE agent = ? AND timestamp >= ? AND timestamp < ?`
  )

  // Rows are DESC (newest first). For each run, approximate token usage as
  // the sum for that agent in the window [ts, next_newer_ts) capped at 1 hour.
  return rows.map((row, i) => {
    const newerTs = i > 0 ? rows[i - 1].ts : undefined
    const windowEnd = newerTs !== undefined ? Math.min(row.ts + 3600000, newerTs) : row.ts + 3600000
    const tokenRow = tokenStmt.get(row.agent, Math.floor(row.ts / 1000), Math.floor(windowEnd / 1000)) as { total: number }
    return { ts: row.ts, status: row.status, tokens_est: tokenRow.total > 0 ? tokenRow.total : null }
  })
}

export function countTaskRunsBetween(fromTs: number, toTs?: number): number {
  if (toTs === undefined) {
    const row = db.prepare('SELECT COUNT(*) as c FROM task_runs WHERE ts >= ?').get(fromTs) as { c: number }
    return row.c
  }
  const row = db.prepare('SELECT COUNT(*) as c FROM task_runs WHERE ts >= ? AND ts < ?').get(fromTs, toTs) as { c: number }
  return row.c
}

export function getAgentMessage(id: number): AgentMessage | undefined {
  return db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as AgentMessage | undefined
}

export function getActiveScheduledTaskCount(): { count: number; nextRun: number | null } {
  const row = db
    .prepare("SELECT COUNT(*) as count, MIN(next_run) as next_run FROM scheduled_tasks WHERE status = 'active'")
    .get() as { count: number; next_run: number | null }
  return { count: row.count, nextRun: row.next_run }
}

// --- Pending scheduled-task retries ------------------------------------

export interface PendingTaskRetryRow {
  id: number
  task_name: string
  agent_name: string
  first_attempt: number
  last_attempt: number
  attempt_count: number
  last_reason: string | null
  alert_sent_at: number | null
}

/**
 * Insert a busy-skipped scheduled task into the retry queue if and only if
 * no row exists for the (task_name, agent_name) pair. Returns true on
 * insert, false if a row already existed. Used for the first "busy" hit
 * from the cron loop.
 */
export function insertPendingTaskRetryIfNew(
  taskName: string,
  agentName: string,
  now: number,
  reason: string,
): boolean {
  return db.prepare(`
    INSERT OR IGNORE INTO pending_task_retries
      (task_name, agent_name, first_attempt, last_attempt, attempt_count, last_reason)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(taskName, agentName, now, now, reason).changes > 0
}

/**
 * Update an existing retry row's last_attempt / attempt_count / last_reason.
 * Returns true if a row was updated, false if none existed (e.g. the
 * operator cancelled the row between a tick loading it and this call).
 * Used from the retry loop so a cancelled row isn't silently re-created.
 */
export function updatePendingTaskRetry(
  taskName: string,
  agentName: string,
  now: number,
  reason: string,
): boolean {
  return db.prepare(`
    UPDATE pending_task_retries
       SET last_attempt = ?,
           attempt_count = attempt_count + 1,
           last_reason = ?
     WHERE task_name = ? AND agent_name = ?
  `).run(now, reason, taskName, agentName).changes > 0
}

/** Back-compat shim used by tests written against the original upsert
 * semantics. Internal code should use the explicit insert-if-new /
 * update-if-exists pair above. */
export function upsertPendingTaskRetry(
  taskName: string,
  agentName: string,
  now: number,
  reason: string,
): void {
  if (!updatePendingTaskRetry(taskName, agentName, now, reason)) {
    insertPendingTaskRetryIfNew(taskName, agentName, now, reason)
  }
}

/** Clear the alert timestamp so the next tick is free to re-alert. Used
 * when a Telegram send failed after we stamped the row optimistically. */
export function clearPendingTaskRetryAlert(taskName: string, agentName: string): boolean {
  return db
    .prepare('UPDATE pending_task_retries SET alert_sent_at = NULL WHERE task_name = ? AND agent_name = ?')
    .run(taskName, agentName).changes > 0
}

export function listPendingTaskRetries(): PendingTaskRetryRow[] {
  return db
    .prepare('SELECT * FROM pending_task_retries ORDER BY first_attempt ASC')
    .all() as PendingTaskRetryRow[]
}

export function getPendingTaskRetry(taskName: string, agentName: string): PendingTaskRetryRow | undefined {
  return db
    .prepare('SELECT * FROM pending_task_retries WHERE task_name = ? AND agent_name = ?')
    .get(taskName, agentName) as PendingTaskRetryRow | undefined
}

export function deletePendingTaskRetry(taskName: string, agentName: string): boolean {
  return db
    .prepare('DELETE FROM pending_task_retries WHERE task_name = ? AND agent_name = ?')
    .run(taskName, agentName).changes > 0
}

export function deletePendingTaskRetryById(id: number): boolean {
  return db
    .prepare('DELETE FROM pending_task_retries WHERE id = ?')
    .run(id).changes > 0
}

export function markPendingTaskRetryAlert(taskName: string, agentName: string, ts: number): boolean {
  return db
    .prepare('UPDATE pending_task_retries SET alert_sent_at = ? WHERE task_name = ? AND agent_name = ? AND alert_sent_at IS NULL')
    .run(ts, taskName, agentName).changes > 0
}

// --- Vector Search (Ollama + nomic-embed-text) ---

const EMBED_MODEL = 'nomic-embed-text'

export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 2000) }),
      signal: AbortSignal.timeout(TOOL_TIMEOUTS['ollama-embedding']),
    })
    const data = await resp.json() as { embedding?: number[] }
    return data.embedding || null
  } catch (err) {
    // Debug-level so it doesn't spam default INFO logs when Ollama isn't
    // running (the common case on most user machines). Enables "why does
    // hybrid search only return FTS results?" diagnostics without noise.
    logger.debug({ err, ollamaUrl: OLLAMA_URL }, 'Embedding generation failed (Ollama not running?)')
    return null
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

function vectorSearch(agentId: string, queryEmbedding: number[], limit: number = 10): Memory[] {
  const rows = db.prepare(
    "SELECT * FROM memories WHERE embedding IS NOT NULL AND (agent_id = ? OR category = 'shared')"
  ).all(agentId) as Memory[]

  const scored = rows.map(m => {
    try {
      const emb = JSON.parse(m.embedding!) as number[]
      return { memory: m, score: cosineSimilarity(queryEmbedding, emb) }
    } catch {
      return { memory: m, score: 0 }
    }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(s => s.memory)
}

export async function hybridSearch(agentId: string, query: string, limit: number = 10): Promise<Memory[]> {
  const k = 60 // RRF constant

  // FTS5 results
  const ftsResults = searchAgentMemories(agentId, query, limit * 2)

  // Vector results
  const queryEmbedding = await generateEmbedding(query)
  const vecResults = queryEmbedding ? vectorSearch(agentId, queryEmbedding, limit * 2) : []

  // Reciprocal Rank Fusion
  const scores: Map<number, number> = new Map()
  const byId: Map<number, Memory> = new Map()

  ftsResults.forEach((m, rank) => {
    scores.set(m.id, (scores.get(m.id) || 0) + 1 / (k + rank + 1))
    byId.set(m.id, m)
  })

  vecResults.forEach((m, rank) => {
    scores.set(m.id, (scores.get(m.id) || 0) + 1 / (k + rank + 1))
    byId.set(m.id, m)
  })

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1])
  return ranked.slice(0, limit).map(([id]) => byId.get(id)!)
}

export async function backfillEmbeddings(): Promise<number> {
  const rows = db.prepare('SELECT id, content, keywords FROM memories WHERE embedding IS NULL').all() as { id: number; content: string; keywords: string | null }[]
  let count = 0
  for (const row of rows) {
    const text = row.content + (row.keywords ? ' ' + row.keywords : '')
    const emb = await generateEmbedding(text)
    if (emb) {
      db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(JSON.stringify(emb), row.id)
      count++
    }
    // Small delay to not overwhelm Ollama
    await new Promise(r => setTimeout(r, 100))
  }
  return count
}

// --- Pending Channel Requests ---

export interface PendingChannelRequest {
  id: number
  agent: string
  channel_id: string
  channel_name: string | null
  user_id: string | null
  requested_at: number
  status: 'pending' | 'approved' | 'denied'
}

export function upsertChannelRequest(agent: string, channelId: string, userId?: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  const sevenDaysAgo = now - 7 * 86400
  const existing = db.prepare(
    "SELECT id FROM pending_channel_requests WHERE agent = ? AND channel_id = ? AND (status = 'pending' OR (status = 'denied' AND COALESCE(resolved_at, requested_at) > ?))"
  ).get(agent, channelId, sevenDaysAgo)
  if (existing) return false
  db.prepare(
    'INSERT INTO pending_channel_requests (agent, channel_id, user_id, requested_at, status) VALUES (?, ?, ?, ?, ?)'
  ).run(agent, channelId, userId ?? null, now, 'pending')
  return true
}

export function listPendingChannelRequests(agent: string): PendingChannelRequest[] {
  return db.prepare(
    "SELECT * FROM pending_channel_requests WHERE agent = ? AND status = 'pending' ORDER BY requested_at DESC"
  ).all(agent) as PendingChannelRequest[]
}

export function updateChannelRequestStatus(id: number, status: 'approved' | 'denied'): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare(
    'UPDATE pending_channel_requests SET status = ?, resolved_at = ? WHERE id = ? AND status = ?'
  ).run(status, now, id, 'pending').changes > 0
}

export function updateChannelRequestName(id: number, channelName: string): void {
  db.prepare('UPDATE pending_channel_requests SET channel_name = ? WHERE id = ?').run(channelName, id)
}


// --- Idea Box ---

export interface IdeaBoxRow {
  id: string
  title: string
  description: string | null
  category: string
  status: 'new' | 'reviewed' | 'kanban' | 'rejected'
  source: string
  kanban_id: string | null
  impact: number | null
  effort: number | null
  created_at: number
  updated_at: number
}

export function listIdeas(opts?: { status?: string; category?: string }): IdeaBoxRow[] {
  let q = 'SELECT * FROM idea_box WHERE 1=1'
  const params: string[] = []
  if (opts?.status) { q += ' AND status = ?'; params.push(opts.status) }
  if (opts?.category) { q += ' AND category = ?'; params.push(opts.category) }
  q += ' ORDER BY created_at DESC'
  return db.prepare(q).all(...params) as IdeaBoxRow[]
}

export function createIdea(idea: Omit<IdeaBoxRow, 'created_at' | 'updated_at'>): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT INTO idea_box (id, title, description, category, status, source, kanban_id, impact, effort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(idea.id, idea.title, idea.description ?? null, idea.category, idea.status, idea.source, idea.kanban_id ?? null, idea.impact ?? null, idea.effort ?? null, now, now)
}

export function updateIdea(id: string, patch: Partial<Pick<IdeaBoxRow, 'title' | 'description' | 'category' | 'status' | 'kanban_id' | 'impact' | 'effort'>>): boolean {
  const now = Math.floor(Date.now() / 1000)
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [now]
  if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title) }
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description) }
  if (patch.category !== undefined) { sets.push('category = ?'); params.push(patch.category) }
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status) }
  if (patch.kanban_id !== undefined) { sets.push('kanban_id = ?'); params.push(patch.kanban_id) }
  if (patch.impact !== undefined) { sets.push('impact = ?'); params.push(patch.impact) }
  if (patch.effort !== undefined) { sets.push('effort = ?'); params.push(patch.effort) }
  params.push(id)
  return db.prepare(`UPDATE idea_box SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0
}

export function deleteIdea(id: string): boolean {
  return db.prepare('DELETE FROM idea_box WHERE id = ?').run(id).changes > 0
}

export function listIdeaCategories(): string[] {
  return (db.prepare('SELECT DISTINCT category FROM idea_box ORDER BY category').all() as { category: string }[]).map(r => r.category)
}

// --- Idea Comments ---

export interface IdeaComment {
  id: number
  idea_id: string
  author: string
  content: string
  created_at: number
}

export function getIdeaComments(ideaId: string): IdeaComment[] {
  return db.prepare('SELECT * FROM idea_comments WHERE idea_id = ? ORDER BY created_at ASC').all(ideaId) as IdeaComment[]
}

export function addIdeaComment(ideaId: string, author: string, content: string): IdeaComment {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    'INSERT INTO idea_comments (idea_id, author, content, created_at) VALUES (?, ?, ?, ?)'
  ).run(ideaId, author, content, now)
  db.prepare('UPDATE idea_box SET updated_at = ? WHERE id = ?').run(now, ideaId)
  return { id: Number(info.lastInsertRowid), idea_id: ideaId, author, content, created_at: now }
}

// --- Idea Status Log ---

export interface IdeaStatusLogRow {
  id: number
  idea_id: string
  from_status: string | null
  to_status: string
  actor: string
  note: string | null
  created_at: number
}

export function logIdeaStatusChange(
  ideaId: string,
  fromStatus: string | null,
  toStatus: string,
  actor: string,
  note?: string,
): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO idea_status_log (idea_id, from_status, to_status, actor, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(ideaId, fromStatus ?? null, toStatus, actor, note ?? null, now)
}

export function getIdeaStatusLog(ideaId: string): IdeaStatusLogRow[] {
  return db.prepare('SELECT * FROM idea_status_log WHERE idea_id = ? ORDER BY created_at ASC').all(ideaId) as IdeaStatusLogRow[]
}

// Revert a promoted idea back to 'reviewed' when its kanban card is deleted or archived.
// Returns the idea id if a matching idea was found and reverted, null otherwise.
export function revertIdeaFromKanban(kanbanId: string): string | null {
  const idea = db.prepare("SELECT id, status FROM idea_box WHERE kanban_id = ? AND status = 'kanban'").get(kanbanId) as { id: string; status: string } | undefined
  if (!idea) return null
  const now = Math.floor(Date.now() / 1000)
  db.prepare("UPDATE idea_box SET status = 'reviewed', kanban_id = NULL, updated_at = ? WHERE id = ?").run(now, idea.id)
  logIdeaStatusChange(idea.id, 'kanban', 'reviewed', 'system', `Kanban card removed: ${kanbanId}`)
  return idea.id
}

// --- Tool Call Log ---

export function logToolCall(
  sessionId: string,
  toolName: string,
  inputSummary: string | null,
  success = true,
  agentId: string | null = null,
  traceId: string | null = null,
  durationMs: number | null = null,
): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO tool_call_log (session_id, tool_name, input_summary, success, created_at, agent_id, trace_id, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(sessionId, toolName, inputSummary, success ? 1 : 0, now, agentId, traceId, durationMs)
}

export interface ToolCallLogRow {
  id: number
  session_id: string
  tool_name: string
  input_summary: string | null
  success: number
  created_at: number
  agent_id: string | null
  trace_id: string | null
  duration_ms: number | null
}

export interface WorkflowCandidate {
  session_id: string
  tool_calls: ToolCallLogRow[]
  start_ts: number
  end_ts: number
  duration_minutes: number
}

export function getRecentToolCalls(sinceSecs: number): ToolCallLogRow[] {
  const cutoff = Math.floor(Date.now() / 1000) - sinceSecs
  return db.prepare('SELECT * FROM tool_call_log WHERE created_at >= ? ORDER BY created_at ASC').all(cutoff) as ToolCallLogRow[]
}

export function analyzeWorkflowCandidates(sinceSecs = 3600, minToolCalls = 5, gapSecs = 300): WorkflowCandidate[] {
  const calls = getRecentToolCalls(sinceSecs)
  if (calls.length === 0) return []

  // Group by session_id, then split by time gaps > gapSecs
  const bySession: Map<string, ToolCallLogRow[]> = new Map()
  for (const c of calls) {
    if (!bySession.has(c.session_id)) bySession.set(c.session_id, [])
    bySession.get(c.session_id)!.push(c)
  }

  const candidates: WorkflowCandidate[] = []
  for (const [sessionId, sessionCalls] of bySession) {
    // Split into chunks by time gap
    const chunks: ToolCallLogRow[][] = []
    let current: ToolCallLogRow[] = [sessionCalls[0]]
    for (let i = 1; i < sessionCalls.length; i++) {
      if (sessionCalls[i].created_at - sessionCalls[i - 1].created_at > gapSecs) {
        chunks.push(current)
        current = []
      }
      current.push(sessionCalls[i])
    }
    chunks.push(current)

    for (const chunk of chunks) {
      if (chunk.length >= minToolCalls) {
        candidates.push({
          session_id: sessionId,
          tool_calls: chunk,
          start_ts: chunk[0].created_at,
          end_ts: chunk[chunk.length - 1].created_at,
          duration_minutes: Math.round((chunk[chunk.length - 1].created_at - chunk[0].created_at) / 60),
        })
      }
    }
  }

  return candidates
}

export function pruneToolCallLog(olderThanSecs = 86400): void {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSecs
  db.prepare('DELETE FROM tool_call_log WHERE created_at < ?').run(cutoff)
}

// --- Skill Usage Log ---

export interface SkillUsageRow {
  id: number
  agent_id: string
  skill_name: string
  trigger_type: 'tool_call' | 'skill_read'
  session_id: string | null
  created_at: number
}

export interface SkillUsageStatRow {
  skill_name: string
  call_count: number
  read_count: number
  total_count: number
  agent_count: number
  last_used_at: number
}

export function logSkillUsage(
  agentId: string,
  skillName: string,
  triggerType: 'tool_call' | 'skill_read',
  sessionId?: string | null,
): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO skill_usage (agent_id, skill_name, trigger_type, session_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(agentId, skillName, triggerType, sessionId ?? null, now)
}

export function getSkillUsageRows(opts: {
  since?: number
  agentId?: string
  skillName?: string
  limit?: number
}): SkillUsageRow[] {
  const { since, agentId, skillName, limit = 500 } = opts
  const cutoff = since ? Math.floor(Date.now() / 1000) - since : 0
  const conditions: string[] = ['created_at >= ?']
  const params: unknown[] = [cutoff]
  if (agentId) { conditions.push('agent_id = ?'); params.push(agentId) }
  if (skillName) { conditions.push('skill_name = ?'); params.push(skillName) }
  params.push(limit)
  return db.prepare(
    `SELECT * FROM skill_usage WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
  ).all(...params) as SkillUsageRow[]
}

export function getSkillUsageStats(sinceSecs?: number): SkillUsageStatRow[] {
  const cutoff = sinceSecs ? Math.floor(Date.now() / 1000) - sinceSecs : 0
  return db.prepare(`
    SELECT
      skill_name,
      SUM(CASE WHEN trigger_type = 'tool_call' THEN 1 ELSE 0 END) AS call_count,
      SUM(CASE WHEN trigger_type = 'skill_read' THEN 1 ELSE 0 END) AS read_count,
      COUNT(*) AS total_count,
      COUNT(DISTINCT agent_id) AS agent_count,
      MAX(created_at) AS last_used_at
    FROM skill_usage
    WHERE created_at >= ?
    GROUP BY skill_name
    ORDER BY total_count DESC
  `).all(cutoff) as SkillUsageStatRow[]
}

// --- Config Change Log ---
// Pass null for oldValue/newValue when the registry entry is secret:true --
// this keeps secret values out of the audit trail entirely rather than
// relying on a UI to not display them.
export function logConfigChange(
  key: string,
  oldValue: string | number | null,
  newValue: string | number | null,
  actor: string,
): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO config_change_log (key, old_value, new_value, actor, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(key, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), actor, now)
}

export interface ConfigChangeLogRow {
  id: number
  key: string
  old_value: string | null
  new_value: string | null
  actor: string
  created_at: number
}

export function getRecentConfigChanges(limit = 200): ConfigChangeLogRow[] {
  // id DESC as a tiebreaker: created_at has 1-second resolution, so two
  // saves in the same second would otherwise sort arbitrarily.
  return db.prepare('SELECT * FROM config_change_log ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as ConfigChangeLogRow[]
}

// --- Store File Audit ---

export interface StoreFileAuditRow {
  id: number
  rel_path: string
  event_type: string
  is_sensitive: number
  file_size: number | null
  agent: string | null
  created_at: number
}

export function logStoreFileEvent(
  relPath: string,
  eventType: string,
  isSensitive: number,
  fileSize: number | null,
  agent: string | null = null,
): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO store_file_audit (rel_path, event_type, is_sensitive, file_size, agent, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(relPath, eventType, isSensitive, fileSize, agent, now)
}

// --- Unified Audit Log Query ---

export type AuditSource = 'config' | 'idea' | 'store' | 'diary'

export interface AuditLogEntry {
  id: number
  source: AuditSource
  created_at: number
  actor?: string
  // config
  key?: string
  old_value?: string | null
  new_value?: string | null
  // idea
  idea_id?: string
  from_status?: string | null
  to_status?: string
  note?: string | null
  // store
  rel_path?: string
  event_type?: string
  is_sensitive?: number
  file_size?: number | null
  // diary (daily_logs + memories)
  agent_id?: string
  content?: string
  category?: string
  keywords?: string
  entry_type?: 'log' | 'memory'
}

export function queryAuditLog(opts: {
  sources: AuditSource[]
  from?: number
  to?: number
  q?: string
  agent?: string
  limit: number
}): AuditLogEntry[] {
  const { sources, from, to, q, agent, limit } = opts
  const all: AuditSource[] = ['config', 'idea', 'store', 'diary']
  const active = sources.length > 0 ? sources : all

  const parts: AuditLogEntry[] = []

  if (active.includes('config')) {
    let sql = 'SELECT id, key, old_value, new_value, actor, created_at FROM config_change_log WHERE 1=1'
    const params: unknown[] = []
    if (from) { sql += ' AND created_at >= ?'; params.push(from) }
    if (to)   { sql += ' AND created_at <= ?'; params.push(to) }
    if (q)    { sql += ' AND (key LIKE ? OR old_value LIKE ? OR new_value LIKE ? OR actor LIKE ?)'; const p = `%${q}%`; params.push(p, p, p, p) }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?'; params.push(limit)
    const rows = db.prepare(sql).all(...params) as ConfigChangeLogRow[]
    for (const r of rows) parts.push({ ...r, source: 'config' })
  }

  if (active.includes('idea')) {
    let sql = 'SELECT id, idea_id, from_status, to_status, actor, note, created_at FROM idea_status_log WHERE 1=1'
    const params: unknown[] = []
    if (from) { sql += ' AND created_at >= ?'; params.push(from) }
    if (to)   { sql += ' AND created_at <= ?'; params.push(to) }
    if (q)    { sql += ' AND (idea_id LIKE ? OR to_status LIKE ? OR note LIKE ? OR actor LIKE ?)'; const p = `%${q}%`; params.push(p, p, p, p) }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?'; params.push(limit)
    const rows = db.prepare(sql).all(...params) as Array<{ id: number; idea_id: string; from_status: string | null; to_status: string; actor: string; note: string | null; created_at: number }>
    for (const r of rows) parts.push({ ...r, source: 'idea' })
  }

  if (active.includes('store')) {
    let sql = 'SELECT id, rel_path, event_type, is_sensitive, file_size, agent, created_at FROM store_file_audit WHERE 1=1'
    const params: unknown[] = []
    if (from) { sql += ' AND created_at >= ?'; params.push(from) }
    if (to)   { sql += ' AND created_at <= ?'; params.push(to) }
    if (agent) { sql += ' AND agent = ?'; params.push(agent) }
    if (q)    { sql += ' AND (rel_path LIKE ? OR agent LIKE ?)'; const p = `%${q}%`; params.push(p, p) }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?'; params.push(limit)
    const rows = db.prepare(sql).all(...params) as StoreFileAuditRow[]
    for (const r of rows) parts.push({ ...r, source: 'store' })
  }

  if (active.includes('diary')) {
    // daily_logs
    let logSql = 'SELECT id, agent_id, content, created_at FROM daily_logs WHERE 1=1'
    const logParams: unknown[] = []
    if (from)  { logSql += ' AND created_at >= ?'; logParams.push(from) }
    if (to)    { logSql += ' AND created_at <= ?'; logParams.push(to) }
    if (agent) { logSql += ' AND agent_id = ?'; logParams.push(agent) }
    if (q)     { logSql += ' AND content LIKE ?'; logParams.push(`%${q}%`) }
    logSql += ' ORDER BY created_at DESC, id DESC LIMIT ?'; logParams.push(limit)
    const logRows = db.prepare(logSql).all(...logParams) as Array<{ id: number; agent_id: string; content: string; created_at: number }>
    for (const r of logRows) parts.push({ id: r.id, source: 'diary', created_at: r.created_at, agent_id: r.agent_id, content: r.content, entry_type: 'log' })

    // memories
    let memSql = 'SELECT id, agent_id, content, category, keywords, created_at FROM memories WHERE 1=1'
    const memParams: unknown[] = []
    if (from)  { memSql += ' AND created_at >= ?'; memParams.push(from) }
    if (to)    { memSql += ' AND created_at <= ?'; memParams.push(to) }
    if (agent) { memSql += ' AND agent_id = ?'; memParams.push(agent) }
    if (q)     { memSql += ' AND (content LIKE ? OR keywords LIKE ?)'; memParams.push(`%${q}%`, `%${q}%`) }
    memSql += ' ORDER BY created_at DESC, id DESC LIMIT ?'; memParams.push(limit)
    const memRows = db.prepare(memSql).all(...memParams) as Array<{ id: number; agent_id: string; content: string; category: string; keywords: string | null; created_at: number }>
    for (const r of memRows) parts.push({ id: r.id, source: 'diary', created_at: r.created_at, agent_id: r.agent_id, content: r.content, category: r.category, keywords: r.keywords ?? undefined, entry_type: 'memory' })
  }

  // Merge and sort by created_at DESC, then id DESC as tiebreaker
  parts.sort((a, b) => b.created_at - a.created_at || (b.id ?? 0) - (a.id ?? 0))
  return parts.slice(0, limit)
}

// Prune all three audit tables to AUDIT_LOG_RETENTION_DAYS. Called from the
// daily decay sweep so old entries do not accumulate indefinitely.
export function pruneAuditLogs(): void {
  const retentionDays = Number(getEffectiveSettingValue('AUDIT_LOG_RETENTION_DAYS'))
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400
  db.prepare('DELETE FROM config_change_log WHERE created_at < ?').run(cutoff)
  db.prepare('DELETE FROM idea_status_log WHERE created_at < ?').run(cutoff)
  db.prepare('DELETE FROM store_file_audit WHERE created_at < ?').run(cutoff)
}

// Prune token_usage rows older than TOKEN_USAGE_RETENTION_DAYS. The table is the
// main DB-growth driver (one row per inbound token-log event); without this it
// grows unbounded. Called from the daily decay sweep. `timestamp` is unix
// SECONDS. Returns the number of rows removed (for logging).
export function pruneTokenUsage(): number {
  const retentionDays = Number(getEffectiveSettingValue('TOKEN_USAGE_RETENTION_DAYS'))
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400
  const info = db.prepare('DELETE FROM token_usage WHERE timestamp < ?').run(cutoff)
  return info.changes
}

// --- Vault SSH Keys (shared key pool) ---
// Each key is independent of any server -- one key may be assigned to many
// servers. The private key blob lives in the AES-256-GCM vault (vault.ts);
// only its id (vault_key_id) is stored here. public_key and fingerprint are
// safe to surface in the API; the private key never leaves the backend.

export interface VaultSshKey {
  id: string
  label: string
  username: string
  vault_key_id: string
  public_key: string
  fingerprint: string
  key_type: string
  created_at: number
}

export function listVaultSshKeys(): VaultSshKey[] {
  return db.prepare('SELECT * FROM vault_ssh_keys ORDER BY label ASC').all() as VaultSshKey[]
}

export function getVaultSshKey(id: string): VaultSshKey | undefined {
  return db.prepare('SELECT * FROM vault_ssh_keys WHERE id = ?').get(id) as VaultSshKey | undefined
}

export function createVaultSshKey(key: Pick<VaultSshKey, 'id' | 'label' | 'username' | 'vault_key_id' | 'public_key' | 'fingerprint' | 'key_type'>): VaultSshKey {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT INTO vault_ssh_keys (id, label, username, vault_key_id, public_key, fingerprint, key_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(key.id, key.label, key.username, key.vault_key_id, key.public_key, key.fingerprint, key.key_type, now)
  return { ...key, created_at: now }
}

// Unassign the key from all servers, then delete it. Returns the count of
// servers that were unassigned so callers can surface that in the response.
export function deleteVaultSshKey(id: string): { deleted: boolean; unassigned: number } {
  return db.transaction(() => {
    const unassigned = db.prepare(
      'UPDATE vault_ssh_servers SET ssh_key_id = NULL, updated_at = ? WHERE ssh_key_id = ?'
    ).run(Math.floor(Date.now() / 1000), id).changes
    const deleted = db.prepare('DELETE FROM vault_ssh_keys WHERE id = ?').run(id).changes > 0
    return { deleted, unassigned }
  })()
}

// --- Vault SSH Servers ---
// Stores server metadata. The ssh_key_id FK points to vault_ssh_keys (nullable;
// null = no key assigned = keyStatus "missing"). Legacy per-server key columns
// (vault_key_id, key_type, fingerprint, key_expires_at) have been removed via
// DROP COLUMN migration above.

export interface VaultSshServer {
  id: string
  name: string
  host: string
  port: number
  username: string
  ssh_key_id: string | null
  description: string | null
  created_at: number
  updated_at: number
}

export type SshKeyStatus = 'ok' | 'missing'

export function computeSshKeyStatus(server: VaultSshServer): SshKeyStatus {
  return server.ssh_key_id ? 'ok' : 'missing'
}

export function listVaultSshServers(): VaultSshServer[] {
  return db.prepare('SELECT * FROM vault_ssh_servers ORDER BY name ASC').all() as VaultSshServer[]
}

export function getVaultSshServer(id: string): VaultSshServer | undefined {
  return db.prepare('SELECT * FROM vault_ssh_servers WHERE id = ?').get(id) as VaultSshServer | undefined
}

export function createVaultSshServer(server: Pick<VaultSshServer, 'id' | 'name' | 'host' | 'port' | 'username' | 'description'>): VaultSshServer {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT INTO vault_ssh_servers (id, name, host, port, username, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(server.id, server.name, server.host, server.port, server.username, server.description ?? null, now, now)
  return { ...server, ssh_key_id: null, created_at: now, updated_at: now }
}

export function updateVaultSshServer(id: string, patch: Partial<Pick<VaultSshServer, 'name' | 'host' | 'port' | 'username' | 'ssh_key_id' | 'description'>>): boolean {
  const now = Math.floor(Date.now() / 1000)
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [now]
  if (patch.name !== undefined)        { sets.push('name = ?');        params.push(patch.name) }
  if (patch.host !== undefined)        { sets.push('host = ?');        params.push(patch.host) }
  if (patch.port !== undefined)        { sets.push('port = ?');        params.push(patch.port) }
  if (patch.username !== undefined)    { sets.push('username = ?');    params.push(patch.username) }
  if (patch.ssh_key_id !== undefined)  { sets.push('ssh_key_id = ?'); params.push(patch.ssh_key_id) }
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description) }
  params.push(id)
  return db.prepare(`UPDATE vault_ssh_servers SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0
}

export function deleteVaultSshServer(id: string): boolean {
  return db.prepare('DELETE FROM vault_ssh_servers WHERE id = ?').run(id).changes > 0
}

// --- Approvals (HITL) ---

export interface Approval {
  id: string
  agent_id: string
  category: string
  action_description: string
  action_payload: string | null
  status: 'pending' | 'approved' | 'rejected' | 'timeout'
  timeout_at: number | null
  telegram_message_id: number | null
  requested_at: number
  resolved_at: number | null
  resolved_by: string | null
}

export function createApproval(params: {
  id: string
  agent_id: string
  category: string
  action_description: string
  action_payload?: string | null
  timeout_at?: number | null
}): Approval {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`
    INSERT INTO approvals (id, agent_id, category, action_description, action_payload, timeout_at, requested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.agent_id,
    params.category,
    params.action_description,
    params.action_payload ?? null,
    params.timeout_at ?? null,
    now,
  )
  return {
    id: params.id,
    agent_id: params.agent_id,
    category: params.category,
    action_description: params.action_description,
    action_payload: params.action_payload ?? null,
    status: 'pending',
    timeout_at: params.timeout_at ?? null,
    telegram_message_id: null,
    requested_at: now,
    resolved_at: null,
    resolved_by: null,
  }
}

export function getApproval(id: string): Approval | undefined {
  return db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Approval | undefined
}

export function resolveApproval(id: string, status: 'approved' | 'rejected' | 'timeout', resolvedBy: string, telegramMessageId?: number | null): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare(`
    UPDATE approvals
    SET status = ?, resolved_at = ?, resolved_by = ?,
        telegram_message_id = COALESCE(?, telegram_message_id)
    WHERE id = ? AND status = 'pending'
  `).run(status, now, resolvedBy, telegramMessageId ?? null, id).changes > 0
}

// The CREATE path stamps the owner-notification message id onto the row
// (APPROVALVAK821): until this existed, telegram_message_id was only writable
// through resolveApproval, so a pending request could never carry it.
export function setApprovalTelegramMessageId(id: string, telegramMessageId: number): boolean {
  return db.prepare('UPDATE approvals SET telegram_message_id = ? WHERE id = ?')
    .run(telegramMessageId, id).changes > 0
}

export function listApprovals(opts: {
  agent_id?: string
  category?: string
  status?: string
  limit?: number
}): Approval[] {
  const conditions: string[] = []
  const params: unknown[] = []
  if (opts.agent_id) { conditions.push('agent_id = ?'); params.push(opts.agent_id) }
  if (opts.category) { conditions.push('category = ?'); params.push(opts.category) }
  if (opts.status) { conditions.push('status = ?'); params.push(opts.status) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = Math.min(opts.limit ?? 100, 500)
  params.push(limit)
  return db.prepare(`SELECT * FROM approvals ${where} ORDER BY requested_at DESC LIMIT ?`).all(...params) as Approval[]
}

// Stamp trace context onto an agent_messages row that was created without one.
// Called by the message-router tick BEFORE delivery so the span is stamped
// exactly once (pending rows only -- delivered/done rows are already closed).
export function stampMessageTrace(
  id: number,
  traceId: string,
  spanId: string,
  parentSpanId: string | null,
): boolean {
  return db.prepare(`
    UPDATE agent_messages
       SET trace_id = ?, span_id = ?, parent_span_id = ?
     WHERE id = ? AND status = 'pending' AND trace_id IS NULL
  `).run(traceId, spanId, parentSpanId, id).changes > 0
}

export function expireTimedOutApprovals(): number {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare(`
    UPDATE approvals SET status = 'timeout', resolved_at = ?
    WHERE status = 'pending' AND timeout_at IS NOT NULL AND timeout_at <= ?
  `).run(now, now).changes
}

// --- OTel Distributed Tracing (card def5a189) ---

export interface OtelSpan {
  trace_id: string
  span_id: string
  parent_span_id: string | null
  agent_id: string
  operation: string
  start_ms: number
  end_ms: number | null
  status: 'ok' | 'error' | 'timeout' | 'running'
  attributes: string | null
}

export function upsertOtelSpan(span: Omit<OtelSpan, 'end_ms' | 'status'> & { end_ms?: number | null; status?: OtelSpan['status'] }): void {
  db.prepare(`
    INSERT INTO otel_spans (trace_id, span_id, parent_span_id, agent_id, operation, start_ms, end_ms, status, attributes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (trace_id, span_id) DO UPDATE SET
      end_ms = excluded.end_ms,
      status = excluded.status,
      attributes = COALESCE(excluded.attributes, otel_spans.attributes)
  `).run(
    span.trace_id, span.span_id, span.parent_span_id ?? null,
    span.agent_id, span.operation, span.start_ms,
    span.end_ms ?? null, span.status ?? 'running', span.attributes ?? null,
  )
}

export function closeOtelSpan(traceId: string, spanId: string, endMs: number, status: OtelSpan['status']): boolean {
  return db.prepare(`
    UPDATE otel_spans SET end_ms = ?, status = ? WHERE trace_id = ? AND span_id = ?
  `).run(endMs, status, traceId, spanId).changes > 0
}

/**
 * Close a span only if it is still open -- FIRST terminal event wins.
 *
 * Card dbc0b4bf. These spans are opened by the message router and measure the one thing this
 * table's own header calls it: inter-agent latency, send -> delivered. A message can ALSO be marked
 * done later via PUT /api/messages/:id, and closing again there would silently overwrite a measured
 * latency with a work duration -- two different quantities in one column, indistinguishable
 * afterwards. Whichever terminal event happens first is the one the span was measuring.
 *
 * Deliberately NOT a change to closeOtelSpan above: routes/spans.ts uses that function's return
 * value to detect "span does not exist yet" and falls back to an upsert-close, so making it
 * first-writer-wins there would send an already-closed span down the not-found path and rewrite it
 * anyway. External reporters keep the old, unconditional semantics.
 */
export function closeOtelSpanIfOpen(traceId: string, spanId: string, endMs: number, status: OtelSpan['status']): boolean {
  return db.prepare(`
    UPDATE otel_spans SET end_ms = ?, status = ?
    WHERE trace_id = ? AND span_id = ? AND end_ms IS NULL
  `).run(endMs, status, traceId, spanId).changes > 0
}

export function getOtelTrace(traceId: string): OtelSpan[] {
  return db.prepare('SELECT * FROM otel_spans WHERE trace_id = ? ORDER BY start_ms ASC')
    .all(traceId) as OtelSpan[]
}

export interface OtelTraceSummary {
  trace_id: string
  root_operation: string
  root_agent: string
  start_ms: number
  end_ms: number | null
  span_count: number
  status: string
}

export function listOtelTraces(limit = 50): OtelTraceSummary[] {
  return db.prepare(`
    SELECT
      s.trace_id,
      s.operation  AS root_operation,
      s.agent_id   AS root_agent,
      s.start_ms,
      (SELECT MAX(end_ms) FROM otel_spans WHERE trace_id = s.trace_id) AS end_ms,
      (SELECT COUNT(*)    FROM otel_spans WHERE trace_id = s.trace_id) AS span_count,
      CASE
        WHEN EXISTS (SELECT 1 FROM otel_spans WHERE trace_id = s.trace_id AND status = 'error')   THEN 'error'
        WHEN EXISTS (SELECT 1 FROM otel_spans WHERE trace_id = s.trace_id AND status = 'timeout') THEN 'timeout'
        WHEN EXISTS (SELECT 1 FROM otel_spans WHERE trace_id = s.trace_id AND status = 'running') THEN 'running'
        ELSE 'ok'
      END AS status
    FROM otel_spans s
    WHERE s.parent_span_id IS NULL
    ORDER BY s.start_ms DESC
    LIMIT ?
  `).all(limit) as OtelTraceSummary[]
}

