import { recordCardLanding, listCardLandings } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Card a8a83d48 (F2.1.2): the HTTP surface the land scripts (marveen-land.sh, mopsion-land.sh)
// call AFTER confirming a push actually landed. Writes go through the API, not direct sqlite3,
// the same convention every other land-script write uses (kanban-comment-lib.sh) -- the Node
// process holds the live WAL connection, a shell script writing around it risks lock contention
// on the one table every card's done-guard (F2.2) will read on every close.
export async function tryHandleCardLandings(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/card-landings' && method === 'POST') {
    const body = await readBody(req)
    let parsed: unknown
    try {
      parsed = JSON.parse(body.toString())
    } catch {
      json(res, { error: 'invalid JSON body' }, 400)
      return true
    }
    const { card_id, work_sha, merge_sha, repo, landed_by } = parsed as Record<string, unknown>
    if (
      typeof card_id !== 'string' || !card_id ||
      typeof work_sha !== 'string' || !work_sha ||
      typeof merge_sha !== 'string' || !merge_sha ||
      typeof repo !== 'string' || !repo ||
      typeof landed_by !== 'string' || !landed_by
    ) {
      json(res, { error: 'card_id, work_sha, merge_sha, repo, landed_by are all required strings' }, 400)
      return true
    }
    try {
      const inserted = recordCardLanding({ card_id, work_sha, merge_sha, repo, landed_by })
      json(res, { ok: true, inserted })
    } catch (err) {
      // FOREIGN KEY constraint failed -- card_id does not name a real card.
      json(res, { error: err instanceof Error ? err.message : String(err) }, 400)
    }
    return true
  }

  const getMatch = path.match(/^\/api\/card-landings\/([^/]+)$/)
  if (getMatch && method === 'GET') {
    json(res, listCardLandings(decodeURIComponent(getMatch[1]!)))
    return true
  }

  return false
}
