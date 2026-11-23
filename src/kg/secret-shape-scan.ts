// Card 03dff487 (Kesz-ha point 3): backfill DRY-RUN over the existing knowledge-graph.db --
// counts how many CURRENT nodes would match each of the 5 KG-local secret/PII shapes
// (kgLocalSecretShapeCounts), without the write path's context requirement for 64-hex/base64, so
// the operator sees the true collision surface, not just what upsertNode would currently block.
// Read-only: never mutates kg_nodes, never calls upsertNode. The body lives here, not in the
// scripts/ CLI, so a test can drive it with an in-memory DB (same reasoning as
// src/kg/backfill-cli.ts).
import type Database from 'better-sqlite3'
import { kgLocalSecretShapeCounts } from './store.js'

export interface SecretShapeScanReport {
  nodesScanned: number
  // Node counts: how many DISTINCT nodes have at least one match of the shape, in ANY field --
  // the operator-relevant number ("how many nodes would need a look"), not a raw match total
  // across fields (one node with 3 hits in its body should not inflate the headline count to 3).
  nodeCountsByShape: Record<string, number>
}

const FIELDS = ['title', 'body', 'snippet', 'keywords'] as const

export function scanKgSecretShapes(db: Database.Database): SecretShapeScanReport {
  const rows = db.prepare(`SELECT ${FIELDS.join(', ')} FROM kg_nodes`).all() as Array<
    Record<(typeof FIELDS)[number], string | null>
  >
  const nodeCountsByShape: Record<string, number> = {}
  for (const row of rows) {
    const hitShapesThisNode = new Set<string>()
    for (const field of FIELDS) {
      const counts = kgLocalSecretShapeCounts(row[field])
      for (const [shape, n] of Object.entries(counts)) {
        if (n > 0) hitShapesThisNode.add(shape)
      }
    }
    for (const shape of hitShapesThisNode) {
      nodeCountsByShape[shape] = (nodeCountsByShape[shape] ?? 0) + 1
    }
  }
  return { nodesScanned: rows.length, nodeCountsByShape }
}

export function formatSecretShapeScanReport(report: SecretShapeScanReport): string {
  const lines = [`kg-secret-shape-scan: ${report.nodesScanned} node(s) scanned (dry-run, read-only)`]
  const shapes = [
    'kv-secret (password=/*_API_KEY=)',
    'bare-64-hex',
    'base64-blob',
    'email',
    'phone',
  ]
  for (const shape of shapes) {
    lines.push(`  ${shape}: ${report.nodeCountsByShape[shape] ?? 0} node(s)`)
  }
  return lines.join('\n')
}
