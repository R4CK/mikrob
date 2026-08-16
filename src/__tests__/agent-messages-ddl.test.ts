// Card 26ad5302: the dashboard (db.ts) and the channel-coordinator (ingest.ts, a SEPARATE
// process that races the dashboard at boot) each used to hand-copy the `agent_messages` DDL,
// with a comment asserting the copies were "identical schema". Nothing enforced that, and it
// drifted for real: db.ts grew two indexes and the origin_note column that ingest.ts's copy
// never got, so a coordinator that won the boot race created a table missing both.
//
// Both files now execute the SAME shared statement list (src/schema/agent-messages-ddl.ts).
// These tests pin the two things that matter: (1) if the coordinator creates the table alone --
// the actual boot-race scenario -- it is fully migrated, indexes and all, not just the bare
// original nine columns; and (2) nobody re-introduces a hand-copied DDL string in either file,
// which is exactly how the original drift happened.
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { initIngestDb, closeIngestDb } from '../channel-coordinator/ingest.js'
import { initDatabase, getDb } from '../db.js'
import { REPO_ROOT } from './helpers/repo-location.js'

describe('agent_messages DDL parity (card 26ad5302)', () => {
  afterEach(() => {
    closeIngestDb()
  })

  it('the coordinator alone (boot-race winner) creates a fully migrated table -- indexes and all', () => {
    const handle: Database.Database = initIngestDb(':memory:')
    const cols = handle
      .prepare('PRAGMA table_info(agent_messages)')
      .all()
      .map((r) => (r as { name: string }).name)
      .sort()
    expect(cols).toEqual(
      [
        'id', 'from_agent', 'to_agent', 'content', 'status', 'result',
        'created_at', 'delivered_at', 'completed_at',
        'origin_note', 'trace_id', 'span_id', 'parent_span_id',
      ].sort(),
    )
    const indexes = handle
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_messages'")
      .all()
      .map((r) => (r as { name: string }).name)
    expect(indexes).toContain('idx_agent_messages_status')
    expect(indexes).toContain('idx_agent_messages_thread')
  })

  it('the dashboard and the coordinator, run independently, produce the identical column set', () => {
    initDatabase(':memory:')
    const dashboardCols = getDb()
      .prepare('PRAGMA table_info(agent_messages)')
      .all()
      .map((r) => (r as { name: string }).name)
      .sort()

    const handle = initIngestDb(':memory:')
    const coordinatorCols = handle
      .prepare('PRAGMA table_info(agent_messages)')
      .all()
      .map((r) => (r as { name: string }).name)
      .sort()

    expect(coordinatorCols).toEqual(dashboardCols)
  })
})

describe('no hand-copied agent_messages DDL (regression guard for how the drift happened)', () => {
  // The incident was a literal SQL string duplicated in two files. A test that only checks
  // present-day behaviour would not stop someone from reintroducing a second hand-copy next to
  // the shared import -- this greps for exactly that shape.
  it('db.ts has no inline CREATE TABLE agent_messages -- it must come from the shared DDL', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/db.ts'), 'utf-8')
    expect(src).not.toMatch(/CREATE TABLE[^`]*agent_messages\s*\(/i)
    expect(src).toMatch(/AGENT_MESSAGES_DDL/)
  })

  it('ingest.ts has no inline CREATE TABLE agent_messages -- it must come from the shared DDL', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/channel-coordinator/ingest.ts'), 'utf-8')
    expect(src).not.toMatch(/CREATE TABLE[^`]*agent_messages\s*\(/i)
    expect(src).toMatch(/AGENT_MESSAGES_DDL/)
  })
})
