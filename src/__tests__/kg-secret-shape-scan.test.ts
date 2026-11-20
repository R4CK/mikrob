// Card 03dff487 (Kesz-ha point 3): the backfill dry-run over an existing knowledge-graph.db.
// Real in-memory DB, inserted directly (not via upsertNode, which would reject/redact the very
// shapes this scan exists to count) -- the point of the dry-run is to see what is ALREADY there
// from before this card's write-path guards existed.
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../kg/store.js'
import { scanKgSecretShapes, formatSecretShapeScanReport } from '../kg/secret-shape-scan.js'

function insertRawNode(
  db: Database.Database,
  id: string,
  fields: { title?: string; body?: string; snippet?: string; keywords?: string },
): void {
  db.prepare(
    `INSERT INTO kg_nodes (id, type, project, title, body, snippet, keywords, source_ref,
       extractor, created_at, updated_at)
     VALUES (?, 'solution', 'marveen', ?, ?, ?, ?, 'x', 'manual', 0, 0)`,
  ).run(id, fields.title ?? 'title', fields.body ?? null, fields.snippet ?? null, fields.keywords ?? null)
}

describe('scanKgSecretShapes (card 03dff487, backfill dry-run)', () => {
  it('counts nodes containing each shape, once per node even with multiple hits in a field', () => {
    const db = new Database(':memory:')
    migrate(db)
    const hex64 = 'a1b2c3d4'.repeat(8)
    insertRawNode(db, 'n:kv', { body: 'password=realvalue123' })
    insertRawNode(db, 'n:hex-no-context', { body: `sha: ${hex64} and another ${hex64}` })
    insertRawNode(db, 'n:email-and-phone', { body: 'a@b.com', snippet: 'call 06201234567' })
    insertRawNode(db, 'n:clean', { body: 'nothing interesting here' })

    const report = scanKgSecretShapes(db)
    expect(report.nodesScanned).toBe(4)
    expect(report.nodeCountsByShape['kv-secret (password=/*_API_KEY=)']).toBe(1)
    // Two hex64 matches in the SAME node's body must count as ONE node, not two.
    expect(report.nodeCountsByShape['bare-64-hex']).toBe(1)
    expect(report.nodeCountsByShape.email).toBe(1)
    expect(report.nodeCountsByShape.phone).toBe(1)
    db.close()
  })

  it('formatSecretShapeScanReport prints every shape, even at zero', () => {
    const db = new Database(':memory:')
    migrate(db)
    insertRawNode(db, 'n:clean', { body: 'nothing interesting here' })
    const text = formatSecretShapeScanReport(scanKgSecretShapes(db))
    expect(text).toContain('1 node(s) scanned')
    expect(text).toContain('kv-secret (password=/*_API_KEY=): 0 node(s)')
    expect(text).toContain('bare-64-hex: 0 node(s)')
    expect(text).toContain('base64-blob: 0 node(s)')
    expect(text).toContain('email: 0 node(s)')
    expect(text).toContain('phone: 0 node(s)')
    db.close()
  })
})
