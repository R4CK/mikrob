// Deterministic import of existing edges into the knowledge graph (MT-01 alap, card ee9ee17b).
//
// "Determinisztikus import a meglévő élekből (card/sha/child-of/pair)" (MODULTERV section 3,
// MT-10 row): this reads what kanban_relations and kanban_verdicts ALREADY recorded and mirrors
// it as kg_nodes/kg_edges. It does not synthesize new node types (no solution/finding/error_class
// extraction here -- that classification work is MT-05/MT-10, separate cards) and it does not
// read REVIEW/comment prose, so there is no secret-shape risk on THIS path the way there is for
// future free-text capture; upsertNode() still runs its check because every write goes through it.
//
// Idempotent by construction: kg_edges' composite primary key (src,dst,rel) makes a re-run a
// no-op for edges already present (upsertEdge uses INSERT OR IGNORE), and kg_nodes upserts on id
// instead of inserting a duplicate. Running this twice over the same source data must yield the
// same row counts both times -- that is exactly what import-from-relations.test.ts asserts.

import type Database from 'better-sqlite3'
import { upsertNode, upsertEdge, type KgEdgeInput } from './store.js'
import { mapProjectToPartition } from './project-map.js'
import type { KgEdgeRel } from './schema.js'

export interface ImportReport {
  cardsSeen: number
  cardsSkippedMissing: number
  commitNodesUpserted: number
  edgesFromRelations: number
  edgesFromVerdicts: number
}

interface CardRow {
  id: string
  title: string
  project: string | null
}

interface RelationRow {
  from_type: string
  from_id: string
  to_type: string
  to_id: string
  relation_type: string
}

interface VerdictRow {
  card_id: string
  sha: string | null
}

const RELATION_TO_EDGE: Readonly<Record<string, KgEdgeRel>> = {
  'gate-sha': 'implemented_in',
  'child-of': 'child_of',
  'pair-fe': 'pair_fe',
  'pair-be': 'pair_be',
}

function cardNodeId(cardId: string): string {
  return `card:${cardId}`
}

function commitNodeId(sha: string): string {
  return `commit:${sha}`
}

/** Looks up a card's title+project once per import run and caches it, so N edges touching the
 *  same card cost one SELECT, not N. Returns undefined for a card that no longer exists (deleted
 *  since the relation/verdict row was written) -- the caller skips edges it cannot anchor rather
 *  than inventing a placeholder node for a card that is gone. */
function makeCardLookup(mainDb: Database.Database): (id: string) => CardRow | undefined {
  const stmt = mainDb.prepare('SELECT id, title, project FROM kanban_cards WHERE id = ?')
  const cache = new Map<string, CardRow | undefined>()
  return (id: string) => {
    if (cache.has(id)) return cache.get(id)
    const row = stmt.get(id) as CardRow | undefined
    cache.set(id, row)
    return row
  }
}

function ensureCardNode(
  kgDb: Database.Database,
  lookup: (id: string) => CardRow | undefined,
  cardId: string,
  report: ImportReport,
  seen: Set<string>,
): CardRow | undefined {
  if (seen.has(cardId)) return lookup(cardId)
  seen.add(cardId)
  report.cardsSeen += 1
  const row = lookup(cardId)
  if (!row) {
    report.cardsSkippedMissing += 1
    return undefined
  }
  upsertNode(kgDb, {
    id: cardNodeId(row.id),
    type: 'card',
    project: mapProjectToPartition(row.project),
    title: row.title,
    source_ref: `kanban_cards:${row.id}`,
    extractor: 'import:kanban_relations',
  })
  return row
}

function ensureCommitNode(
  kgDb: Database.Database,
  sha: string,
  project: string,
  report: ImportReport,
  seen: Set<string>,
): void {
  const id = commitNodeId(sha)
  if (seen.has(id)) return
  seen.add(id)
  upsertNode(kgDb, {
    id,
    type: 'commit',
    project,
    title: sha,
    source_ref: `git:${sha}`,
    extractor: 'import:kanban_relations',
  })
  report.commitNodesUpserted += 1
}

/** Reads kanban_relations (card<->card and card->sha edges already extracted by
 *  src/kanban-relations.ts) and kanban_verdicts (gate verdicts, which also name a sha) from the
 *  MAIN dashboard database and mirrors them into the knowledge-graph database. The two handles
 *  are passed in rather than opened here (injected-port-adapters pattern) so a caller controls
 *  which files are read/written -- tests point both at disposable fixtures, and a future CLI
 *  entry point can point mainDb at the live claudeclaw.db without this module caring. */
export function importFromRelations(mainDb: Database.Database, kgDb: Database.Database): ImportReport {
  const report: ImportReport = {
    cardsSeen: 0,
    cardsSkippedMissing: 0,
    commitNodesUpserted: 0,
    edgesFromRelations: 0,
    edgesFromVerdicts: 0,
  }
  const lookup = makeCardLookup(mainDb)
  const cardNodesWritten = new Set<string>()
  const commitNodesWritten = new Set<string>()

  const relationTypes = Object.keys(RELATION_TO_EDGE)
  const relations = mainDb
    .prepare(
      `SELECT from_type, from_id, to_type, to_id, relation_type FROM kanban_relations
       WHERE from_type = 'card' AND relation_type IN (${relationTypes.map(() => '?').join(',')})`,
    )
    .all(...relationTypes) as RelationRow[]

  const runUpsertEdge = (input: KgEdgeInput) => {
    if (upsertEdge(kgDb, input) > 0) report.edgesFromRelations += 1
  }

  for (const rel of relations) {
    const fromCard = ensureCardNode(kgDb, lookup, rel.from_id, report, cardNodesWritten)
    if (!fromCard) continue
    const edgeRel = RELATION_TO_EDGE[rel.relation_type]
    if (!edgeRel) continue // unreachable given the WHERE clause, kept for type safety

    if (rel.to_type === 'card') {
      const toCard = ensureCardNode(kgDb, lookup, rel.to_id, report, cardNodesWritten)
      if (!toCard) continue
      runUpsertEdge({
        src: cardNodeId(rel.from_id),
        dst: cardNodeId(rel.to_id),
        rel: edgeRel,
        source: 'import:kanban_relations',
      })
    } else if (rel.to_type === 'sha') {
      ensureCommitNode(
        kgDb,
        rel.to_id,
        mapProjectToPartition(fromCard.project),
        report,
        commitNodesWritten,
      )
      runUpsertEdge({
        src: cardNodeId(rel.from_id),
        dst: commitNodeId(rel.to_id),
        rel: edgeRel,
        source: 'import:kanban_relations',
      })
    }
  }

  const verdicts = mainDb
    .prepare(`SELECT card_id, sha FROM kanban_verdicts WHERE sha IS NOT NULL AND sha != ''`)
    .all() as VerdictRow[]
  for (const v of verdicts) {
    const card = ensureCardNode(kgDb, lookup, v.card_id, report, cardNodesWritten)
    if (!card) continue
    ensureCommitNode(kgDb, v.sha!, mapProjectToPartition(card.project), report, commitNodesWritten)
    if (
      upsertEdge(kgDb, {
        src: cardNodeId(v.card_id),
        dst: commitNodeId(v.sha!),
        rel: 'found_on',
        source: 'import:kanban_verdicts',
      }) > 0
    ) {
      report.edgesFromVerdicts += 1
    }
  }

  return report
}
