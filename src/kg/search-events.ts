// Card a1d57d99: append-only log of agent search activity (/api/kg/search and
// /api/kg/for-card calls), plus the read side for the FE's live-graph polling.
// Deliberately NOT kg_usage (schema.ts comment on V3): kg_usage is the offered/used feedback
// contract with its own anti-inflation rule; this is a general audit trail.
import type Database from 'better-sqlite3'
import { redactKgLocalSecretsForLog } from './store.js'

const MAX_QUERY_LEN = 2000

export interface KgSearchEventInput {
  agent: string
  tsMs: number
  query: string | null | undefined
  hitNodeIds: readonly string[]
}

export interface KgActivityEvent {
  agent_id: string
  ts: number
  hit: string[]
}

/** Records one search event, best-effort retention trim included. Query text is truncated AND
 *  redacted (kv-secret / key-context hex64-base64) before it ever reaches the table -- a raw
 *  secret-shaped query is never persisted, even though the search itself already ran on it. */
export function recordKgSearchEvent(
  db: Database.Database,
  input: KgSearchEventInput,
  retentionRows: number
): void {
  const truncated = input.query ? input.query.slice(0, MAX_QUERY_LEN) : null
  const redacted = redactKgLocalSecretsForLog(truncated)
  db.prepare(
    `INSERT INTO kg_search_events (agent, ts_ms, query, hit_node_ids) VALUES (?, ?, ?, ?)`
  ).run(input.agent, input.tsMs, redacted, JSON.stringify(input.hitNodeIds))

  if (retentionRows > 0) {
    db.prepare(
      `DELETE FROM kg_search_events WHERE id NOT IN (
         SELECT id FROM kg_search_events ORDER BY id DESC LIMIT ?
       )`
    ).run(retentionRows)
  }
}

/** Events strictly newer than `sinceMs`, oldest first, capped at `limit` rows. */
export function getKgActivityEvents(
  db: Database.Database,
  sinceMs: number,
  limit: number
): KgActivityEvent[] {
  const rows = db
    .prepare(
      `SELECT agent, ts_ms, hit_node_ids FROM kg_search_events
       WHERE ts_ms > ? ORDER BY ts_ms ASC LIMIT ?`
    )
    .all(sinceMs, limit) as { agent: string; ts_ms: number; hit_node_ids: string }[]

  return rows.map((row) => ({
    agent_id: row.agent,
    ts: row.ts_ms,
    hit: JSON.parse(row.hit_node_ids) as string[],
  }))
}
