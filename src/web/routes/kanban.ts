import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  listKanbanCards, createKanbanCard, updateKanbanCard,
  deleteKanbanCard, moveKanbanCard, archiveKanbanCard, unarchiveKanbanCard,
  getKanbanComments, addKanbanComment, getKanbanCardEvents, getKanbanCardFieldEvents, listKanbanProjects,
  getKanbanLineComments, addKanbanLineComment,
  getKanbanCard, getChildCards, getDb,
  createAgentMessage, markKanbanCardDispatched,
  getKanbanSeqByIdPrefix,
  listLabels, getLabel, createLabel, updateLabel, deleteLabel,
  addLabelToCard, removeLabelFromCard, getLabelsForAllCards, getLabelsForCard,
  listArchivedKanbanCards,
  revertIdeaFromKanban,
  getHeartbeatKanbanSummary,
  addKanbanDependency, removeKanbanDependency,
  getKanbanPredecessors, getKanbanSuccessors, dependencyBlockers,
  getUnmetPredecessorsForAllCards, getUnmetKanbanPredecessors,
  priorInProgressCardForActor, setPendingSelfAdvanceClear,
  countNewHotMemories,
  countPlannedKanbanCards,
  getDbFileSizeMb,
  queryKanbanRelations, cardsTouchingFile, filesTouchedByCard,
  RELATION_FILTER_COLUMNS, type RelationFilterColumn, type RelationQuery,
} from '../../db.js'
import { isForceActor } from '../../kanban-force-actors.js'
import { normalizeKanbanRefs } from '../kanban-ref-normalize.js'
import { OWNER_NAME, BOT_NAME, MAIN_AGENT_ID, STORE_DIR, WEB_HOST, WEB_PORT, KANBAN_LABEL_COLORS } from '../../config.js'
import { listAgentNames, readAgentDisplayName, isKnownAgent } from '../agent-config.js'
import { isAgentRunning } from '../agent-process.js'
import { readHardStop, isNewDevStartBlocked } from '../../costops/weekly-hard-stop.js'
import { landedGuardVerdict } from '../kanban-landed-guard.js'
import { gateCompletenessGuardVerdict } from '../kanban-gate-completeness-guard.js'
import { dedupPrefilterDescriptionUpdate } from '../kanban-dedup-prefilter-guard.js'
import { clearBeforeDispatchIfSwitching } from '../kanban-dispatch-clear-guard.js'

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
import { resolveKanbanDispatch, isSelfAdvanceMove, isGenuineSelfAdvanceSwitch } from '../../kanban-dispatch.js'
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
// `actor` is the mover reported by the caller: an agent that moves its own card
// to in_progress must not be woken with an assignment for work it just started.
async function fireKanbanDispatch(id: string, actor?: string | null): Promise<void> {
  try {
    const card = getKanbanCard(id)
    if (!card || card.dispatched_at) return
    // Self-advance (rule 11, card 7a033f8d): the assignee moved its OWN card to in_progress. A
    // dispatch here is a delayed echo of the agent's own decision -- it lands after the card is
    // already waiting+REVIEW and reads as a phantom re-dispatch. Mark it dispatched (so no later
    // auto-dispatch fires either) and send nothing. A missing/other actor still dispatches normally.
    if (isSelfAdvanceMove(card.assignee, actor)) {
      markKanbanCardDispatched(id)
      // Card 5003f37e: the dispatch echo above is correctly suppressed, but that must not also
      // suppress /clear-before-switch -- self-advance needs it too, just delivered differently (see
      // the agent_pending_clear schema comment in db.ts for why this only RECORDS the debt here
      // instead of sending /clear synchronously).
      const prior = priorInProgressCardForActor(actor as string)
      if (isGenuineSelfAdvanceSwitch(prior, id)) {
        setPendingSelfAdvanceClear(actor as string, id, Date.now())
        logger.info({ id, actor, prior }, 'Kanban self-advance: genuine card switch, /clear queued for next idle window')
      }
      logger.info({ id, actor, assignee: card.assignee }, 'Kanban self-advance: dispatch echo suppressed')
      return
    }
    const decision = resolveKanbanDispatch(card.assignee, {
      ownerName: OWNER_NAME,
      botName: BOT_NAME,
      mainAgentId: MAIN_AGENT_ID,
      agentNames: listAgentNames(),
      isRunning: isAgentRunning,
      actor,
    })
    const target = decision.target
    if (!target) {
      // 'not-dispatchable' (no/unknown assignee, human owner) and 'self-move'
      // are DELIBERATE no-dispatch cases -- staying quiet is correct, and
      // alerting on them would bury the one case that matters.
      if (decision.reason === 'session-down') reportUndeliveredDispatch(id, decision.unreachable ?? String(card.assignee))
      return
    }
    // Card 900178fa: /clear the target's pane FIRST when this is a genuine card switch (not a
    // re-dispatch of the same card after a gate FAIL), and WAIT for that attempt to settle before
    // enqueueing the card-content message below -- fireKanbanDispatch itself is called
    // fire-and-forget by its caller (moving the card already returned its HTTP response), so
    // awaiting here costs nothing external, but ordering it the other way around risks the
    // message-router delivering the new task BEFORE this direct send gets to clear the pane,
    // wiping the very instructions it just delivered.
    try {
      await clearBeforeDispatchIfSwitching(target, id)
    } catch (err) {
      logger.warn({ err, id, target }, 'Kanban dispatch: /clear-before-switch failed (dispatch continues)')
    }
    const desc = (card.description ?? '').trim()
    const content = `[Kanban feladat #${id}]: ${card.title}${desc ? ' — ' + desc : ''}\n\n${kanbanMoveInstructions(id, target)}`
    createAgentMessage(MAIN_AGENT_ID, target, content)
    markKanbanCardDispatched(id)
    logger.info({ id, target, assignee: card.assignee }, 'Kanban in_progress dispatch fired')
  } catch (err) {
    logger.warn({ err, id }, 'Kanban dispatch failed (card move still succeeded)')
    reportUndeliveredDispatch(id, 'a kiosztás hibára futott')
  }
}

// A card that reached in_progress without its assignee being woken must never
// stay silent: the board shows it running, status-driven monitoring skips on
// exactly that status, and the false in_progress SUSTAINS ITSELF -- a single
// missed dispatch can hold a card open for hours behind a green log. So the
// failure is written where both readers look: a comment on
// the card (the board) and a notice in the main agent's inbox (the delegator,
// who triages and can put the card back).
//
// Best-effort by construction: this runs inside the move request, and the move
// itself has already succeeded. A throw here (db locked, inbox write failing)
// must not turn a completed move into a 500, so it is swallowed after a log --
// the same contract as the dispatch it reports on.
function reportUndeliveredDispatch(id: string, unreachable: string): void {
  logger.warn({ id, unreachable }, 'Kanban card is in_progress but its assignee was NOT woken')
  try {
    addKanbanComment(
      id,
      'system',
      `A kártya in_progress lett, de a kiosztott ügynök (${unreachable}) NEM kapott üzenetet -- a session nem fut, vagy a kiosztás hibára futott. ` +
      'A kártya NEM fut: tedd vissza planned-re, vagy indítsd el az ügynököt és húzd újra in_progress-re.',
    )
  } catch (err) {
    logger.warn({ err, id }, 'Undelivered-dispatch card comment failed')
  }
  try {
    createAgentMessage(
      'system',
      MAIN_AGENT_ID,
      `[kanban-dispatch] A(z) #${id} kártya in_progress lett, de a kiosztott ügynök (${unreachable}) NEM kapott üzenetet. ` +
      'A tábla futónak mutatja, közben senki nem dolgozik rajta. Tedd vissza planned-re, vagy indítsd el az ügynököt és aktiváld újra.',
    )
  } catch (err) {
    logger.warn({ err, id }, 'Undelivered-dispatch inbox notice failed')
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

/** Paging bounds for GET /api/kanban/relations (card 69396b63). A default at all, because the
 *  table holds 8284 edges today and a bare GET must not be a full dump; a MAX because `?limit=1e9`
 *  would be the same dump with an extra step. Above the max is CLAMPED rather than refused -- the
 *  caller asked for "everything" and gets as much as this endpoint serves, with `total` telling
 *  them what they did not get. */
export const RELATION_LIMIT_DEFAULT = 500
export const RELATION_LIMIT_MAX = 5000

/** Base-10 integer or nothing. `Number()` is deliberately not `parseInt`: parseInt('5abc') is 5,
 *  so a typo'd bound would silently become a different bound. */
function wholeNumber(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^[0-9]+$/.test(trimmed)) return null
  const n = Number(trimmed)
  return Number.isSafeInteger(n) ? n : null
}

/**
 * Query string -> a relation query, or a refusal. PURE and exported so the fail-closed behaviour
 * is testable without HTTP.
 *
 * AN UNKNOWN PARAMETER IS A 400, not a shrug. Card 37ea2f96 is the precedent and the reason: this
 * endpoint's whole job is answering "which cards touched X", so a caller who typos `?fromid=` and
 * gets 200 with the WHOLE unfiltered table reads it as "these cards touched X" -- a wrong answer
 * that looks like a right one. Refusing names the mistake at the only moment it is cheap.
 */
export function parseRelationQuery(
  url: URL,
): { ok: true; query: RelationQuery } | { ok: false; error: string } {
  const accepted = new Set<string>([...RELATION_FILTER_COLUMNS, 'limit', 'offset'])
  const unknown = [...new Set([...url.searchParams.keys()].filter((k) => !accepted.has(k)))]
  if (unknown.length > 0) {
    return {
      ok: false,
      error:
        `Ismeretlen query-paraméter: ${unknown.join(', ')}. ` +
        `Elfogadott paraméterek: ${[...accepted].join(', ')}.`,
    }
  }

  const filters: Partial<Record<RelationFilterColumn, string[]>> = {}
  for (const column of RELATION_FILTER_COLUMNS) {
    const values = filterValues(url, column)
    if (values) filters[column] = [...values]
  }

  const rawLimit = url.searchParams.get('limit')
  let limit = RELATION_LIMIT_DEFAULT
  if (rawLimit !== null) {
    const parsed = wholeNumber(rawLimit)
    if (parsed === null || parsed < 1) {
      return { ok: false, error: `A 'limit' pozitív egész szám legyen, ez érkezett: '${rawLimit}'.` }
    }
    limit = Math.min(parsed, RELATION_LIMIT_MAX)
  }

  const rawOffset = url.searchParams.get('offset')
  let offset = 0
  if (rawOffset !== null) {
    const parsed = wholeNumber(rawOffset)
    if (parsed === null) {
      return {
        ok: false,
        error: `Az 'offset' nemnegatív egész szám legyen, ez érkezett: '${rawOffset}'.`,
      }
    }
    offset = parsed
  }

  const query: RelationQuery = Object.keys(filters).length > 0
    ? { filters, limit, offset }
    : { limit, offset }
  return { ok: true, query }
}

/**
 * The 409 a blocked transition gets (card a8aa9ae5). MACHINE-READABLE, not just prose: the
 * gate-reconciler has to tell "this card is waiting on another card" apart from every other refusal
 * so it can annotate ONCE on the 4a(d) bound-block branch instead of retrying every five minutes
 * for hours. A message it had to string-match would make that behaviour depend on wording.
 *
 * The enforcement itself is in moveKanbanCard/updateKanbanCard -- this only builds the reply, from
 * the SAME predicate, so the two cannot disagree.
 */
function dependencyBlockBody(
  id: string,
  nextStatus: unknown,
  force: boolean,
  actor?: string,
): { blocked: boolean; body?: Record<string, unknown> } {
  // The SAME bypass rule the writers apply (card a8aa9ae5, Cybersec F-1): force plus an
  // allowlisted actor. If this said only `force`, the 409 would disagree with the enforcement --
  // a non-allowlisted force:true would get a 200-shaped path here and still be refused below.
  if (isForceActor(force, actor) || typeof nextStatus !== 'string') return { blocked: false }
  const blockers = dependencyBlockers(id, nextStatus)
  if (blockers.length === 0) return { blocked: false }
  return {
    blocked: true,
    body: {
      code: 'dependency_blocked',
      error:
        `${blockers.length} függőség még nincs kész, ezért a kártya nem léphet '${nextStatus}' állapotba: ` +
        blockers.map((c) => `${c.id} (${c.status}) -- ${c.title}`).join('; ') +
        '. Fejezd be azokat előbb, vagy küldd force: true értékkel, ha tudatosan lépsz át rajta.',
      blockedBy: blockers.map((c) => ({ id: c.id, title: c.title, status: c.status, priority: c.priority })),
    },
  }
}

// HBKANBANDRIFT819: the heartbeat-summary payload, shaped so that TRUNCATED
// reads still carry the truth. Pure and exported so tests can pin all three
// properties without HTTP:
//   1. `counts` is the FIRST key -- JSON.stringify preserves insertion order,
//      so a reader that loses the tail loses list items, never the numbers;
//   2. every title is truncated server-side (board titles here run to 15KB);
//   3. the waiting LIST is capped to the most recently-updated few, while
//      counts.waiting always carries the FULL total -- the list names items,
//      the numbers only ever come from counts.
export const HEARTBEAT_SUMMARY_TITLE_MAX = 160
export const HEARTBEAT_SUMMARY_WAITING_CAP = 8

type HeartbeatSummaryCard = {
  id: string; title: string; status: string; priority: string;
  assignee?: string | null; updated_at?: number | null;
}

export function buildHeartbeatSummaryResponse(
  summary: { urgent: HeartbeatSummaryCard[]; in_progress: HeartbeatSummaryCard[]; waiting: HeartbeatSummaryCard[] },
  newHotMemories1h: number,
  plannedCount: number,
  dbSizeMb: number | null,
) {
  const trunc = (t: string) =>
    t.length > HEARTBEAT_SUMMARY_TITLE_MAX ? t.slice(0, HEARTBEAT_SUMMARY_TITLE_MAX) + '…' : t
  const slim = (c: HeartbeatSummaryCard) => ({
    id: c.id, title: trunc(c.title), status: c.status, priority: c.priority, assignee: c.assignee ?? null,
  })
  const waitingRecent = [...summary.waiting]
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
    .slice(0, HEARTBEAT_SUMMARY_WAITING_CAP)
  return {
    counts: {
      urgent: summary.urgent.length,
      in_progress: summary.in_progress.length,
      // The FULL total, never the capped list length -- the 2026-08-04 lesson
      // (waiting: 10 reported against 130 real) in endpoint form.
      waiting: summary.waiting.length,
      // The report format asks for a planned line; without a sanctioned
      // source here the agent manufactured the value (planned: 0 against a
      // real 305, measured 2026-08-19 17:00). Count only, no list.
      planned: plannedCount,
      // HBMEMBLIND819: computed server-side with the MAIN agent's id so the
      // heartbeat agent copies a number instead of running (and rewriting)
      // a query -- see HEARTBEAT_NEW_HOT_MEMORIES_SQL in db.ts.
      new_hot_memories_1h: newHotMemories1h,
      // HBDBMERET822: without a sanctioned source the agent re-invented this
      // measurement every session (format drift `158 MB` -> `160M`, then a
      // false `0.0 MB` against a real 159 MB, 2026-08-22 15:00). null means
      // "could not measure" and renders as "nincs adat" -- never 0, because
      // for a growth signal a false zero looks like calm, not like failure.
      db_size_mb: dbSizeMb,
    },
    urgent: summary.urgent.map(slim),
    waiting: waitingRecent.map(slim),
    waiting_shown: Math.min(summary.waiting.length, HEARTBEAT_SUMMARY_WAITING_CAP),
  }
}

export async function tryHandleKanban(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/kanban' && method === 'GET') {
    // Embed each card's labels in one extra JOIN query (getLabelsForAllCards)
    // instead of an N+1 per-card lookup, so the footer-pill UI gets
    // everything it needs in a single round trip.
    const labelsByCard = getLabelsForAllCards()
    // Card 38788337: the same one-query-not-N+1 treatment for dependency state. `blocked` is
    // DERIVED, never stored -- a stored flag would be a second source of truth that goes stale the
    // moment a predecessor closes, and this board is polled far more often than it is edited.
    const blockersByCard = getUnmetPredecessorsForAllCards()
    let cards = listKanbanCards().map((card) => {
      const blockers = blockersByCard.get(card.id) ?? []
      return {
        ...card,
        labels: labelsByCard.get(card.id) ?? [],
        blocked: blockers.length > 0,
        blockedBy: blockers.map((c) => ({ id: c.id, title: c.title, status: c.status })),
      }
    })
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
  //
  // HBKANBANDRIFT819 (2026-08-19): the 16:42 heartbeat reported waiting:12
  // against a real 280 -- the endpoint's counts were CORRECT, but the payload
  // was ~31KB (card titles on this board run to 15KB EACH) and `counts` was
  // serialized LAST, after the huge arrays. An agent reading truncated output
  // lost exactly the numbers and counted the visible list instead. Fixes here:
  // counts serialize FIRST (truncation-resilient ordering), titles are
  // truncated server-side, and the waiting list is capped to the most recent
  // few -- while counts.* always carries the FULL totals. The list is for
  // naming items; the numbers ONLY ever come from counts.
  if (path === '/api/kanban/heartbeat-summary' && method === 'GET') {
    json(res, buildHeartbeatSummaryResponse(getHeartbeatKanbanSummary(), countNewHotMemories(MAIN_AGENT_ID), countPlannedKanbanCards(), getDbFileSizeMb()))
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
    // ONE id, used for BOTH the row and the response (card f27c999b, adopted from upstream).
    // It used to be `createKanbanCard({ id, ...normalized })` with a generated id, and `normalized`
    // still carries a caller-supplied `id` -- so the spread OVERRODE the generated one in the row
    // while the response echoed the generated one. HTTP 200 pointing at a card that does not exist,
    // and the caller's own id silently in the database under a different name than it was told.
    const normalized = normalizeProjectName(data)
    // Read through a TYPED local: `normalized` comes from JSON.parse, so `normalized.id` is `any`,
    // and letting that flow into `id` made every later call taking it an unsafe-argument finding.
    // A test-only cast would have hidden that; naming the type is the actual fix.
    const rawId: unknown = (normalized as Record<string, unknown>).id
    const suppliedId: string | null = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : null
    const id: string = suppliedId ?? randomUUID().slice(0, 8)
    createKanbanCard({ ...normalized, id })
    // Card 4bade960: run the dedup pre-filter on EVERY new card (rule 6b was previously enforced
    // only by agent discipline before opening a card, and by the >2-day dispatch filter for cards
    // already open). One extra async spawn per card create, awaited before responding -- same
    // pattern as the other guards on this route, and card creation is not a hot path.
    const withDedupNote = await dedupPrefilterDescriptionUpdate(id, String(normalized.description ?? ''))
    if (withDedupNote !== null) {
      updateKanbanCard(id, { description: withDedupNote }, { actor: 'dedup-prefilter-guard' })
    }
    json(res, { ok: true, id })
    return true
  }

  // Relation queries (card 69396b63, FELADAT 3/4). REGISTERED BEFORE kanbanCardMatch ON PURPOSE:
  // that matcher's `([^/]+)` swallows any single segment, so a `/api/kanban/relations` checked
  // after it would be answered as "no card with id 'relations'" -- the exact shadowing card
  // ebf7d95c documents for /archived and /labels. The test file pins both directions.
  if (path === '/api/kanban/relations' && method === 'GET') {
    const parsed = parseRelationQuery(ctx.url)
    if (!parsed.ok) { json(res, { error: parsed.error }, 400); return true }
    jsonMaybeGzip(req, res, queryKanbanRelations(parsed.query))
    return true
  }

  // The two-hop answers. The PATH names what comes back, the PARAMETER names the anchor, so the
  // two cannot be read the wrong way round.
  if (path === '/api/kanban/relations/cards' && method === 'GET') {
    const file = (ctx.url.searchParams.get('file') || '').trim()
    if (!file) {
      json(res, { error: "Kötelező paraméter: ?file=<repo:path> (pl. 'marveen:src/db.ts')." }, 400)
      return true
    }
    jsonMaybeGzip(req, res, cardsTouchingFile(file))
    return true
  }

  if (path === '/api/kanban/relations/files' && method === 'GET') {
    const card = (ctx.url.searchParams.get('card') || '').trim()
    if (!card) { json(res, { error: 'Kötelező paraméter: ?card=<kártya id>.' }, 400); return true }
    jsonMaybeGzip(req, res, filesTouchedByCard(card))
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
    {
      const v = dependencyBlockBody(id, data.status, force === true, typeof actor === 'string' ? actor : undefined)
      if (v.blocked) { json(res, v.body!, 409); return true }
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
    // Optional body, same `actor` convention as POST /move -- card d3f8d2c3: a deletion that
    // unblocks a successor is now audited (kanban_card_field_events), and an unattributed row
    // answers "who" no better than none at all. A DELETE with no body (most callers today) still
    // works: an empty buffer parses to no actor, matching the pre-existing behaviour exactly.
    const rawBody = (await readBody(req)).toString()
    let actor: string | undefined
    if (rawBody.trim()) {
      try {
        const parsed = JSON.parse(rawBody)
        if (typeof parsed?.actor === 'string') actor = parsed.actor
      } catch { /* malformed body on an otherwise-valid DELETE must not block the deletion */ }
    }
    revertIdeaFromKanban(id)
    if (deleteKanbanCard(id, actor)) { json(res, { ok: true }); return true }
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
    {
      const v = dependencyBlockBody(id, status, force === true, typeof actor === 'string' ? actor : undefined)
      if (v.blocked) { json(res, v.body!, 409); return true }
    }
    if (moveKanbanCard(id, status, sort_order ?? 0, actor, force === true)) {
      // Wake the assigned agent once when the card enters in_progress -- unless
      // that agent is the one who moved it (self-pickup needs no wake-up).
      // Fire-and-forget: fireKanbanDispatch's own try/catch means this never rejects, and
      // awaiting it here would hold the HTTP response on a pane-idle wait (card 900178fa).
      if (status === 'in_progress') void fireKanbanDispatch(id, actor)
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
    let actor: string | undefined
    try {
      const body = await readBody(req)
      if (body.length > 0) {
        const parsed = JSON.parse(body.toString()) as Record<string, unknown>
        force = parsed?.['force'] === true
        // Card 7fd6dd23: archiving is a real state change and its audit row should be able to name
        // somebody. Optional and self-declared, like every other actor on this API.
        if (typeof parsed?.['actor'] === 'string') actor = parsed['actor'] as string
      }
    } catch { /* malformed body: force stays false, fail closed */ }
    const result = archiveKanbanCard(id, { force, ...(actor !== undefined ? { actor } : {}) })
    // revertIdeaFromKanban only runs on an ACTUAL archive -- running it on a blocked attempt
    // would unlink the idea from a card that is not actually archived (card 037277a0).
    if (result.ok) {
      revertIdeaFromKanban(id)
      json(res, { ok: true })
      return true
    }
    // Card 394fb5ce, Cybersec L-1: an already-archived card is not an error and not a "not found".
    // The archive UPDATE now refuses to touch it (so the original archival timestamp survives a
    // second POST), and the endpoint answers idempotently rather than 404-ing about a card that
    // plainly exists. `revertIdeaFromKanban` deliberately does NOT run: the first archive already
    // did it, and this call archived nothing.
    if (result.reason === 'already-archived') {
      json(res, { ok: true, alreadyArchived: true })
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
    // Same derived fields as the list, so a caller that opened one card sees what the board shows.
    const blockers = getUnmetKanbanPredecessors(id)
    json(res, {
      ...card,
      blocked: blockers.length > 0,
      blockedBy: blockers.map((c) => ({ id: c.id, title: c.title, status: c.status })),
    })
    return true
  }

  const kanbanUnarchiveMatch = path.match(/^\/api\/kanban\/([^/]+)\/unarchive$/)
  if (kanbanUnarchiveMatch && method === 'POST') {
    const id = decodeURIComponent(kanbanUnarchiveMatch[1])
    let unarchiveActor: string | undefined
    try {
      const body = await readBody(req)
      if (body.length > 0) {
        const parsed = JSON.parse(body.toString()) as Record<string, unknown>
        if (typeof parsed?.['actor'] === 'string') unarchiveActor = parsed['actor'] as string
      }
    } catch { /* no body / malformed: the row is still written, with a null actor */ }
    if (unarchiveKanbanCard(id, unarchiveActor !== undefined ? { actor: unarchiveActor } : {})) { json(res, { ok: true }); return true }
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

  // Card 51878c59: a SEPARATE route rather than folding these into /events, for the same reason
  // they are a separate table -- /events returns a bare array of status transitions and a caller
  // that suddenly found field edits in it would read them as moves.
  const kanbanFieldEventsMatch = path.match(/^\/api\/kanban\/([^/]+)\/field-events$/)
  if (kanbanFieldEventsMatch && method === 'GET') {
    const cardId = decodeURIComponent(kanbanFieldEventsMatch[1]!)
    if (!getKanbanCard(cardId)) { json(res, { error: 'Kártya nem található' }, 404); return true }
    json(res, getKanbanCardFieldEvents(cardId))
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

  // --- Dependencies (card a8aa9ae5) -------------------------------------------------------
  const depsMatch = path.match(/^\/api\/kanban\/([^/]+)\/dependencies$/)
  if (depsMatch && method === 'GET') {
    const id = decodeURIComponent(depsMatch[1]!)
    if (!getKanbanCard(id)) { json(res, { error: 'Kártya nem található' }, 404); return true }
    // WHOLE CARDS, not ids: the modal renders title + status + priority per row, and a second
    // round-trip per edge would make an ordinary card open N+1 requests.
    json(res, { predecessors: getKanbanPredecessors(id), successors: getKanbanSuccessors(id) })
    return true
  }
  if (depsMatch && method === 'POST') {
    const id = decodeURIComponent(depsMatch[1]!)
    const body = await readBody(req)
    const dependsOn = (JSON.parse(body.toString()) as Record<string, unknown>)?.['depends_on_id']
    if (typeof dependsOn !== 'string' || dependsOn.length === 0) {
      json(res, { error: 'depends_on_id kötelező' }, 400); return true
    }
    const r = addKanbanDependency(id, dependsOn)
    if (r.ok) { json(res, { ok: true }); return true }
    if (r.reason === 'not-found') { json(res, { error: `Nincs ilyen kártya: ${r.missing}` }, 404); return true }
    if (r.reason === 'self') { json(res, { code: 'self_dependency', error: 'Egy kártya nem függhet önmagától' }, 409); return true }
    if (r.reason === 'duplicate') { json(res, { code: 'duplicate_dependency', error: 'Ez a függőség már létezik' }, 409); return true }
    json(res, {
      code: 'dependency_cycle',
      error: 'Ez az él kört zárna be: a másik kártya (közvetve) már ettől a kártyától függ. Egy körben minden kártya minden másikat blokkolja, tehát a státusz-kapu soha nem engedne át semmit.',
      path: r.path,
    }, 409)
    return true
  }
  const depDeleteMatch = path.match(/^\/api\/kanban\/([^/]+)\/dependencies\/([^/]+)$/)
  if (depDeleteMatch && method === 'DELETE') {
    const id = decodeURIComponent(depDeleteMatch[1]!)
    const dep = decodeURIComponent(depDeleteMatch[2]!)
    if (removeKanbanDependency(id, dep)) { json(res, { ok: true }); return true }
    json(res, { error: 'Nincs ilyen függőség' }, 404)
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
