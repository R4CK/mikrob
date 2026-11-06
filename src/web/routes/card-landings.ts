import { recordCardLanding, listCardLandings } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import { verifyCardLanding } from '../../card-landing-ancestry.js'
import type { RouteContext } from './types.js'

// Cybersec2 NO-GO (card a8a83d48, Gate-SHA 77e8a3751, F4 HIGH): a malformed/attack-shaped card_id
// must be rejected HERE, before verifyCardLanding does any `git fetch` -- a fetch can legitimately
// take a couple of seconds, which would mask whether the real fix (no RegExp built from card_id
// inside verifyCardLanding) is actually synchronous and fast. Matches the board's real id shape
// (src/web/routes/kanban.ts: `randomUUID().slice(0, 8)`).
const CARD_ID_RE = /^[0-9a-f]{8}$/

// Card a8a83d48 (F2.1.2): the HTTP surface the land scripts (marveen-land.sh, mopsion-land.sh)
// call AFTER confirming a push actually landed. Writes go through the API, not direct sqlite3,
// the same convention every other land-script write uses (kanban-comment-lib.sh) -- the Node
// process holds the live WAL connection, a shell script writing around it risks lock contention
// on the one table every card's done-guard (F2.2) will read on every close.
//
// MikroB rescope (comment 27940 point 6) + Cybersec2 NO-GO (card a8a83d48, Gate-SHA 6cc529f3d,
// F1 HIGH; round 2, Gate-SHA 77e8a3751, F4/F5): this endpoint does NOT trust the caller's claim
// that a push landed, and does not trust merge_sha alone either -- verifyCardLanding resolves
// both shas to real commit objects, re-verifies merge_sha against origin/<default branch>, and
// requires work_sha to equal merge_sha's SECOND PARENT (the branch tip the land script itself
// merged in), never a text match against a commit subject. The original version only checked
// "merge_sha is some ancestor of origin" (round 1), then bound the card via a regex scan over
// commit subjects (round 2) -- both let a caller record landings for the wrong card or, with a
// crafted card_id, hang the whole process.
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
    if (!CARD_ID_RE.test(card_id)) {
      json(res, { error: 'card_id must be an 8-character lowercase hex id' }, 400)
      return true
    }
    const verdict = await verifyCardLanding(repo, card_id, work_sha, merge_sha)
    if (!verdict.ok) {
      json(res, { error: verdict.reason }, 422)
      return true
    }
    try {
      const inserted = recordCardLanding({
        card_id,
        work_sha: verdict.workSha,
        merge_sha: verdict.mergeSha,
        repo,
        landed_by,
      })
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
