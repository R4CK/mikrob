// MT-03 (card 34c2d2a2): hybrid search (FTS5 + nomic embedding + anchor match) with a bounded
// graph-expansion pass over kg_edges. Reuses the memory subsystem's existing hybridSearch
// building blocks (src/db.ts: generateEmbedding, cosineSimilarity, buildFtsMatchExpression)
// rather than writing a second embedding client or a second FTS-term sanitizer, per the
// MODULTERV's own instruction ("A memória hybridSearch mintáját használd újra").
//
// Scope resolution follows the F2 contract (3f6fc4ce comment 20763, MikroB decision 20758/20814,
// D2/D3): the caller's OWN project (derived from `project` or `card_id`) is the default, plus the
// `_global` partition (D3: not a foreign project, never excluded). `project=*` (or an explicit
// comma list) is the only way to see another project's nodes, and only because the caller asked.

import type Database from 'better-sqlite3'
import { generateEmbedding, cosineSimilarity, getKanbanCard, buildFtsMatchExpression } from '../db.js'
import { mapProjectToPartition, GLOBAL_PARTITION } from './project-map.js'
import { KG_NODE_TYPES, KG_EDGE_RELS, type KgNodeType } from './schema.js'
import { logger } from '../logger.js'

export class KgSearchError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

export interface KgSearchAnchor {
  repo: string
  path: string
  symbol: string | null
  line_start: number | null
  line_end: number | null
  sha: string
  state: 'fresh' | 'drifted' | 'gone'
}

export interface KgSearchResult {
  id: string
  type: KgNodeType
  project: string
  title: string
  body: string | null
  snippet: string | null
  snippet_lang: string | null
  status: string
  score: number
  why: string
  anchors: KgSearchAnchor[]
  source_ref: string
  gate_sha: string | null
}

export interface KgSearchMeta {
  relaxed: boolean
  hits: number
  scope: string
  strict: boolean
}

export interface KgSearchOptions {
  q?: string
  project?: string
  cardId?: string
  paths?: string[]
  k?: number
  types?: string[]
  strict?: boolean
  minScore?: number
  expandHops?: number
  snippetMaxLines?: number
}

interface ScopeResolution {
  /** null means no restriction (project=* wildcard: every partition). */
  partitions: string[] | null
  label: string
}

/** Resolves the partition filter per the F2/D2/D3 contract. Throws KgSearchError('project_or_card_id_required')
 *  when neither `project` nor `cardId` was given -- the 400 the route contract requires. */
export function resolveScope(opts: Pick<KgSearchOptions, 'project' | 'cardId'>): ScopeResolution {
  if (opts.project && opts.project.trim() === '*') {
    return { partitions: null, label: '*' }
  }
  if (opts.project && opts.project.trim()) {
    const parts = opts.project.split(',').map((p) => mapProjectToPartition(p.trim()))
    return { partitions: [...new Set([...parts, GLOBAL_PARTITION])], label: opts.project }
  }
  if (opts.cardId) {
    const card = getKanbanCard(opts.cardId)
    // Card not found (bad/stale id): fall back to the _global-only partition rather than
    // guessing a project or erroring -- the safe default is "nothing project-specific leaks",
    // not a 400 for what is very often just a typo on an advisory lookup.
    const partition = card ? mapProjectToPartition(card.project) : GLOBAL_PARTITION
    return { partitions: [...new Set([partition, GLOBAL_PARTITION])], label: partition }
  }
  throw new KgSearchError('project_or_card_id_required')
}

const SEARCHABLE_STATUSES = ['active', 'stale']
const MIN_VECTOR_SIMILARITY = 0.15

type NodeRow = {
  id: string
  type: KgNodeType
  project: string
  title: string
  body: string | null
  snippet: string | null
  snippet_lang: string | null
  status: string
  source_ref: string
  gate_sha: string | null
  embedding: Buffer | null
}

function partitionWhere(partitions: string[] | null, alias = 'n'): { sql: string; params: string[] } {
  if (partitions === null) return { sql: '1=1', params: [] }
  return { sql: `${alias}.project IN (${partitions.map(() => '?').join(',')})`, params: partitions }
}

function typesWhere(types: string[] | undefined, alias = 'n'): { sql: string; params: string[] } {
  if (!types || types.length === 0) return { sql: '1=1', params: [] }
  const valid = types.filter((t): t is KgNodeType => (KG_NODE_TYPES as readonly string[]).includes(t))
  if (valid.length === 0) throw new KgSearchError('invalid_types')
  return { sql: `${alias}.type IN (${valid.map(() => '?').join(',')})`, params: valid }
}

function clampLines(text: string | null, maxLines: number): string | null {
  if (!text) return text
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return lines.slice(0, maxLines).join('\n') + `\n...(${lines.length - maxLines} more lines)`
}

function loadAnchors(db: Database.Database, nodeId: string): KgSearchAnchor[] {
  return db
    .prepare('SELECT repo, path, symbol, line_start, line_end, sha, state FROM kg_anchors WHERE node_id = ?')
    .all(nodeId) as KgSearchAnchor[]
}

function toResult(
  db: Database.Database,
  row: NodeRow,
  score: number,
  why: string,
  snippetMaxLines: number,
): KgSearchResult {
  return {
    id: row.id,
    type: row.type,
    project: row.project,
    title: row.title,
    body: row.body,
    snippet: clampLines(row.snippet, snippetMaxLines),
    snippet_lang: row.snippet_lang,
    status: row.status,
    score,
    why,
    anchors: loadAnchors(db, row.id),
    source_ref: row.source_ref,
    gate_sha: row.gate_sha,
  }
}

/** The hybrid search itself. Three independent seed branches (FTS text, embedding vector, exact
 *  anchor-path match) fused by Reciprocal Rank Fusion (same constant/shape as src/db.ts's
 *  hybridSearch for memories), then an optional bounded graph-expansion pass that adds each seed's
 *  kg_edges neighbors at a decayed score. Every branch is scoped to `partitions` up front, in SQL,
 *  not as a post-filter -- so a tight k never starves on cross-project noise it should never have
 *  seen (same reasoning as MEMKERESVAK917 in src/db.ts). */
export async function hybridKgSearch(
  db: Database.Database,
  opts: KgSearchOptions,
): Promise<{ results: KgSearchResult[]; meta: KgSearchMeta }> {
  const scope = resolveScope(opts)
  const k = opts.k ?? 3
  const minScore = opts.minScore ?? 0.35
  const expandHops = opts.expandHops ?? 1
  const snippetMaxLines = opts.snippetMaxLines ?? 60
  const strict = opts.strict ?? false
  const pw = partitionWhere(scope.partitions)
  const tw = typesWhere(opts.types)
  const statusSql = `n.status IN (${SEARCHABLE_STATUSES.map(() => '?').join(',')})`
  const baseWhere = `${pw.sql} AND ${tw.sql} AND ${statusSql}`
  const baseParams = [...pw.params, ...tw.params, ...SEARCHABLE_STATUSES]

  const byId = new Map<string, { row: NodeRow; score: number; why: string }>()
  let relaxed = false

  // Branch 1: FTS5 text search (only when a query was given).
  if (opts.q && opts.q.trim()) {
    const runFts = (terms: string): (NodeRow & { rank: number })[] =>
      db
        .prepare(
          `SELECT n.*, f.rank AS rank FROM kg_nodes n
           JOIN kg_nodes_fts f ON n.rowid = f.rowid
           WHERE f.kg_nodes_fts MATCH ? AND ${baseWhere}
           ORDER BY rank LIMIT ?`,
        )
        .all(terms, ...baseParams, k * 4) as (NodeRow & { rank: number })[]
    const strictTerms = buildFtsMatchExpression(opts.q)
    let ftsRows = strictTerms ? runFts(strictTerms) : []
    if (ftsRows.length === 0 && !strict && strictTerms) {
      const relaxedTerms = buildFtsMatchExpression(opts.q, 'OR')
      if (relaxedTerms !== strictTerms) {
        ftsRows = runFts(relaxedTerms)
        if (ftsRows.length > 0) relaxed = true
      }
    }
    ftsRows.forEach((row, rank) => {
      const entry = byId.get(row.id)
      const contribution = 1 / (60 + rank + 1)
      if (entry) entry.score += contribution
      else byId.set(row.id, { row, score: contribution, why: `szöveg-egyezés: "${opts.q}"` })
    })

    // Branch 2: embedding vector search, fused by the same RRF constant.
    const queryEmbedding = await generateEmbedding(opts.q)
    if (queryEmbedding) {
      const candidates = db
        .prepare(`SELECT n.* FROM kg_nodes n WHERE ${baseWhere} AND n.embedding IS NOT NULL`)
        .all(...baseParams) as NodeRow[]
      const scored = candidates
        .flatMap((row) => {
          try {
            const emb = JSON.parse(row.embedding!.toString()) as number[]
            if (emb.length !== queryEmbedding.length) return []
            return [{ row, sim: cosineSimilarity(queryEmbedding, emb) }]
          } catch {
            return []
          }
        })
        .filter((s) => s.sim >= MIN_VECTOR_SIMILARITY)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, k * 4)
      scored.forEach(({ row }, rank) => {
        const entry = byId.get(row.id)
        const contribution = 1 / (60 + rank + 1)
        if (entry) entry.score += contribution
        else byId.set(row.id, { row, score: contribution, why: 'szemantikai egyezés (embedding)' })
      })
    }
  }

  // Branch 3: exact anchor-path match -- independent of q, always exact (never relaxed).
  if (opts.paths && opts.paths.length > 0) {
    for (const path of opts.paths) {
      const rows = db
        .prepare(
          `SELECT DISTINCT n.* FROM kg_nodes n
           JOIN kg_anchors a ON a.node_id = n.id
           WHERE a.path = ? AND ${baseWhere}`,
        )
        .all(path, ...baseParams) as NodeRow[]
      for (const row of rows) {
        const entry = byId.get(row.id)
        const why = `horgony-egyezés: ${path}`
        if (entry) {
          entry.score += 1
          entry.why = why
        } else {
          byId.set(row.id, { row, score: 1, why })
        }
      }
    }
  }

  if (!opts.q?.trim() && !(opts.paths && opts.paths.length > 0)) {
    throw new KgSearchError('q_or_path_required')
  }

  let seeds = [...byId.values()].filter((e) => e.score >= minScore || e.why.startsWith('horgony-egyezés'))
  seeds.sort((a, b) => b.score - a.score)
  seeds = seeds.slice(0, k)

  const final = new Map<string, { row: NodeRow; score: number; why: string }>()
  for (const s of seeds) final.set(s.row.id, s)

  // Bounded graph expansion over kg_edges, decayed per hop, same project/type/status scope.
  let frontier = seeds
  for (let hop = 1; hop <= expandHops && final.size < k * 2; hop++) {
    const nextFrontier: typeof seeds = []
    for (const seed of frontier) {
      const edges = db
        .prepare(`SELECT dst, rel FROM kg_edges WHERE src = ? UNION SELECT src AS dst, rel FROM kg_edges WHERE dst = ?`)
        .all(seed.row.id, seed.row.id) as { dst: string; rel: string }[]
      for (const edge of edges) {
        if (final.has(edge.dst)) continue
        const row = db
          .prepare(`SELECT n.* FROM kg_nodes n WHERE n.id = ? AND ${baseWhere}`)
          .get(edge.dst, ...baseParams) as NodeRow | undefined
        if (!row) continue
        const decayed = seed.score * Math.pow(0.5, hop)
        if (decayed < minScore) continue
        const entry = { row, score: decayed, why: `${hop} ugrás: ${edge.rel} <- ${seed.row.title}` }
        final.set(row.id, entry)
        nextFrontier.push(entry)
      }
    }
    frontier = nextFrontier
  }

  const ranked = [...final.values()].sort((a, b) => b.score - a.score).slice(0, k)
  if (ranked.length === 0 && byId.size > 0) {
    logger.warn({ q: opts.q, scope: scope.label }, 'kg-search: candidates found but none met KG_MIN_SCORE')
  }
  const results = ranked.map((e) => toResult(db, e.row, e.score, e.why, snippetMaxLines))
  return {
    results,
    meta: { relaxed, hits: results.length, scope: scope.label, strict },
  }
}

// Re-exported so route/CLI callers that only need the edge vocabulary (e.g. for a `why` label on
// an already-fetched edge) are not forced to import schema.ts directly.
export { KG_EDGE_RELS }
