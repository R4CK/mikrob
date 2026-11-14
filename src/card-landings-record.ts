import { getDb } from './db.js'

/**
 * The read/write lib for the `card_landings` table (card ec34c025, rescope point 5 of ed332869).
 *
 * Extracted out of db.ts so the write side (this module, used today by the
 * `/api/card-landings` route that marveen-land.sh/mopsion-land.sh call after a verified push)
 * and a future read side (kanban-landed-guard.ts, card F4.3 -- not built yet, deliberately out
 * of scope here) import the SAME functions instead of each growing their own copy of the table
 * access. db.ts re-exports both names unchanged, so no existing import site moves.
 */

/**
 * Record a land script's VERIFIED landing of a card (F2.1.2, card a8a83d48 -- the write side of
 * card_landings, F2.1.1/8e99d55d). Callers must only call this AFTER confirming the push landed
 * (fetch + merge-base --is-ancestor against the remote) -- this function does no verification of
 * its own, it only records what the caller already confirmed.
 *
 * landed_at is ALWAYS taken server-side (Math.floor(Date.now()/1000)), never from the caller: the
 * whole point of this table is a timestamp nothing but the server can forge, and the CHECK
 * constraint on the column exists for writers that bypass this function entirely (direct sqlite3).
 *
 * INSERT OR IGNORE, same reasoning as writeRelationEdges in db.ts: a land script that calls this
 * twice for the same (repo, merge_sha, card_id) -- e.g. a retried HTTP call after a dropped
 * response -- must not crash or duplicate the row; the unique index is the guarantee, not the
 * caller's care. Returns false when the row already existed (not an error).
 */
export function recordCardLanding(landing: {
  card_id: string
  work_sha: string
  merge_sha: string
  repo: string
  landed_by: string
}): boolean {
  const now = Math.floor(Date.now() / 1000)
  const { changes } = getDb()
    .prepare(
      `INSERT OR IGNORE INTO card_landings (card_id, work_sha, merge_sha, repo, landed_at, landed_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(landing.card_id, landing.work_sha, landing.merge_sha, landing.repo, now, landing.landed_by)
  return changes > 0
}

/** Every recorded landing for a card, most recent first -- what the done-guard (F2.2) and a
 *  future "is this sha actually landed" reader ask. */
export function listCardLandings(cardId: string): {
  card_id: string
  work_sha: string
  merge_sha: string
  repo: string
  landed_at: number
  landed_by: string
}[] {
  return getDb()
    .prepare(
      `SELECT card_id, work_sha, merge_sha, repo, landed_at, landed_by
       FROM card_landings WHERE card_id = ? ORDER BY landed_at DESC`,
    )
    .all(cardId) as {
    card_id: string
    work_sha: string
    merge_sha: string
    repo: string
    landed_at: number
    landed_by: string
  }[]
}
