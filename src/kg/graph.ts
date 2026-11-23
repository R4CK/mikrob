// Card a1d57d99: read-only graph slice for the live-graph FE (GET /api/kg/graph). No node
// body/snippet/embedding/keywords -- only the fields the card's contract allows (id, type,
// label, project), since those columns can carry secret-shaped or oversized text (see store.ts's
// write-time secret-shape checks) and this endpoint has no business serving them.
import type Database from 'better-sqlite3'

export interface KgGraphNode {
  id: string
  type: string
  label: string
  project: string
}

export interface KgGraphEdge {
  source: string
  target: string
  type: string
}

export interface KgGraphPayload {
  nodes: KgGraphNode[]
  edges: KgGraphEdge[]
}

/** Nodes (capped at `maxNodes`, excluding archived -- same terminal-status exclusion
 *  computeKgStats in web/routes/kg.ts already applies), optionally filtered by project, plus
 *  only the edges whose BOTH endpoints are in that node set -- an edge to a node outside the
 *  cap would be a dangling reference the FE can't render anyway. */
export function getKgGraph(
  db: Database.Database,
  project: string | undefined,
  maxNodes: number
): KgGraphPayload {
  const nodeRows = project
    ? db
        .prepare(
          `SELECT id, type, title, project FROM kg_nodes
           WHERE status != 'archived' AND project = ? LIMIT ?`
        )
        .all(project, maxNodes)
    : db
        .prepare(`SELECT id, type, title, project FROM kg_nodes WHERE status != 'archived' LIMIT ?`)
        .all(maxNodes)

  const nodes = (nodeRows as { id: string; type: string; title: string; project: string }[]).map(
    (row) => ({ id: row.id, type: row.type, label: row.title, project: row.project })
  )
  const nodeIds = new Set(nodes.map((n) => n.id))
  if (nodeIds.size === 0) return { nodes, edges: [] }

  const placeholders = [...nodeIds].map(() => '?').join(',')
  const edgeRows = db
    .prepare(
      `SELECT src, dst, rel FROM kg_edges WHERE src IN (${placeholders}) AND dst IN (${placeholders})`
    )
    .all(...nodeIds, ...nodeIds) as { src: string; dst: string; rel: string }[]

  const edges = edgeRows.map((row) => ({ source: row.src, target: row.dst, type: row.rel }))
  return { nodes, edges }
}
