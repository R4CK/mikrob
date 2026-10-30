// MT-08 (card 1a350f22, MikroB decision comment 26148): usage feedback for kg_usage.
// 'offered' rows are written by the for-card route (src/web/routes/kg.ts) whenever a package is
// served for a card. 'used'/'not_relevant'/'harmful' rows are parsed out of a REVIEW comment's
// `Megoldás-tár:` line and written here when a POST /api/kanban/:id/comments creates that
// comment. Anti-inflation (MikroB's explicit condition): a feedback row for (card_id, node_id)
// is only recorded if an 'offered' row already exists for that exact pair, so an agent cannot
// inflate used/not_relevant/harmful counts for a node id it was never actually shown.
import type Database from 'better-sqlite3'

export type KgUsageFeedback = 'used' | 'not_relevant' | 'harmful'

/** Records one 'offered' row per node, for a for-card package actually served for `cardId`.
 *  Idempotent per (node_id, card_id): kg_usage has no DB-level unique constraint (it is
 *  append-only by design, schema.ts), so a second for-card call for the same card must not
 *  duplicate the offered row -- the dedup check runs here instead. */
export function recordKgOffered(db: Database.Database, cardId: string, nodeIds: string[], agent: string): void {
  const now = Math.floor(Date.now() / 1000)
  const existsStmt = db.prepare(
    `SELECT 1 FROM kg_usage WHERE card_id = ? AND node_id = ? AND event = 'offered' LIMIT 1`,
  )
  const insertStmt = db.prepare(
    `INSERT INTO kg_usage (node_id, card_id, agent, event, created_at) VALUES (?, ?, ?, 'offered', ?)`,
  )
  for (const nodeId of new Set(nodeIds)) {
    if (existsStmt.get(cardId, nodeId)) continue
    insertStmt.run(nodeId, cardId, agent, now)
  }
}

/** True only if an 'offered' row exists for this exact (card_id, node_id) pair. */
function wasOffered(db: Database.Database, cardId: string, nodeId: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM kg_usage WHERE card_id = ? AND node_id = ? AND event = 'offered' LIMIT 1`)
    .get(cardId, nodeId)
}

/** Records a used/not_relevant/harmful feedback row, but ONLY if the node was actually offered
 *  to this card first -- returns false (no-op, nothing written) otherwise. This is the
 *  anti-inflation gate: a REVIEW comment cannot create feedback for a node id typed in by hand
 *  that this card was never actually shown. */
export function recordKgUsageFeedback(
  db: Database.Database,
  cardId: string,
  nodeId: string,
  agent: string,
  event: KgUsageFeedback,
): boolean {
  if (!wasOffered(db, cardId, nodeId)) return false
  db.prepare(`INSERT INTO kg_usage (node_id, card_id, agent, event, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    nodeId,
    cardId,
    agent,
    event,
    Math.floor(Date.now() / 1000),
  )
  return true
}

// Matches a REVIEW comment's "Megoldás-tár: <id> felhasznalva" line (MODULTERV section 8, MT-08).
// Accepts the accented and plain-ASCII spellings (this fleet's own shell output is routinely
// ASCII-folded), plus "artalmas"/"ártalmas"/"harmful" -- a fourth keyword this card adds for the
// 'harmful' feedback MODULTERV section 11's "Rossz vagy ártó megoldás" élhelyzet describes: the
// three MT-07 REVIEW-template words (felhasznalva/nem illett/nincs talalat) do not cover it, and
// kg_usage's own CHECK constraint (schema.ts) already reserves 'harmful' as a fourth value, so
// this completes an existing contract rather than inventing a new one.
const MEGOLDAS_TAR_LINE = /^\s*Megold[aá]s-t[aá]r:\s*(\S+)\s+(felhaszn[aá]lva|nem illett|nincs tal[aá]lat|[aá]rtalmas|harmful)/gim

function normalizeVerb(raw: string): KgUsageFeedback | null {
  const v = raw.toLowerCase()
  if (v.startsWith('felhasz')) return 'used'
  if (v.startsWith('nem illett')) return 'not_relevant'
  if (v.startsWith('nincs')) return null // "nincs talalat": a complete, valid answer, but no node id to record feedback against
  if (v.startsWith('artalmas') || v.startsWith('ártalmas') || v === 'harmful') return 'harmful'
  return null
}

export interface ParsedMegoldasTarLine {
  nodeId: string
  event: KgUsageFeedback
}

/** Extracts every `Megoldás-tár: <id> <verb>` line from a REVIEW comment body. A "nincs talalat"
 *  line carries no node id to record against and is skipped on purpose -- it is a complete,
 *  valid MT-07 answer, just not a feedback EVENT. Malformed lines (missing id, unrecognised
 *  verb) are skipped silently: this is a convenience signal parsed out of free text, and must
 *  never be able to fail a comment POST. */
export function parseMegoldasTarLines(content: string): ParsedMegoldasTarLine[] {
  const out: ParsedMegoldasTarLine[] = []
  for (const m of content.matchAll(MEGOLDAS_TAR_LINE)) {
    const nodeId = m[1]
    const event = normalizeVerb(m[2] ?? '')
    if (nodeId && event) out.push({ nodeId, event })
  }
  return out
}
