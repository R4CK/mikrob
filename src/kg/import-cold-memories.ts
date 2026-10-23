// MT-10c (card 76c2efb1, parent 81593084): imports the MikroB memory system's cold tier into the
// knowledge graph as `lesson` nodes, linked to any card/commit node the memory text references via
// `about` edges.
//
// Scope, per the card: every cold-tier memory row (all agents, not filtered to one) becomes a
// `lesson` node. If the row's text names a card id or a commit sha, an `about` edge is created to
// that node -- but ONLY if the target node already exists in the graph. This importer never
// fabricates a card/commit node to hang an edge on (unlike import-decisions-log.ts's `governs`
// edges, which do create the card node on the fly): memories are free-text fleet notes, not a
// structured log with a known project, so there is no `project` value to give a fabricated card
// node here.
//
// Deterministic text matching, same posture as the other MT-10 importers: reuses
// import-decisions-log.ts's `referencedCardIds` for the 8-hex-char card-id shape, and adds a
// broader hex-token match (7-40 chars, the fleet's own Gate-SHA shape per store.ts's
// ANCHOR_SHA_PATTERN/GATE_SHA_PATTERN) for commit-sha references.
//
// Idempotent by construction: the node id is derived from the stable `memories.id`
// (`lesson:memory:<id>`) -- re-running the import over the same rows upserts the same rows rather
// than duplicating them. Atomic: one kgDb transaction, a bad row rolls back the whole run.

import type Database from 'better-sqlite3'
import { upsertNode, upsertEdge } from './store.js'
import { GLOBAL_PARTITION } from './project-map.js'
import { referencedCardIds } from './import-decisions-log.js'

export interface ColdMemoriesImportReport {
  memoriesScanned: number
  lessonsUpserted: number
  aboutEdges: number
}

interface MemoryRow {
  id: number
  agent_id: string
  content: string
  keywords: string | null
}

// Fleet shas are 7-40 lowercase-hex chars (store.ts's ANCHOR_SHA_PATTERN/GATE_SHA_PATTERN) -- the
// same shape an 8-hex card id has, which is exactly why every match below is only linked if a node
// of that exact id already exists, never trusted on shape alone (same reasoning
// import-decisions-log.ts already documents for its own card-id matches).
const HEX_TOKEN_RX = /\b[0-9a-f]{7,40}\b/gi

function referencedHexTokens(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(HEX_TOKEN_RX)) seen.add(m[0].toLowerCase())
  return [...seen]
}

function lessonNodeId(memoryId: number): string {
  return `lesson:memory:${memoryId}`
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? text
  return line.trim()
}

/** Imports every cold-tier memory row into the graph as a `lesson` node, with `about` edges to any
 *  card/commit node its text references that already exists in the graph. */
export function importColdMemories(
  mainDb: Database.Database,
  kgDb: Database.Database,
): ColdMemoriesImportReport {
  const report: ColdMemoriesImportReport = {
    memoriesScanned: 0,
    lessonsUpserted: 0,
    aboutEdges: 0,
  }

  const rows = mainDb
    .prepare(`SELECT id, agent_id, content, keywords FROM memories WHERE category = 'cold'`)
    .all() as MemoryRow[]
  report.memoriesScanned = rows.length

  const nodeExists = (id: string): boolean =>
    !!kgDb.prepare('SELECT 1 FROM kg_nodes WHERE id = ?').get(id)

  const runImport = kgDb.transaction(() => {
    const extractor = 'import:cold_memories'

    for (const row of rows) {
      const id = lessonNodeId(row.id)
      upsertNode(kgDb, {
        id,
        type: 'lesson',
        project: GLOBAL_PARTITION,
        title: firstLine(row.content) || `(no content, memories:${row.id})`,
        body: row.content,
        keywords: row.keywords ?? null,
        source_ref: `memories:${row.id}`,
        extractor,
      })
      report.lessonsUpserted += 1

      const targets = new Set<string>()
      for (const cardId of referencedCardIds(row.content)) {
        if (nodeExists(`card:${cardId}`)) targets.add(`card:${cardId}`)
      }
      for (const token of referencedHexTokens(row.content)) {
        if (nodeExists(`commit:${token}`)) targets.add(`commit:${token}`)
      }

      for (const dst of targets) {
        if (upsertEdge(kgDb, { src: id, dst, rel: 'about', source: extractor }) > 0) {
          report.aboutEdges += 1
        }
      }
    }
  })
  runImport()

  return report
}
