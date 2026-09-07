// Card 00c9fa38 (Cybered/backend2 finding, testver a router zaras-egysegesitesrol -- card 99254564):
// before the dbc0b4bf fix (this repo's own commit 85fcacb, 2026-09-04 19:19:24 +0200) NOTHING ever
// closed a router-opened OTel span, success or failure. So a pre-cutoff `status = 'running'` row
// will NEVER be closed retroactively -- it is permanent junk, not "still in flight" -- and leaving
// it labelled 'running' makes that column useless as a cheap stuck-span detector, which is exactly
// what the sibling card wants it to answer.
//
// This is the REBUILD migration in db.ts's initDatabase(), not the local-schema-replica pattern
// otel-distributed-tracing.test.ts uses (that file's own header explains why: a replica schema can
// drift from the real one silently). Testing the rebuild itself requires seeding an OLD-shaped
// otel_spans table on a REAL file path BEFORE calling the real initDatabase(), so the migration
// branch (current schema lacks 'legacy_unknown') actually fires -- a fresh :memory: DB never
// exercises it, since CREATE TABLE IF NOT EXISTS already creates the new shape directly.
import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'

const DBC0B4BF_DELIVERY_CLOSE_CUTOFF_MS = 1788542364000

let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

/** Seeds a REAL file with the pre-migration otel_spans shape (no 'legacy_unknown' in the CHECK),
 *  plus the rows a test needs, then closes the connection so initDatabase() can open it fresh. */
function seedOldSchema(dbPath: string, rows: Array<{ trace_id: string; span_id: string; status: string; start_ms: number }>): void {
  const raw = new Database(dbPath)
  raw.exec(`
    CREATE TABLE otel_spans (
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
  const ins = raw.prepare(`
    INSERT INTO otel_spans (trace_id, span_id, agent_id, operation, start_ms, status)
    VALUES (?, ?, 'test-agent', 'test-op', ?, ?)
  `)
  for (const r of rows) ins.run(r.trace_id, r.span_id, r.start_ms, r.status)
  raw.close()
}

describe('otel_spans legacy_unknown migration (card 00c9fa38)', () => {
  it('a pre-cutoff running row is relabelled legacy_unknown', () => {
    dir = mkdtempSync(join(tmpdir(), 'otel-legacy-'))
    const dbPath = join(dir, 'test.db')
    seedOldSchema(dbPath, [
      { trace_id: 't1', span_id: 's1', status: 'running', start_ms: DBC0B4BF_DELIVERY_CLOSE_CUTOFF_MS - 1000 },
    ])

    initDatabase(dbPath)

    const row = getDb().prepare("SELECT status FROM otel_spans WHERE trace_id = 't1' AND span_id = 's1'").get() as { status: string }
    expect(row.status).toBe('legacy_unknown')
  })

  it('a post-cutoff running row is left alone -- it may genuinely still be in flight', () => {
    dir = mkdtempSync(join(tmpdir(), 'otel-legacy-'))
    const dbPath = join(dir, 'test.db')
    seedOldSchema(dbPath, [
      { trace_id: 't2', span_id: 's2', status: 'running', start_ms: DBC0B4BF_DELIVERY_CLOSE_CUTOFF_MS + 1000 },
    ])

    initDatabase(dbPath)

    const row = getDb().prepare("SELECT status FROM otel_spans WHERE trace_id = 't2' AND span_id = 's2'").get() as { status: string }
    expect(row.status).toBe('running')
  })

  it('a pre-cutoff CLOSED row (ok/error/timeout) is untouched -- only running rows are ambiguous', () => {
    dir = mkdtempSync(join(tmpdir(), 'otel-legacy-'))
    const dbPath = join(dir, 'test.db')
    seedOldSchema(dbPath, [
      { trace_id: 't3', span_id: 's3', status: 'ok', start_ms: DBC0B4BF_DELIVERY_CLOSE_CUTOFF_MS - 5000 },
      { trace_id: 't3', span_id: 's4', status: 'error', start_ms: DBC0B4BF_DELIVERY_CLOSE_CUTOFF_MS - 5000 },
      { trace_id: 't3', span_id: 's5', status: 'timeout', start_ms: DBC0B4BF_DELIVERY_CLOSE_CUTOFF_MS - 5000 },
    ])

    initDatabase(dbPath)

    const rows = getDb().prepare("SELECT span_id, status FROM otel_spans WHERE trace_id = 't3' ORDER BY span_id").all() as { span_id: string; status: string }[]
    expect(rows).toEqual([
      { span_id: 's4', status: 'error' },
      { span_id: 's5', status: 'timeout' },
      { span_id: 's3', status: 'ok' },
    ].sort((a, b) => a.span_id.localeCompare(b.span_id)))
  })

  it('the migration is idempotent -- a second initDatabase() call on the same file changes nothing further', () => {
    dir = mkdtempSync(join(tmpdir(), 'otel-legacy-'))
    const dbPath = join(dir, 'test.db')
    seedOldSchema(dbPath, [
      { trace_id: 't5', span_id: 's6', status: 'running', start_ms: DBC0B4BF_DELIVERY_CLOSE_CUTOFF_MS - 1000 },
    ])

    initDatabase(dbPath)
    initDatabase(dbPath) // re-open the same file -- must not throw, must not re-migrate

    const row = getDb().prepare("SELECT status FROM otel_spans WHERE trace_id = 't5' AND span_id = 's6'").get() as { status: string }
    expect(row.status).toBe('legacy_unknown')
  })

  it('a fresh :memory: DB already carries legacy_unknown in its CHECK -- new rows can use it directly', () => {
    initDatabase(':memory:')
    // If the CHECK did not include 'legacy_unknown', this insert would throw.
    expect(() => {
      getDb().prepare(`
        INSERT INTO otel_spans (trace_id, span_id, agent_id, operation, start_ms, status)
        VALUES ('tf', 'sf', 'a', 'op', 0, 'legacy_unknown')
      `).run()
    }).not.toThrow()
  })
})
