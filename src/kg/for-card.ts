// MT-07 dispatch package (card 34c2d2a2): GET /api/kg/for-card/:cardId, per the F1-updated
// contract (3f6fc4ce comment 20763, MikroB decisions 20758/20814/20822). The actual wiring of
// this package INTO a dispatch/self-advance-pickup message is F3's job (card 1a350f22) -- this
// module only builds the package.
//
// Field-naming note (ASSUMPTION, stated explicitly per karpathy-guidelines rule 1): the approved
// contract's JSON shape reuses the key `card_id` for TWO different things -- the outer envelope's
// `card_id` is the kanban card being queried, while each `solutions`/`known_pitfalls`/`decisions`
// entry's `card_id` is literally the graph NODE's own id (e.g. "sol:7f3a91c2"), not a kanban card.
// This looks like a naming slip in the gate-approved spec, but QA+Cybersec signed off on that exact
// shape (comment 20763/20814) and this card does not own the contract -- implemented literally.
//
// error_class/verdict derivation (ASSUMPTION, the contract's D4 note left this "frissül F1 után"
// without a follow-up comment on 3f6fc4ce by the time this card was built): error_class comes from
// a node's 'of_class' edge target id (minus the 'error_class:' prefix) when one exists, else null.
// verdict comes from a `finding` node's own title, which import-findings.ts already formats as
// "<GATE> <VERDICT>" (e.g. "QA PASS") -- there is no separate verdict column to read.

import type Database from 'better-sqlite3'
import { getKanbanCard } from '../db.js'
import { mapProjectToPartition, GLOBAL_PARTITION } from './project-map.js'
import { hybridKgSearch, type KgSearchResult } from './search.js'

export interface KgForCardEntry {
  card_id: string // the node's own id, see field-naming note above
  error_class: string | null
  anchor: KgSearchResult['anchors'][number] | null
  verdict: string | null
  gate_sha: string | null
  why: string
  date: string
  source_ref: string
}

export interface KgCrossProjectRef {
  card_id: string
  error_class: string
}

export interface KgForCardPackage {
  card_id: string
  solutions: KgForCardEntry[]
  known_pitfalls: KgForCardEntry[]
  decisions: KgForCardEntry[]
  cross_project_refs: KgCrossProjectRef[]
  meta: { scope: string; chars: number; truncated: boolean }
}

export interface KgForCardOptions {
  k?: number
  minScore?: number
  expandHops?: number
  maxChars?: number
}

// Loose in-repo-path pattern: at least one '/' and a file extension. Deliberately permissive
// (false positives just widen the anchor search with no match, which is harmless) rather than
// tight -- EK-MT-6 only needs the real path mentioned on a card to be found, not every mention
// filtered to be a real path.
const PATH_PATTERN = /\b[\w.-]+(?:\/[\w.-]+)+\.\w+\b/g

function extractPaths(text: string): string[] {
  const matches = text.match(PATH_PATTERN) ?? []
  return [...new Set(matches)]
}

function errorClassOf(db: Database.Database, nodeId: string): string | null {
  const edge = db
    .prepare(
      `SELECT dst FROM kg_edges WHERE src = ? AND rel = 'of_class'
       UNION SELECT src AS dst FROM kg_edges WHERE dst = ? AND rel = 'of_class' AND src LIKE 'error_class:%'`,
    )
    .get(nodeId, nodeId) as { dst: string } | undefined
  if (!edge) return null
  return edge.dst.startsWith('error_class:') ? edge.dst.slice('error_class:'.length) : edge.dst
}

function toEntry(db: Database.Database, r: KgSearchResult): KgForCardEntry {
  return {
    card_id: r.id,
    error_class: errorClassOf(db, r.id),
    anchor: r.anchors[0] ?? null,
    verdict: r.type === 'finding' ? r.title : null,
    gate_sha: r.gate_sha,
    why: r.why,
    date: new Date(0).toISOString().slice(0, 10), // placeholder, overwritten by caller with real created_at
    source_ref: r.source_ref,
  }
}

function withCreatedAt(db: Database.Database, entry: KgForCardEntry, nodeId: string): KgForCardEntry {
  const row = db.prepare('SELECT created_at FROM kg_nodes WHERE id = ?').get(nodeId) as
    | { created_at: number }
    | undefined
  return { ...entry, date: row ? new Date(row.created_at * 1000).toISOString().slice(0, 10) : entry.date }
}

/** Builds the dispatch package for a card. Unknown cardId: per the contract, 200 + empty arrays,
 *  never 404 -- this endpoint is advisory and must never block a dispatch over a stale/typo'd id. */
export async function buildForCardPackage(
  db: Database.Database,
  cardId: string,
  opts: KgForCardOptions = {},
): Promise<KgForCardPackage> {
  const k = opts.k ?? 3
  const card = getKanbanCard(cardId)
  if (!card) {
    return {
      card_id: cardId,
      solutions: [],
      known_pitfalls: [],
      decisions: [],
      cross_project_refs: [],
      meta: { scope: GLOBAL_PARTITION, chars: 0, truncated: false },
    }
  }
  const projectPartition = mapProjectToPartition(card.project)
  const searchText = `${card.title} ${card.description ?? ''}`.trim()
  const paths = extractPaths(searchText)
  const commonOpts = {
    q: searchText || undefined,
    paths: paths.length > 0 ? paths : undefined,
    project: projectPartition,
    k,
    strict: false,
    minScore: opts.minScore,
    expandHops: opts.expandHops,
  }

  const [solutionSearch, pitfallSearch, decisionSearch] = await Promise.all([
    hybridKgSearch(db, { ...commonOpts, types: ['solution'] }),
    hybridKgSearch(db, { ...commonOpts, types: ['anti_pattern', 'finding'] }),
    hybridKgSearch(db, { ...commonOpts, types: ['decision'] }),
  ])

  const solutions = solutionSearch.results.map((r) => withCreatedAt(db, toEntry(db, r), r.id))
  const known_pitfalls = pitfallSearch.results.map((r) => withCreatedAt(db, toEntry(db, r), r.id))
  const decisions = decisionSearch.results.map((r) => withCreatedAt(db, toEntry(db, r), r.id))

  // cross_project_refs: 'similar_to'/'of_class' edges from any included node to a node OUTSIDE
  // this card's own project+_global scope -- stub shape only (card_id + error_class), never body.
  const includedIds = [...solutions, ...known_pitfalls, ...decisions].map((e) => e.card_id)
  const crossRefs: KgCrossProjectRef[] = []
  const seenCross = new Set<string>()
  for (const id of includedIds) {
    const rows = db
      .prepare(
        `SELECT n.id AS nid, n.project AS project FROM kg_edges e
         JOIN kg_nodes n ON n.id = e.dst
         WHERE e.src = ? AND e.rel IN ('similar_to','of_class')
         UNION
         SELECT n.id AS nid, n.project AS project FROM kg_edges e
         JOIN kg_nodes n ON n.id = e.src
         WHERE e.dst = ? AND e.rel IN ('similar_to','of_class')`,
      )
      .all(id, id) as { nid: string; project: string }[]
    for (const row of rows) {
      if (row.project === projectPartition || row.project === GLOBAL_PARTITION) continue
      if (seenCross.has(row.nid)) continue
      seenCross.add(row.nid)
      crossRefs.push({ card_id: row.nid, error_class: errorClassOf(db, row.nid) ?? 'unclassified' })
    }
  }

  const pkg: KgForCardPackage = {
    card_id: cardId,
    solutions,
    known_pitfalls,
    decisions,
    cross_project_refs: crossRefs,
    meta: { scope: projectPartition, chars: 0, truncated: false },
  }

  const maxChars = opts.maxChars ?? 3000
  let serialized = JSON.stringify(pkg)
  let truncated = false
  // Drop the lowest-priority entries (decisions first, then known_pitfalls, then solutions --
  // solutions are the highest-value payload for a dispatch) until the package fits, or nothing
  // is left to drop.
  const dropOrder: (keyof KgForCardPackage)[] = ['cross_project_refs', 'decisions', 'known_pitfalls', 'solutions']
  let dropIdx = 0
  while (serialized.length > maxChars && dropIdx < dropOrder.length) {
    const key = dropOrder[dropIdx]
    const arr = pkg[key] as unknown[]
    if (arr.length === 0) {
      dropIdx++
      continue
    }
    arr.pop()
    truncated = true
    serialized = JSON.stringify(pkg)
  }
  pkg.meta.truncated = truncated
  pkg.meta.chars = serialized.length
  return pkg
}
