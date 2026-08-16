// Single source of truth for the `agent_messages` table shape (card 26ad5302).
//
// Two SEPARATE processes each create this table defensively: the dashboard (src/db.ts, the
// owner) and the channel-coordinator (src/channel-coordinator/ingest.ts, which races the
// dashboard at boot -- see that file's own comment for why it has a CREATE TABLE at all). Before
// this file, each hand-copied a DDL string with a comment asserting "identical schema"; nothing
// enforced that, and it drifted silently -- two indexes and the origin_note column were added to
// db.ts's copy and never to ingest.ts's, so a coordinator that won the boot race created a table
// missing both. Both files now execute this SAME array, in order, so that kind of drift is
// structurally impossible instead of a hoped-for invariant nobody re-checks.
//
// Every statement here is safe to re-run on an already-current database: CREATE TABLE/INDEX use
// IF NOT EXISTS, and SQLite has no "ADD COLUMN IF NOT EXISTS", so the ALTER statements are kept
// separate and the caller wraps each in try/catch, swallowing the "duplicate column" error.

export const AGENT_MESSAGES_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS agent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','done','failed')),
    result TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    completed_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_messages_status ON agent_messages(status, to_agent)`,
  // Composite index for thread-listing queries that filter on (from_agent, to_agent) without a
  // status predicate -- the status index above does not cover these and causes full table scans
  // at scale.
  `CREATE INDEX IF NOT EXISTS idx_agent_messages_thread ON agent_messages(from_agent, to_agent, created_at)`,
]

// Columns added after the original CREATE TABLE. Each caller must wrap these in try/catch (see
// module comment above) -- there is no portable "add column if missing" in SQLite DDL.
export const AGENT_MESSAGES_ALTER_COLUMNS: readonly string[] = [
  // Card 06f062e4: optional, self-declared attributability tag for a sub-agent sharing its
  // parent's from_agent string. Not a trust boundary -- see db.ts's fuller comment at the call site.
  `ALTER TABLE agent_messages ADD COLUMN origin_note TEXT`,
  // Card def5a189: distributed trace context propagated by the message-router middleware.
  `ALTER TABLE agent_messages ADD COLUMN trace_id TEXT`,
  `ALTER TABLE agent_messages ADD COLUMN span_id TEXT`,
  `ALTER TABLE agent_messages ADD COLUMN parent_span_id TEXT`,
]
