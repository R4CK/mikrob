// Structured gate-verdict + gate-assignment records (card 2bfa4c67, F2).
//
// See the CREATE TABLE comments in db.ts for the full rationale. Summary: a verdict comment's
// author comes from the request BODY under the one shared dashboard token (WhiteHat2 1cdac111
// F1), so any caller can claim to be any gate. This module adds a SECOND, structured, opt-in-read
// source alongside the existing comment-parse pipeline -- never a replacement, per the
// plan-grilling verdict (MikroB): "a feltevés nem véd a hamisítás ellen, amíg a megosztott token
// mindenkinél ott van" -- so authorship here is resolved from an authenticated agent:<id> device
// key when the caller presents one, and marked UNVERIFIED (not silently upgraded) otherwise.
//
// Flag (plan-grilling requirement (5)): AGENT_VERDICT_RECORD env var. Default OFF -- the routes in
// this module are reachable only when it is "1"/"true"; off, tryHandleKanbanVerdicts always
// returns false (pass-through), so a fresh install/default config sees zero new behavior.
import type http from 'node:http'
import { readBody, json } from './http-helpers.js'
import { forceActors } from '../kanban-force-actors.js'
import { agentKeyToAgentId } from './auth-device-keys.js'
import {
  getKanbanCard,
  addKanbanVerdict, getKanbanVerdicts,
  setKanbanGateAssignment, getKanbanGateAssignment, getKanbanGateAssignmentEvents,
  type GateVerdictGate, type GateVerdictWord,
} from '../db.js'
import type { RouteContext } from './routes/types.js'

export function isAgentVerdictRecordEnabled(): boolean {
  const v = (process.env.AGENT_VERDICT_RECORD ?? '').trim().toLowerCase()
  return v === '1' || v === 'true'
}

const VALID_GATES: readonly GateVerdictGate[] = ['QA', 'CYBERSEC', 'CYBERED']
const VALID_VERDICTS: readonly GateVerdictWord[] = ['PASS', 'FAIL', 'GO', 'NO-GO']

function isGateVerdictGate(v: unknown): v is GateVerdictGate {
  return typeof v === 'string' && (VALID_GATES as readonly string[]).includes(v.toUpperCase()) && v === v.toUpperCase()
}

function isGateVerdictWord(v: unknown): v is GateVerdictWord {
  return typeof v === 'string' && (VALID_VERDICTS as readonly string[]).includes(v.toUpperCase()) && v === v.toUpperCase()
}

/** Resolve the caller's identity for a verdict record: an authenticated `agent:<id>` device key
 *  (card 84dcc5d4) is VERIFIED; anything else falls back to the body's own claim, UNVERIFIED. The
 *  claim is still required (an empty/missing author is a 400, handled by the caller) -- this
 *  function only decides whether to trust it. */
export function resolveVerdictAuthor(ctx: RouteContext, claimedAuthor: unknown): { author: string | null; verified: boolean } {
  if (ctx.auth?.kind === 'device') {
    const agentId = agentKeyToAgentId(ctx.auth.device)
    if (agentId) return { author: agentId, verified: true }
  }
  const claimed = typeof claimedAuthor === 'string' ? claimedAuthor.trim() : ''
  return { author: claimed || null, verified: false }
}

/** RedHat 16225 (card 21abfe0b): a gate must never verdict the fix direction IT proposed. Compares
 *  the resolved author against the request's own `proposer` claim -- same agent (case-insensitive)
 *  is rejected; a sibling (cybersec vs cybersec2) is a DIFFERENT agent and is allowed. */
export function isSelfProposedVerdict(author: string, proposer: unknown): boolean {
  if (typeof proposer !== 'string' || !proposer.trim()) return false
  return proposer.trim().toLowerCase() === author.trim().toLowerCase()
}

const kanbanVerdictsMatch = (path: string) => path.match(/^\/api\/kanban\/([^/]+)\/verdicts$/)
const kanbanGateAssignmentMatch = (path: string) => path.match(/^\/api\/kanban\/([^/]+)\/gate-assignment$/)

export async function tryHandleKanbanVerdicts(ctx: RouteContext): Promise<boolean> {
  if (!isAgentVerdictRecordEnabled()) return false
  const { req, res, path, method } = ctx

  const verdictsMatch = kanbanVerdictsMatch(path)
  if (verdictsMatch && method === 'GET') {
    const cardId = decodeURIComponent(verdictsMatch[1])
    json(res, getKanbanVerdicts(cardId))
    return true
  }
  if (verdictsMatch && method === 'POST') {
    const cardId = decodeURIComponent(verdictsMatch[1])
    if (!getKanbanCard(cardId)) { json(res, { error: 'Kártya nem található' }, 404); return true }
    const body = await readBody(req)
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(body.toString()) as Record<string, unknown>
    } catch {
      json(res, { error: 'Invalid JSON body' }, 400)
      return true
    }
    const { gate, verdict, sha, round, findings_ref, proposer, author: claimedAuthor } = parsed
    if (!isGateVerdictGate(gate)) {
      json(res, { error: `gate kötelező, egyike: ${VALID_GATES.join(', ')}` }, 400)
      return true
    }
    if (!isGateVerdictWord(verdict)) {
      json(res, { error: `verdict kötelező, egyike: ${VALID_VERDICTS.join(', ')}` }, 400)
      return true
    }
    const { author, verified } = resolveVerdictAuthor(ctx, claimedAuthor)
    if (!author) {
      json(res, { error: 'author kötelező (vagy hitelesített agent:<id> kulcs, vagy a body author mezője)' }, 400)
      return true
    }
    if (isSelfProposedVerdict(author, proposer)) {
      json(res, { error: 'a javaslattevő (proposer) ügynök nem adhat verdiktet a saját javaslatára' }, 403)
      return true
    }
    const row = addKanbanVerdict(cardId, {
      gate,
      verdict,
      sha: typeof sha === 'string' ? sha : null,
      round: typeof round === 'number' && Number.isInteger(round) && round > 0 ? round : 1,
      findingsRef: typeof findings_ref === 'string' ? findings_ref : null,
      proposer: typeof proposer === 'string' ? proposer : null,
      author,
      authorVerified: verified,
    })
    json(res, row, 201)
    return true
  }

  const assignmentMatch = kanbanGateAssignmentMatch(path)
  if (assignmentMatch && method === 'GET') {
    const cardId = decodeURIComponent(assignmentMatch[1])
    json(res, { current: getKanbanGateAssignment(cardId), history: getKanbanGateAssignmentEvents(cardId) })
    return true
  }
  if (assignmentMatch && method === 'POST') {
    const cardId = decodeURIComponent(assignmentMatch[1])
    if (!getKanbanCard(cardId)) { json(res, { error: 'Kártya nem található' }, 404); return true }
    const body = await readBody(req)
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(body.toString()) as Record<string, unknown>
    } catch {
      json(res, { error: 'Invalid JSON body' }, 400)
      return true
    }
    const { gates, actor } = parsed
    // Plan-grilling requirement (2): only a MikroB-route actor may change the structured
    // assignment. `actor` is self-declared (same limit kanban-force-actors.ts's own docstring
    // states), but it IS the existing, audited speed bump every other status-guard in this
    // codebase already relies on -- not a new, weaker promise.
    if (typeof actor !== 'string' || !forceActors().includes(actor)) {
      json(res, { error: `gate-assignment csak a kijelölt actor(ok)tól fogadható el: ${forceActors().join(', ')}` }, 403)
      return true
    }
    if (!Array.isArray(gates) || gates.length === 0 || !gates.every(isGateVerdictGate)) {
      json(res, { error: `gates kötelező, nem-üres tömb ezekből: ${VALID_GATES.join(', ')}` }, 400)
      return true
    }
    const row = setKanbanGateAssignment(cardId, gates, actor)
    json(res, row, 201)
    return true
  }

  return false
}
