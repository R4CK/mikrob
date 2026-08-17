import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  listKanbanCards, createKanbanCard, updateKanbanCard,
  deleteKanbanCard, moveKanbanCard, archiveKanbanCard, unarchiveKanbanCard,
  getKanbanComments, addKanbanComment, getKanbanCardEvents, listKanbanProjects,
  getKanbanLineComments, addKanbanLineComment,
  getKanbanCard, getChildCards, getDb,
  createAgentMessage, markKanbanCardDispatched,
  getKanbanSeqByIdPrefix,
  listLabels, getLabel, createLabel, updateLabel, deleteLabel,
  addLabelToCard, removeLabelFromCard, getLabelsForAllCards, getLabelsForCard,
  listArchivedKanbanCards,
  revertIdeaFromKanban,
  getHeartbeatKanbanSummary,
} from '../../db.js'
import { normalizeKanbanRefs } from '../kanban-ref-normalize.js'
import { OWNER_NAME, BOT_NAME, MAIN_AGENT_ID, STORE_DIR, WEB_HOST, WEB_PORT, KANBAN_LABEL_COLORS } from '../../config.js'
import { listAgentNames, readAgentDisplayName, isKnownAgent } from '../agent-config.js'
import { isAgentRunning } from '../agent-process.js'
import { readHardStop, isNewDevStartBlocked } from '../../costops/weekly-hard-stop.js'
import { landedGuardVerdict } from '../kanban-landed-guard.js'
import { gateCompletenessGuardVerdict } from '../kanban-gate-completeness-guard.js'

// Card project-name drift (Peti 2026-08-08): `project` was free-text with no case-folding, so
// "CleanCore" / "cleancore" / "MikroB" / "mikrob-infra" / "fleet-infra" / "marveen" / "Infra" all
// piled up as distinct buckets in the project filter -- the same work reading as several different
// projects. Fold known case/spelling variants onto their canonical name on every write; an
// unrecognised project passes through untouched (this is normalisation, not an allowlist -- a
// genuinely new project must stay creatable).
const CANONICAL_PROJECTS: Record<string, string> = Object.fromEntries(
  [
    ['CleanCore', ['cleancore']],
    ['MikroB', ['mikrob-infra', 'mikrob', 'fleet-infra', 'marveen', 'infra', 'mikrob-ops', 'marveen-infra']],
  ].flatMap(([canonical, variants]) => (variants as string[]).map((v) => [v, canonical as string])),
)
// Card c9b0b0c4: card a6101228 landed with project = the literal string "None" -- a Python
// caller's str(None) leaking straight into a JSON field. That string is not falsy in JS, so it
// survives `project ?? undefined` untouched and any `WHERE project IS NULL` filter misses it. Fold
// the common "no value" sentinels a non-JS caller might send onto real absence, same as any other
// project-name variant above.
const NULLISH_PROJECT_SENTINELS = new Set(['none', 'null', 'undefined', ''])
export function normalizeProjectName<T extends Record<string, unknown>>(data: T): T {
  if (typeof data.project === 'string') {
    const trimmedLower = data.project.trim().toLowerCase()
    if (NULLISH_PROJECT_SENTINELS.has(trimmedLower)) return { ...data, project: null }
    const canonical = CANONICAL_PROJECTS[trimmedLower]
    if (canonical) return { ...data, project: canonical }
  }
  return data
}

// Card c9b0b0c4: 45 of 884 comments from the "cybered" agent landed under "Cybered" -- same agent,
// two case variants, so any per-agent gate stat undercounts it by 45. Fold a comment author onto
// its canonical lowercase agent id ONLY when it actually names a known fleet agent (case-
// insensitively) -- this includes MAIN_AGENT_ID itself ("MikroB" folds to "mikrob", the same
// identity, just case-drifted). A genuine non-agent label (OWNER_NAME "Peti", or any other
// free-text author that names no known agents/<id>/ directory) passes through untouched.
export function normalizeCommentAuthor(author: string, knownAgent: (name: string) => boolean = isKnownAgent): string {
  const lower = author.trim().toLowerCase()
  return knownAgent(lower) ? lower : author
}

// Weekly NEW-DEV stop enforcement (Peti 2026-08-01). The newDevStop threshold was COMPUTED and shown,
// but nothing refused the work: role agents self-advance to the next `planned` card on their own and
// the status-write endpoints accepted `planned -> in_progress` unconditionally, so new development
// kept starting above the threshold and burned the weekly quota it was meant to protect. The block
// lives at the API boundary (both status-write routes) so every caller -- agent curl, dashboard drag,
// PUT and POST /move -- hits it. A `waiting -> in_progress` transition is a FAIL-fix / gate resume,
// NOT new development, so it stays allowed; `force: true` is meant as the deliberate MikroB override
// for a critical-infra exception -- but until 2026-08-02 the early-out below (`|| force`) returned
// "not blocked" for ANY caller's force:true with no actor check, and a role-agent used it to
// self-force-start ordinary planned cards during newDevStopActive (cards 31cc1cd4/874a9fb0/23594bbc).
// `isNewDevStartBlocked` now only honours `force` when the actor is an exempt agent (mikrob).
// SAME DAY, second bypass: after force got 409'd, `backend` (card adaa5217) simply sent
// `{"status":"waiting"}` on the still-`planned` card, skipping `in_progress` entirely -- the early-out
// here only checked `nextStatus === 'in_progress'`, so a direct `planned -> waiting` sailed through
// unchecked even though real (new) work had already happened. Now guards both target statuses.
function newDevStopWouldBlock(id: string, nextStatus: unknown, force: boolean, actor?: string): boolean {
  if (nextStatus !== 'in_progress' && nextStatus !== 'waiting') return false // cheap early-out avoids the flag + DB read
  const flag = readHardStop()
  if (!flag.newDevStopActive) return false
  return isNewDevStartBlocked(getKanbanCard(id)?.status, nextStatus, force, flag, actor)
}
const NEW_DEV_STOP_MESSAGE =
  'Heti "új fejlesztés leáll" küszöb átlépve: egy planned kártya nem mehet in_progress-be VAGY egyenesen waiting-be sem (új fejlesztés indítása) a heti resetig. In-flight és gate-munka továbbra is mehet (waiting -> in_progress); tudatos felülíráshoz MikroB force: true-val nyithatja meg.'
import { resolveKanbanDispatchTarget, isSelfAdvanceMove } from '../../kanban-dispatch.js'
import { generateBreakdown } from '../llm-breakdown.js'
import { logger } from '../../logger.js'
import { readBody, json, jsonMaybeGzip } from '../http-helpers.js'
import { getEffectiveSettingValue } from '../../settings-store.js'
import type { RouteContext } from './types.js'

// A headless agent cannot "drag" a card to done, so the dispatch hands it the
// exact curl commands to (1) post a short, human-readable result summary as a
// comment -- so the finished task's result lands on its OWN card, visible in the
// dashboard UI -- and (2) mark the card done. This is the lightweight
// alternative to spawning a separate per-session card for every agent run: the
// result goes where the work was asked for, with zero extra board clutter. The
// token is read from the store at call time (never embedded in the message).
export function kanbanMoveInstructions(id: string, target: string): string {
  const tokenPath = join(STORE_DIR, '.dashboard-token')
  const base = `http://${WEB_HOST}:${WEB_PORT}`
  // The token is read from STDIN (`-H @-`), never as an argv element: /proc/<pid>/cmdline
  // is world-readable, and these instructions are copied verbatim by every agent that reads them.
  const auth = `printf 'Authorization: Bearer %s\\n' "$(cat ${tokenPath})" \\`
  const moveUrl = `${base}/api/kanban/${id}/move`
  const commentUrl = `${base}/api/kanban/${id}/comments`
  const cardUrl = `${base}/api/kanban/${id}`
  // Escalation target when blocked: sub-agents hand back to the main agent
  // (their delegator), who triages and only escalates to the operator when
  // the block genuinely needs a human decision. Only the main agent itself
  // escalates directly to OWNER_NAME -- sub-agent completions/blocks route
  // through the main agent, not straight to the operator (operator feedback,
  // 2026-07-02: a finished/blocked delegated card goes back to the delegator,
  // not to the human).
  const isMainAgent = target === MAIN_AGENT_ID
  const escalateTo = isMainAgent ? OWNER_NAME : MAIN_AGENT_ID
  return [
    'A kártyát in_progress-re húzták. Amikor VÉGEZTÉL, két lépés (mindkettő a kártyára kerül, a web UI-ban látszik):',
    '',
    '1) Írj egy "REVIEW" kezdetű rövid eredmény-összefoglalót kommentként (1-2 mondat: mi lett a vége):',
    `  ${auth}`,
    `  | curl -s -H @- -X POST ${commentUrl} \\`,
    `    -H 'Content-Type: application/json' \\`,
    `    -d '{"author":"${target}","content":"REVIEW -- AZ EREDMENY ROVIDEN"}'`,
    '',
    `2) Állítsd a kártyát waiting-re -- a kész terméket SOHA nem teszed magad done-ba, a lezárás ${escalateTo} (vagy a kijelölt gate) lépése a REVIEW komment után:`,
    `  ${auth}`,
    `  | curl -s -H @- -X POST ${moveUrl} \\`,
    `    -H 'Content-Type: application/json' \\`,
    `    -d '{"status":"waiting"}'`,
    '',
    `Ha elakadtál / ${escalateTo} döntésére/lépésére vársz (a fenti "waiting"-be tétel MÁS eset -- az a KÉSZ munkára szól): HÁROM lépés kell EGYÜTT, a fenti 1-2 helyett:`,
    `  a) Írj egy kommentet ami KÖZVETLENÜL ${escalateTo}-hez szól, egyértelműen megfogalmazva mit kell eldöntenie/megtennie (NE a saját belső elemzésedet írd oda, NE "REVIEW" előtaggal -- ez nem kész munka) -- ugyanaz a comments hívás mint fent, "content" mezőben.`,
    `  b) Told át a kártyát ${escalateTo}-re, hogy egyértelmű legyen a felelősség (a te neved NE maradjon rajta, ha nem te vagy a blokkoló):`,
    `     ${auth}`,
    `     | curl -s -H @- -X PUT ${cardUrl} \\`,
    `       -H 'Content-Type: application/json' \\`,
    `       -d '{"assignee":"${escalateTo}"}'`,
    `  c) Csak EZUTÁN állítsd a kártyát status="waiting"-re (a fenti move-hívással).`,
    isMainAgent
      ? `Ez azért kritikus, mert ${OWNER_NAME} nem tudja kitalálni a dashboardon hogy egy nála maradt/rossz-assignee-jű, homályos kártya rá vár -- explicit átadás + explicit kérdés nélkül a felelősség-váltás elvész.`
      : `FONTOS: ${OWNER_NAME}-hez (az operátorhoz) EGYENESEN NE told át a kártyát, még ha a blokk végül tőle igényel is döntést -- ${MAIN_AGENT_ID} a delegálód, ő triázsol és ő dönti el, hogy tovább kell-e ${OWNER_NAME}-hez eszkalálnia. Ez azért kritikus, mert ${MAIN_AGENT_ID} nem tudja kitalálni a dashboardon hogy egy nála maradt/rossz-assignee-jű kártya rá vár -- explicit átadás + explicit kérdés nélkül a felelősség-váltás elvész.`,
    'A kártyát SOHA nem teszed magad done-ba -- a lezárás mindig MikroB vagy a kijelölt gate lépése, a te dolgod a "waiting" + REVIEW-komment. Az eredmény-kommentet (1) ne hagyd ki: az a kártyán a látható eredmény.',
  ].join('\n')
}

// Option D: kanban -> agent dispatch. When a card moves to in_progress, wake the
// assigned agent once via the inter-agent message router (createAgentMessage),
// which gives retry / dedup / trust-wrapping / busy-receiver handling for free.
// dispatched_at is the once-only guard; errors never block the card move.
function fireKanbanDispatch(id: string, actor?: string): void {
  try {
    const card = getKanbanCard(id)
    if (!card || card.dispatched_at) return
    // Self-advance (rule 11, card 7a033f8d): the assignee moved its OWN card to in_progress. A
    // dispatch here is a delayed echo of the agent's own decision -- it lands after the card is
    // already waiting+REVIEW and reads as a phantom re-dispatch. Mark it dispatched (so no later
    // auto-dispatch fires either) and send nothing. A missing/other actor still dispatches normally.
    if (isSelfAdvanceMove(card.assignee, actor)) {
      markKanbanCardDispatched(id)
      logger.info({ id, actor, assignee: card.assignee }, 'Kanban self-advance: dispatch echo suppressed')
      return
    }
    const target = resolveKanbanDispatchTarget(card.assignee, {
      ownerName: OWNER_NAME,
      botName: BOT_NAME,
      mainAgentId: MAIN_AGENT_ID,
      agentNames: listAgentNames(),
      isRunning: isAgentRunning,
    })
    if (!target) return
    const desc = (card.description ?? '').trim()
    const content = `[Kanban feladat #${id}]: ${card.title}${desc ? ' — ' + desc : ''}\n\n${kanbanMoveInstructions(id, target)}`
    createAgentMessage(MAIN_AGENT_ID, target, content)
    markKanbanCardDispatched(id)
    logger.info({ id, target, assignee: card.assignee }, 'Kanban in_progress dispatch fired')
  } catch (err) {
    logger.warn({ err, id }, 'Kanban dispatch failed (card move still succeeded)')
  }
}

/**
 * Read a repeatable filter parameter (`?status=a&status=b` or `?status=a,b`) as a set, or null when
 * the caller did not ask for one at all. Card 37ea2f96.
 *
 * Blank values are dropped, so `?status=` (empty) means "no filter" rather than "match the empty
 * string" -- a UI that clears its dropdown sends exactly that.
 */
/**
 * Read a repeatable, comma-separable filter parameter (`?status=waiting&status=done`,
 * `?status=waiting,done`) into a set, or null when the caller did not ask for one.
 *
 * EXPORTED so the tests drive THIS function (card bfeadc67): the suite used to carry its own copy
 * of the logic, which passes happily while the route drifts away from it -- a test that cannot fail
 * when the code changes is not testing the code.
 */
export function filterValues(url: URL, name: string): Set<string> | null {
  const raw = url.searchParams.getAll(name)
  if (raw.length === 0) return null
  const values = raw
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
  return values.length === 0 ? null : new Set(values)
}

export async function tryHandleKanban(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/kanban' && method === 'GET') {
    // Embed each card's labels in one extra JOIN query (getLabelsForAllCards)
    // instead of an N+1 per-card lookup, so the footer-pill UI gets
    // everything it needs in a single round trip.
    const labelsByCard = getLabelsForAllCards()
    let cards = listKanbanCards().map((card) => ({ ...card, labels: labelsByCard.get(card.id) ?? [] }))
    // Card 37ea2f96: `?status=` / `?assignee=` were ACCEPTED and ignored -- the endpoint returned all
    // 265 cards whatever was asked, so every caller (gates, scanners, the dashboard) filtered client
    // side and shipped the whole board over the wire each time. A parameter that looks like it works
    // and does not is worse than an absent one: a caller trusts it and reads the wrong set.
    //
    // FAIL-CLOSED ON AN UNKNOWN VALUE: `?status=waitng` (a typo) returns an EMPTY list rather than
    // everything. Silently widening a filter is how "why is this card in my sweep?" happens.
    const wanted = filterValues(ctx.url, 'status')
    if (wanted !== null) cards = cards.filter((c) => wanted.has(String(c.status)))
    const assignees = filterValues(ctx.url, 'assignee')
    if (assignees !== null) cards = cards.filter((c) => assignees.has(String(c.assignee ?? '')))
    jsonMaybeGzip(req, res, cards)
    return true
  }

  // The heartbeat agent's kanban source. It exists so the agent does not have to
  // COMPOSE the filter every hour: on 2026-08-04 the 09:00 report listed five
  // items of which three were already `done`, even though its instructions had
  // said to exclude them since #680. A rule the model must re-apply each hour is
  // not a mechanism; an endpoint that cannot return a closed card is. It also
  // removes the sqlite3 CLI from that path, which does not exist on a stock
  // Linux install (#870).
  if (path === '/api/kanban/heartbeat-summary' && method === 'GET') {
    const summary = getHeartbeatKanbanSummary()
    const slim = (c: { id: string; title: string; status: string; priority: string; assignee?: string | null }) => ({
      id: c.id, title: c.title, status: c.status, priority: c.priority, assignee: c.assignee ?? null,
    })
    json(res, {
      urgent: summary.urgent.map(slim),
      waiting: summary.waiting.map(slim),
      counts: {
        urgent: summary.urgent.length,
        in_progress: summary.in_progress.length,
        waiting: summary.waiting.length,
      },
    })
    return true
  }

  if (path === '/api/kanban/labels' && method === 'GET') {
    json(res, listLabels())
    return true
  }

  if (path === '/api/kanban/labels' && method === 'POST') {
    const body = await readBody(req)
    const { name, color } = JSON.parse(body.toString()) as { name?: string; color?: string }
    if (!name || !name.trim()) { json(res, { error: 'Címke neve kötelező' }, 400); return true }
    // Colour is validated against the configured palette (KANBAN_LABEL_COLORS)
    // rather than accepted as free-text, so every label's colour traces back
    // to the single configurable source instead of an arbitrary per-request value.
    const resolvedColor = color && KANBAN_LABEL_COLORS.includes(color) ? color : KANBAN_LABEL_COLORS[0]
    const id = randomUUID().slice(0, 8)
    const label = createLabel({ id, name: name.trim(), color: resolvedColor })
    json(res, label)
    return true
  }

  const labelMatch = path.match(/^\/api\/kanban\/labels\/([^/]+)$/)
  if (labelMatch && method === 'PUT') {
    const id = decodeURIComponent(labelMatch[1])
    const body = await readBody(req)
    const { name, color } = JSON.parse(body.toString()) as { name?: string; color?: string }
    const fields: { name?: string; color?: string } = {}
    if (name !== undefined) {
      if (!name.trim()) { json(res, { error: 'Címke neve kötelező' }, 400); return true }
      fields.name = name.trim()
    }
    if (color !== undefined) {
      fields.color = KANBAN_LABEL_COLORS.includes(color) ? color : KANBAN_LABEL_COLORS[0]
    }
    if (updateLabel(id, fields)) { json(res, { ok: true }); return true }
    json(res, { error: 'Címke nem található' }, 404)
    return true
  }
  if (labelMatch && method === 'DELETE') {
    const id = decodeURIComponent(labelMatch[1])
    if (deleteLabel(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Címke nem található' }, 404)
    return true
  }

  const cardLabelsMatch = path.match(/^\/api\/kanban\/([^/]+)\/labels$/)
  if (cardLabelsMatch && method === 'GET') {
    const cardId = decodeURIComponent(cardLabelsMatch[1])
    json(res, getLabelsForCard(cardId))
    return true
  }
  if (cardLabelsMatch && method === 'POST') {
    const cardId = decodeURIComponent(cardLabelsMatch[1])
    if (!getKanbanCard(cardId)) { json(res, { error: 'Kártya nem található' }, 404); return true }
    const body = await readBody(req)
    // Accept `id` as an alias for `labelId` -- API callers reasonably send either,
    // since GET /api/kanban/labels returns objects keyed by `id`, not `labelId`.
    const parsed = JSON.parse(body.toString()) as { labelId?: string; id?: string }
    const labelId = parsed.labelId ?? parsed.id
    if (!labelId) { json(res, { error: 'labelId mező kötelező' }, 400); return true }
    if (!getLabel(labelId)) {
      // Common mistake: sending the label's `name` where an `id` is expected -- GET
      // /api/kanban/labels lists both, so this is an easy mix-up. Point at the real id
      // instead of a bare "not found" that reads as if the label doesn't exist at all.
      const byName = listLabels().find((l) => l.name === labelId)
      if (byName) {
        json(res, { error: `Címke nem található id alapján -- a "${labelId}" egy név, nem id. Használd az id-t: ${byName.id}` }, 404)
        return true
      }
      json(res, { error: 'Címke nem található' }, 404)
      return true
    }
    addLabelToCard(cardId, labelId)
    json(res, { ok: true })
    return true
  }

  const cardLabelDeleteMatch = path.match(/^\/api\/kanban\/([^/]+)\/labels\/([^/]+)$/)
  if (cardLabelDeleteMatch && method === 'DELETE') {
    const cardId = decodeURIComponent(cardLabelDeleteMatch[1])
    const labelId = decodeURIComponent(cardLabelDeleteMatch[2])
    if (removeLabelFromCard(cardId, labelId)) { json(res, { ok: true }); return true }
    json(res, { error: 'A kártyán nincs ilyen címke' }, 404)
    return true
  }

  if (path === '/api/kanban-projects' && method === 'GET') {
    json(res, listKanbanProjects())
    return true
  }

  if (path === '/api/kanban/assignees' && method === 'GET') {
    const agents = listAgentNames().map((name) => ({ name, type: 'agent', displayName: readAgentDisplayName(name) || name }))
    json(res, [
      { name: OWNER_NAME, type: 'owner' },
      { name: BOT_NAME, type: 'bot' },
      ...agents,
    ])
    return true
  }

  if (path === '/api/kanban' && method === 'POST') {
    const body = await readBody(req)
    const { force, actor, ...data } = JSON.parse(body.toString())
    // Card 8c4a6d9c/cf068369/89fba8e4 investigation (2026-08-02): the two status-write routes
    // (PUT, POST /move) block a fresh planned->in_progress start above the weekly threshold, but a
    // card CREATED already in_progress (or straight to waiting -- see adaa5217, same day) skipped
    // both -- there is no prior 'planned' status for isNewDevStartBlocked to see. Block both creation
    // shapes the same way. `force` only exempts an actor in exemptAgents (mikrob) -- see
    // newDevStopWouldBlock above.
    if (data.status === 'in_progress' || data.status === 'waiting') {
      const flag = readHardStop()
      const exempt = force === true && typeof actor === 'string' && flag.exemptAgents.includes(actor.trim().toLowerCase())
      if (flag.newDevStopActive && !exempt) {
        json(res, { error: NEW_DEV_STOP_MESSAGE }, 409)
        return true
      }
    }
    const id = randomUUID().slice(0, 8)
    createKanbanCard({ id, ...normalizeProjectName(data) })
    json(res, { ok: true, id })
    return true
  }

  const kanbanCardMatch = path.match(/^\/api\/kanban\/([^/]+)$/)
  if (kanbanCardMatch && method === 'PUT') {
    const id = decodeURIComponent(kanbanCardMatch[1])
    const body = await readBody(req)
    const { actor, force, ...data } = JSON.parse(body.toString()) as Record<string, unknown>
    if (newDevStopWouldBlock(id, data.status, force === true, typeof actor === 'string' ? actor : undefined)) {
      json(res, { error: NEW_DEV_STOP_MESSAGE }, 409)
      return true
    }
    // Closing a card is the only moment where "did this actually land?" changes the outcome
    // (card 9cc72f2c). Applies to BOTH close paths -- PUT with a status and POST /move -- because
    // guarding one of two doors guards neither.
    {
      const v = await landedGuardVerdict(id, data.status, force === true, typeof actor === 'string' ? actor : undefined)
      if (v.blocked) { json(res, { error: v.message }, 409); return true }
    }
    {
      const v = gateCompletenessGuardVerdict(id, data.status, force === true, typeof actor === 'string' ? actor : undefined)
      if (v.blocked) { json(res, { error: v.message }, 409); return true }
    }
    if (updateKanbanCard(id, normalizeProjectName(data), { actor: typeof actor === 'string' ? actor : undefined, force: force === true })) {
      json(res, { ok: true }); return true
    }
    // Card c4f2de32: distinguish "no such card" from "refused to re-open reviewed work", so the
    // caller learns what to do instead of retrying blindly.
    if (getKanbanCard(id)) {
      json(res, {
        error:
          'A kártya waiting állapotban REVIEW-ra vár: nem húzható vissza in_progress-be, amíg egy gate nem írt rá verdiktet (PASS/GO vagy FAIL/NO-GO). Ha tudatosan újra akarod nyitni, küldd force: true értékkel.',
      }, 409)
      return true
    }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  if (kanbanCardMatch && method === 'DELETE') {
    const id = decodeURIComponent(kanbanCardMatch[1])
    revertIdeaFromKanban(id)
    if (deleteKanbanCard(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  const kanbanMoveMatch = path.match(/^\/api\/kanban\/([^/]+)\/move$/)
  if (kanbanMoveMatch && method === 'POST') {
    const id = decodeURIComponent(kanbanMoveMatch[1])
    const body = await readBody(req)
    const { status, sort_order, actor, force } = JSON.parse(body.toString())
    if (newDevStopWouldBlock(id, status, force === true, typeof actor === 'string' ? actor : undefined)) {
      json(res, { error: NEW_DEV_STOP_MESSAGE }, 409)
      return true
    }
    {
      const v = await landedGuardVerdict(id, status, force === true, typeof actor === 'string' ? actor : undefined)
      if (v.blocked) { json(res, { error: v.message }, 409); return true }
    }
    {
      const v = gateCompletenessGuardVerdict(id, status, force === true, typeof actor === 'string' ? actor : undefined)
      if (v.blocked) { json(res, { error: v.message }, 409); return true }
    }
    if (moveKanbanCard(id, status, sort_order ?? 0, actor, force === true)) {
      // Wake the assigned agent once when the card enters in_progress.
      if (status === 'in_progress') fireKanbanDispatch(id, actor)
      json(res, { ok: true })
      return true
    }
    if (getKanbanCard(id)) {
      json(res, {
        error:
          'A kártya waiting állapotban REVIEW-ra vár: nem húzható vissza in_progress-be, amíg egy gate nem írt rá verdiktet (PASS/GO vagy FAIL/NO-GO). Ha tudatosan újra akarod nyitni, küldd force: true értékkel.',
      }, 409)
      return true
    }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  const kanbanArchiveMatch = path.match(/^\/api\/kanban\/([^/]+)\/archive$/)
  if (kanbanArchiveMatch && method === 'POST') {
    const id = decodeURIComponent(kanbanArchiveMatch[1])
    let force = false
    try {
      const body = await readBody(req)
      if (body.length > 0) force = (JSON.parse(body.toString()) as Record<string, unknown>)?.['force'] === true
    } catch { /* malformed body: force stays false, fail closed */ }
    const result = archiveKanbanCard(id, { force })
    // revertIdeaFromKanban only runs on an ACTUAL archive -- running it on a blocked attempt
    // would unlink the idea from a card that is not actually archived (card 037277a0).
    if (result.ok) {
      revertIdeaFromKanban(id)
      json(res, { ok: true })
      return true
    }
    if (result.reason === 'open-children') {
      json(
        res,
        {
          error: `${result.openChildren.length} nyitott (nem done) gyerekkártya blokkolja az archiválást -- force:true kell hozzá`,
          openChildren: result.openChildren,
        },
        409,
      )
      return true
    }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  if (path === '/api/kanban/archived' && method === 'GET') {
    const sp      = ctx.url.searchParams
    const q       = sp.get('q')?.trim() || undefined
    const project = sp.get('project')?.trim() || undefined
    const label   = sp.get('label')?.trim() || undefined
    const from    = sp.get('from')  ? Number(sp.get('from'))  : undefined
    const to      = sp.get('to')    ? Number(sp.get('to'))    : undefined
    const limit   = Math.min(Number(sp.get('limit') ?? 0) || Number(getEffectiveSettingValue('KANBAN_ARCHIVED_MAX_ROWS')), 5000)
    const labelsByCard = getLabelsForAllCards()
    const cards = listArchivedKanbanCards({ q, project, label, from, to, limit })
      .map(card => ({ ...card, labels: labelsByCard.get(card.id) ?? [] }))
    json(res, { cards, total: cards.length, limit })
    return true
  }

  // card ebf7d95c: the only way to read ONE card used to be GET /api/kanban and filtering the whole
  // list client-side -- PUT/DELETE on this exact path already worked, so a 404 here read as "the
  // card doesn't exist / a sync bug" rather than "this verb was never wired up", and repeatedly
  // confused both Teszter and MikroB into the wrong diagnosis. Deliberately placed AFTER every
  // other single-segment /api/kanban/<word> GET route above (archived, labels, assignees,
  // heartbeat-summary): kanbanCardMatch's `([^/]+)` matches any one segment, including those literal
  // words, so this must not shadow them -- an id can never collide with a route checked first.
  if (kanbanCardMatch && method === 'GET') {
    const id = decodeURIComponent(kanbanCardMatch[1])
    const card = getKanbanCard(id)
    if (!card) { json(res, { error: 'Kártya nem található' }, 404); return true }
    json(res, card)
    return true
  }

  const kanbanUnarchiveMatch = path.match(/^\/api\/kanban\/([^/]+)\/unarchive$/)
  if (kanbanUnarchiveMatch && method === 'POST') {
    const id = decodeURIComponent(kanbanUnarchiveMatch[1])
    if (unarchiveKanbanCard(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Kártya nem található vagy nincs archiválva' }, 404)
    return true
  }

  const kanbanCommentsMatch = path.match(/^\/api\/kanban\/([^/]+)\/comments$/)
  if (kanbanCommentsMatch && method === 'GET') {
    const cardId = decodeURIComponent(kanbanCommentsMatch[1])
    json(res, getKanbanComments(cardId))
    return true
  }
  if (kanbanCommentsMatch && method === 'POST') {
    const cardId = decodeURIComponent(kanbanCommentsMatch[1])
    const body = await readBody(req)
    const { author, content } = JSON.parse(body.toString())
    if (!author || !content) { json(res, { error: 'Szerző és tartalom kötelező' }, 400); return true }
    // Code-side kanban-ref enforcement: rewrite `#<hex8>` references that map
    // to a real card into the human-facing `#<seq>` form before persistence
    // (#75 Cuzcoo dispatch). Random hex / non-matching tokens pass through.
    const normalizedContent = normalizeKanbanRefs(content, getKanbanSeqByIdPrefix)
    json(res, addKanbanComment(cardId, normalizeCommentAuthor(author), normalizedContent))
    return true
  }

  // Line-level (diff) comments (card 906c130f): a comment bound to one file+line of one commit's
  // diff, distinct from the free-text card-level kanban_comments above. Adatmodel+API only --
  // rendering is the paired Fron Ted card's (c12abc67) job.
  const kanbanLineCommentsMatch = path.match(/^\/api\/kanban\/([^/]+)\/line-comments$/)
  if (kanbanLineCommentsMatch && method === 'GET') {
    const cardId = decodeURIComponent(kanbanLineCommentsMatch[1])
    const sha = ctx.url.searchParams.get('sha') || undefined
    json(res, getKanbanLineComments(cardId, sha))
    return true
  }
  if (kanbanLineCommentsMatch && method === 'POST') {
    const cardId = decodeURIComponent(kanbanLineCommentsMatch[1])
    if (!getKanbanCard(cardId)) { json(res, { error: 'Kártya nem található' }, 404); return true }
    const body = await readBody(req)
    const { sha, file, line, author, content } = JSON.parse(body.toString())
    if (!sha || !file || !author || !content) {
      json(res, { error: 'sha, file, author és content kötelező' }, 400)
      return true
    }
    if (!Number.isInteger(line) || line < 1) {
      json(res, { error: 'line kötelező, pozitív egész szám' }, 400)
      return true
    }
    const normalizedContent = normalizeKanbanRefs(content, getKanbanSeqByIdPrefix)
    json(res, addKanbanLineComment(cardId, sha, file, line, normalizeCommentAuthor(author), normalizedContent))
    return true
  }

  const kanbanEventsMatch = path.match(/^\/api\/kanban\/([^/]+)\/events$/)
  if (kanbanEventsMatch && method === 'GET') {
    const cardId = decodeURIComponent(kanbanEventsMatch[1])
    json(res, getKanbanCardEvents(cardId))
    return true
  }

  const breakdownMatch = path.match(/^\/api\/kanban\/([^/]+)\/breakdown$/)
  if (breakdownMatch && method === 'POST') {
    const cardId = decodeURIComponent(breakdownMatch[1])
    const card = getKanbanCard(cardId)
    if (!card) { json(res, { error: 'Kártya nem található' }, 404); return true }
    const existing = getChildCards(cardId)
    if (existing.length > 0) { json(res, { error: 'A kártya már rendelkezik subtask-okkal' }, 409); return true }
    try {
      const result = await generateBreakdown(card.title, card.description)
      json(res, { subtasks: result.subtasks })
    } catch (err) {
      logger.error({ err, cardId }, 'Breakdown generation failed')
      json(res, { error: (err as Error).message }, 500)
    }
    return true
  }

  const acceptMatch = path.match(/^\/api\/kanban\/([^/]+)\/breakdown\/accept$/)
  if (acceptMatch && method === 'POST') {
    const parentId = decodeURIComponent(acceptMatch[1])
    const parent = getKanbanCard(parentId)
    if (!parent) { json(res, { error: 'Szülő kártya nem található' }, 404); return true }
    const body = await readBody(req)
    const { subtasks } = JSON.parse(body.toString()) as {
      subtasks: Array<{ title: string; description: string; assignee: string | null; priority: string }>
    }
    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      json(res, { error: 'Subtask lista kötelező' }, 400)
      return true
    }
    const db = getDb()
    const created = db.transaction(() => {
      const ids: string[] = []
      for (const st of subtasks) {
        const id = randomUUID().slice(0, 8).toUpperCase()
        createKanbanCard({
          id,
          title: st.title,
          description: st.description,
          assignee: st.assignee ?? undefined,
          priority: (st.priority as any) ?? 'normal',
          project: parent.project ?? undefined,
          parent_id: parentId,
        })
        ids.push(id)
      }
      addKanbanComment(parentId, BOT_NAME, `Auto-breakdown: ${ids.length} subtask létrehozva (${ids.join(', ')})`)
      return ids
    })()
    json(res, { ok: true, created })
    return true
  }

  const childrenMatch = path.match(/^\/api\/kanban\/([^/]+)\/children$/)
  if (childrenMatch && method === 'GET') {
    const parentId = decodeURIComponent(childrenMatch[1])
    json(res, getChildCards(parentId))
    return true
  }

  return false
}
