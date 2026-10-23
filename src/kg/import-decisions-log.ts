// MT-10b (card bb0cadd9, parent 81593084): imports DECISIONS.md into the knowledge graph as
// `decision` nodes, linked to the cards they govern via `governs` edges.
//
// Deterministic text parsing, same spirit as import-from-relations.ts (MT-01): no local-LLM
// classification involved, so there is no judgment call to get wrong -- the only question is
// "where does one entry end and the next begin", which the file's own `## ` heading convention
// (project-decisions-log skill) already answers for every entry seen so far (569/569 headings
// checked against this file).
//
// Idempotent by construction: the node id is derived from the 1-indexed line number of the entry's
// heading (`decision:L<n>`), and DECISIONS.md is append-only (project-decisions-log skill) -- a
// line number already assigned to an entry never gets reassigned to different content, so
// re-running the import over the same file upserts the same rows rather than duplicating them.

import type Database from 'better-sqlite3'
import { upsertNode, upsertEdge } from './store.js'

export interface DecisionsImportReport {
  entriesParsed: number
  decisionsUpserted: number
  governsEdges: number
  cardRefsSkippedMissing: number
}

interface CardRow {
  id: string
  title: string
  project: string | null
}

export interface ParsedEntry {
  lineNumber: number
  title: string
  body: string
}

const HEADING_RX = /^## /
// Card ids in this fleet are 8 lowercase-hex-char tokens (see kanban-card creation) -- the same
// shape a git short-sha can have, which is exactly why every match below is verified against
// kanban_cards before it becomes an edge, rather than trusted on shape alone.
const CARD_ID_RX = /\b[0-9a-f]{8}\b/g

/** Splits the raw markdown on `## ` heading lines. Each entry runs from its heading to the line
 *  before the next heading (or EOF) -- the `---` separators some older entries also use are left
 *  inside the body untouched, since they carry no information this importer needs. */
export function parseEntries(markdown: string): ParsedEntry[] {
  const lines = markdown.split('\n')
  const headingIdx: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (HEADING_RX.test(lines[i]!)) headingIdx.push(i)
  }
  const entries: ParsedEntry[] = []
  for (let h = 0; h < headingIdx.length; h++) {
    const start = headingIdx[h]!
    const end = h + 1 < headingIdx.length ? headingIdx[h + 1]! : lines.length
    const title = lines[start]!.replace(HEADING_RX, '').trim()
    const body = lines.slice(start + 1, end).join('\n').trim()
    entries.push({ lineNumber: start + 1, title, body }) // +1: 1-indexed line number
  }
  return entries
}

/** Every distinct 8-hex-char token in the entry text. Deliberately NOT filtered against
 *  kanban_cards here -- the caller's lookup is the one and only place that decides real-card vs.
 *  lookalike (e.g. a commit sha mentioned in "Hivatkozás"), so a token that fails the check is
 *  countable (cardRefsSkippedMissing) instead of silently vanishing before the caller ever sees it. */
export function referencedCardIds(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(CARD_ID_RX)) seen.add(m[0])
  return [...seen]
}

function decisionNodeId(lineNumber: number): string {
  return `decision:L${lineNumber}`
}

function cardNodeId(cardId: string): string {
  return `card:${cardId}`
}

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

/** Imports one DECISIONS.md snapshot into the graph. `sourcePath` names the file in source_ref
 *  (e.g. 'DECISIONS.md') so a future multi-repo caller (mopsion has its own DECISIONS.md) can
 *  reuse this with a different label without the graph confusing the two files' line numbers. */
export function importDecisionsLog(
  markdown: string,
  mainDb: Database.Database,
  kgDb: Database.Database,
  project: string,
  sourcePath: string = 'DECISIONS.md',
): DecisionsImportReport {
  const report: DecisionsImportReport = {
    entriesParsed: 0,
    decisionsUpserted: 0,
    governsEdges: 0,
    cardRefsSkippedMissing: 0,
  }
  const lookup = makeCardLookup(mainDb)
  const entries = parseEntries(markdown)
  report.entriesParsed = entries.length

  const runImport = kgDb.transaction(() => {
    for (const entry of entries) {
      const id = decisionNodeId(entry.lineNumber)
      upsertNode(kgDb, {
        id,
        type: 'decision',
        project,
        title: entry.title || `(no title, line ${entry.lineNumber})`,
        body: entry.body || null,
        source_ref: `${sourcePath}:L${entry.lineNumber}`,
        extractor: 'import:decisions_log',
      })
      report.decisionsUpserted += 1

      const cardIds = referencedCardIds(`${entry.title}\n${entry.body}`)
      for (const cardId of cardIds) {
        const card = lookup(cardId)
        if (!card) {
          report.cardRefsSkippedMissing += 1
          continue
        }
        if (!kgDb.prepare('SELECT 1 FROM kg_nodes WHERE id = ?').get(cardNodeId(cardId))) {
          upsertNode(kgDb, {
            id: cardNodeId(cardId),
            type: 'card',
            project,
            title: card.title,
            source_ref: `kanban_cards:${cardId}`,
            extractor: 'import:decisions_log',
          })
        }
        if (
          upsertEdge(kgDb, {
            src: id,
            dst: cardNodeId(cardId),
            rel: 'governs',
            source: 'import:decisions_log',
          }) > 0
        ) {
          report.governsEdges += 1
        }
      }
    }
  })
  runImport()

  return report
}
