// MT-10d (card 33e5e4ff, parent 81593084): imports rejected alternatives into the knowledge
// graph as `anti_pattern` nodes, linked to the card they were rejected on/for via `rejected_for`
// edges.
//
// SOURCE DECISION (MikroB, card 33e5e4ff comment 22279, unblocking the card's own open question):
// no new structured "rejected alternative" store is built. Exactly two existing sources count:
// (1) kanban_comments whose content has a line starting with `Draft-Review: ELUTASITVA` (the
//     card 1338e68b convention -- a local-LLM draft the role agent reviewed and rejected);
// (2) DECISIONS.md entries whose own `Döntés` field line (the bold `**Döntés: ...**` heading this
//     log already uses, per entries like line 21028) says ELUTASÍTVA/ELUTASITVA/VISSZAVONVA/NO-GO.
// The match is deliberately scoped to the Döntés field's own line, not the whole entry body --
// several entries in this file DISCUSS the word "ELUTASITVA" as a convention (e.g. explaining the
// Draft-Review marker itself) without the entry itself being a rejection; scanning the whole body
// would misclassify those as anti-patterns.
//
// Deterministic text matching, same posture as import-decisions-log.ts (MT-10b) and
// import-findings.ts (MT-10a): reuses that module's entry-splitting and card-reference extraction
// rather than re-implementing them, since DECISIONS.md's `## ` heading convention is one fact, not
// two.
//
// Idempotent by construction: a comment-sourced node id is derived from the stable
// kanban_comments.id (`anti_pattern:comment:<id>`); a decision-sourced node id is derived from the
// entry's 1-indexed heading line number (`anti_pattern:decision:L<n>`), same stability argument as
// decision:L<n> in import-decisions-log.ts (DECISIONS.md is append-only). Atomic: one kgDb
// transaction, a bad row rolls back the whole run.

import type Database from 'better-sqlite3'
import { upsertNode, upsertEdge } from './store.js'
import { mapProjectToPartition } from './project-map.js'
import { parseEntries, referencedCardIds } from './import-decisions-log.js'

export interface AntiPatternsImportReport {
  commentsScanned: number
  commentAntiPatternsUpserted: number
  decisionsScanned: number
  decisionAntiPatternsUpserted: number
  rejectedForEdges: number
  cardRefsSkippedMissing: number
}

interface CardRow {
  id: string
  title: string
  project: string | null
}

interface CommentRow {
  id: number
  card_id: string
  content: string
}

// Sor elején, a Gate-SHA/Draft-Review konvenció mintájára (sor elején, de nem kell az egész
// komment első sora legyen) -- lásd card 1338e68b.
const DRAFT_REVIEW_REJECTED_RX = /^Draft-Review:\s*ELUTASITVA\b/m

// A "Döntés" mezősor felismerése (opcionális markdown bold `**`, "Döntés"/"Dontes" ékezet nélkül
// is, kettőspont opcionális -- a fájlban mindkét írásmód előfordul), a tényleges verdikt-szó
// ugyanazon a soron.
const DECISION_FIELD_LINE_RX = /^\*{0,2}D[öo]nt[ée]s(ek)?\*{0,2}:?/
const REJECTED_WORD_RX = /ELUTAS[IÍ]TVA|VISSZAVONVA|NO-GO/i

function commentAntiPatternNodeId(commentId: number): string {
  return `anti_pattern:comment:${commentId}`
}

function decisionAntiPatternNodeId(lineNumber: number): string {
  return `anti_pattern:decision:L${lineNumber}`
}

function cardNodeId(cardId: string): string {
  return `card:${cardId}`
}

/** The entry's Döntés field line, if it both exists and carries a rejection word -- or undefined
 *  if the entry isn't a rejection (including entries that merely discuss the words elsewhere in
 *  their body, which this intentionally does not match). */
function rejectionDecisionLine(entryText: string): string | undefined {
  for (const line of entryText.split('\n')) {
    if (DECISION_FIELD_LINE_RX.test(line) && REJECTED_WORD_RX.test(line)) return line.trim()
  }
  return undefined
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

/** Imports rejected alternatives (Draft-Review: ELUTASITVA comments + rejected DECISIONS.md
 *  entries) into the graph as `anti_pattern` nodes with `rejected_for` edges to the card they were
 *  rejected on/for. `decisionsMarkdown` is injected (not read from disk here) so tests and a
 *  future multi-repo caller can point it at any DECISIONS.md snapshot, same posture as
 *  importDecisionsLog's own `markdown` parameter. */
export function importAntiPatterns(
  mainDb: Database.Database,
  kgDb: Database.Database,
  decisionsMarkdown: string,
  decisionsProject: string,
  sourcePath: string = 'DECISIONS.md',
): AntiPatternsImportReport {
  const report: AntiPatternsImportReport = {
    commentsScanned: 0,
    commentAntiPatternsUpserted: 0,
    decisionsScanned: 0,
    decisionAntiPatternsUpserted: 0,
    rejectedForEdges: 0,
    cardRefsSkippedMissing: 0,
  }
  const lookup = makeCardLookup(mainDb)
  const cardNodesWritten = new Set<string>()

  function linkToCard(antiPatternId: string, cardId: string, extractor: string): void {
    const card = lookup(cardId)
    if (!card) {
      report.cardRefsSkippedMissing += 1
      return
    }
    const cNodeId = cardNodeId(cardId)
    if (!cardNodesWritten.has(cNodeId)) {
      cardNodesWritten.add(cNodeId)
      upsertNode(kgDb, {
        id: cNodeId,
        type: 'card',
        project: mapProjectToPartition(card.project),
        title: card.title,
        source_ref: `kanban_cards:${card.id}`,
        extractor,
      })
    }
    if (
      upsertEdge(kgDb, { src: antiPatternId, dst: cNodeId, rel: 'rejected_for', source: extractor }) >
      0
    ) {
      report.rejectedForEdges += 1
    }
  }

  // Coarse SQL pre-filter, precise match in JS (same split as import-findings.ts's verdict
  // filter): keeps the query simple while the actual "line starts with Draft-Review: ELUTASITVA"
  // decision stays in one place, testable without a DB.
  const comments = mainDb
    .prepare(`SELECT id, card_id, content FROM kanban_comments WHERE content LIKE '%Draft-Review%'`)
    .all() as CommentRow[]
  report.commentsScanned = comments.length

  const decisionEntries = parseEntries(decisionsMarkdown)
  report.decisionsScanned = decisionEntries.length

  const runImport = kgDb.transaction(() => {
    const extractor = 'import:anti_patterns'

    for (const c of comments) {
      if (!DRAFT_REVIEW_REJECTED_RX.test(c.content)) continue
      const id = commentAntiPatternNodeId(c.id)
      const card = lookup(c.card_id)
      upsertNode(kgDb, {
        id,
        type: 'anti_pattern',
        project: mapProjectToPartition(card?.project ?? null),
        title: `Draft-Review: ELUTASITVA (kanban_comments:${c.id})`,
        body: c.content,
        source_ref: `kanban_comments:${c.id}`,
        extractor,
      })
      report.commentAntiPatternsUpserted += 1
      linkToCard(id, c.card_id, extractor)
    }

    for (const entry of decisionEntries) {
      const entryText = `${entry.title}\n${entry.body}`
      const decisionLine = rejectionDecisionLine(entryText)
      if (!decisionLine) continue
      const id = decisionAntiPatternNodeId(entry.lineNumber)
      upsertNode(kgDb, {
        id,
        type: 'anti_pattern',
        project: decisionsProject,
        title: entry.title || decisionLine,
        body: entry.body || null,
        source_ref: `${sourcePath}:L${entry.lineNumber}`,
        extractor,
      })
      report.decisionAntiPatternsUpserted += 1

      for (const cardId of referencedCardIds(entryText)) {
        linkToCard(id, cardId, extractor)
      }
    }
  })
  runImport()

  return report
}
