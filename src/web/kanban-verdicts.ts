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
import { readBody, json } from './http-helpers.js'
import { forceActors } from '../kanban-force-actors.js'
import { agentKeyToAgentId } from './auth-device-keys.js'
import {
  getKanbanCard, getKanbanComments,
  addKanbanVerdict, getKanbanVerdicts,
  setKanbanGateAssignment, getKanbanGateAssignment, getKanbanGateAssignmentEvents,
  addKanbanFixProposal, getLatestKanbanFixProposal, getKanbanFixProposals,
  type GateVerdictGate, type GateVerdictWord,
} from '../db.js'
// Cross-import with kanban-gate-completeness-guard.ts (which already imports
// isAgentVerdictRecordEnabled from THIS module) -- a deliberate two-file cycle, safe here because
// both sides only ever call these at request time, inside a function body, never at module-load
// top level. Reused rather than re-derived so the POST-side designation check (below) and the
// enforcing guard's own parse agree by construction instead of by discipline.
import { extractGateLine, parseGateDesignation, latestReviewGateSha, type GateAgent } from './kanban-gate-completeness-guard.js'
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

// RedHat B1 / WhiteHat W1 (comments 16554/16573): the measured bypass was an authenticated author
// who simply isn't in the gate's own role (e.g. `fullstack` writing a GO record for the QA gate).
// This is the EXACT identifier allowlist, not a prefix/pattern match -- a gate may only write (or,
// in the completeness guard below, be TRUSTED for) its own designated role.
export const GATE_ROLE_AGENTS: Readonly<Record<GateVerdictGate, readonly GateAgent[]>> = {
  QA: ['qa', 'qa2'],
  CYBERSEC: ['cybersec', 'cybersec2'],
  CYBERED: ['cybered'],
}

function isGateRoleAgent(gate: GateVerdictGate, author: string): boolean {
  return (GATE_ROLE_AGENTS[gate] as readonly string[]).includes(author.trim().toLowerCase())
}

/** B1 (c): a verdict may only be recorded for a gate the card's OWN "Gate: ..." line actually
 *  designates -- the SAME parser the enforcing completeness guard uses (imported above), so the
 *  two can never silently disagree. A card with no parseable Gate: line makes no verifiable claim
 *  at all, the same permissive default the guard itself applies (`allowUnverified`), so nothing is
 *  rejected here either -- this is an extra check, not a stricter one. */
function isGateDesignatedOnCard(cardId: string, gate: GateVerdictGate): boolean {
  const card = getKanbanCard(cardId)
  const gateLine = extractGateLine(card?.description ?? null)
  if (gateLine === null) return true
  const designated = parseGateDesignation(gateLine)
  if (designated === null) return true
  return GATE_ROLE_AGENTS[gate].some((a) => designated.has(a))
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
 *  the resolved author against a proposer claim -- same agent (case-insensitive) is rejected; a
 *  sibling (cybersec vs cybersec2) is a DIFFERENT agent and is allowed. Card 2bfa4c67 delta
 *  (WhiteHat W3, comment 16573): the CALLER now passes the latest AUTHENTICATED
 *  kanban_fix_proposals row, never the request body's own `proposer` field -- that field was
 *  trivially omittable (RedHat B2) and a comment-derived proposer is just as forgeable under the
 *  one shared dashboard token as the body field it would replace. */
export function isSelfProposedVerdict(author: string, proposer: unknown): boolean {
  if (typeof proposer !== 'string' || !proposer.trim()) return false
  return proposer.trim().toLowerCase() === author.trim().toLowerCase()
}

const SHA_SHAPE_RX = /^[0-9a-f]{6,40}$/i

/** A well-formed sha token from a request body field, or null -- card 2bfa4c67 round 2 (N1/N5): a
 *  sha that does not even look like a sha (empty, too short, non-hex) is treated as absent, not as
 *  "provided but garbage", so the caller gets the same "sha kötelező" message either way. */
function parseProvidedSha(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return SHA_SHAPE_RX.test(t) ? t.toLowerCase() : null
}

/** Two sha citations refer to the same commit when one is a prefix of the other (git's own
 *  short-sha convention) -- same prefix-containment rule `kanban-gate-completeness-guard.ts`'s
 *  round-boundary logic already uses, so a short-form citation on one side and a full 40-char
 *  citation on the other are not treated as a mismatch. */
function shasMatch(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a)
}

/** card 2bfa4c67 round 2 (WhiteHat2 N1/W2, MikroB 16574: BLOCKING). A verdict/proposal record is
 *  only trustworthy as "about the CURRENT round" if it declares the same sha the latest builder
 *  hand-off itself declared (`latestReviewGateSha`). When that hand-off never used the Gate-SHA
 *  convention at all, there is nothing to bind against -- same permissive default every other
 *  guard in this codebase applies to an unverifiable claim (`allowUnverified`). Returns an error
 *  message when the check fails, or null when it passes (including the permissive no-claim case). */
function shaBindingError(cardId: string, providedSha: string | null): string | null {
  const latestSha = latestReviewGateSha(getKanbanComments(cardId))
  if (latestSha === null) return null
  if (providedSha === null) {
    return `sha kötelező (hex, a kártya legfrissebb REVIEW Gate-SHA-jával -- ${latestSha} -- kell egyeznie)`
  }
  if (!shasMatch(providedSha, latestSha)) {
    return `a megadott sha (${providedSha}) nem egyezik a kártya legfrissebb REVIEW Gate-SHA-jával (${latestSha})`
  }
  return null
}

const kanbanVerdictsMatch = (path: string) => path.match(/^\/api\/kanban\/([^/]+)\/verdicts$/)
const kanbanGateAssignmentMatch = (path: string) => path.match(/^\/api\/kanban\/([^/]+)\/gate-assignment$/)
const kanbanProposalsMatch = (path: string) => path.match(/^\/api\/kanban\/([^/]+)\/proposals$/)

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
    const { gate, verdict, sha, round, findings_ref, author: claimedAuthor } = parsed
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
    // B1 / W1: exact role-allowlist, regardless of author_verified -- the measured bypass (RedHat
    // T5) was an authenticated, but wrong-role, author (`fullstack` writing to the QA gate).
    if (!isGateRoleAgent(gate, author)) {
      json(res, { error: `a(z) "${author}" ügynök nem tagja a ${gate} gate szerepkörének` }, 403)
      return true
    }
    // B1 (c): the gate must actually be among the card's own designated gates.
    if (!isGateDesignatedOnCard(cardId, gate)) {
      json(res, { error: `a ${gate} gate nincs a kártya saját "Gate:" sorában kijelölve` }, 400)
      return true
    }
    // N1 / W2 (card 2bfa4c67 round 2, MikroB 16574: BLOCKING): the record's own sha must bind to
    // the latest builder hand-off's declared Gate-SHA, when one exists -- the measured bypass was
    // a verdict record citing an arbitrary (or no) sha and still being accepted as "about" the
    // current round.
    const providedSha = parseProvidedSha(sha)
    const shaError = shaBindingError(cardId, providedSha)
    if (shaError) {
      json(res, { error: shaError }, 400)
      return true
    }
    // B2 / W3 + N5 (card 2bfa4c67 round 2, WhiteHat2 NO-GO): the exclusion is SET-semantics over
    // EVERY authenticated proposal written for the current round's sha, not just the latest row --
    // "latest wins" let a later, unrelated proposal from a different agent silently clear an
    // earlier, still-relevant exclusion. A proposal with no sha at all (written before this field
    // existed) still counts when the card has no current Gate-SHA to scope by, same permissive
    // fallback as shaBindingError's no-claim case; once a Gate-SHA exists, only proposals bound to
    // it participate, so an agent excluded in an OLD round is not blocked forever in a new one.
    const latestSha = latestReviewGateSha(getKanbanComments(cardId))
    const roundProposals = getKanbanFixProposals(cardId).filter((p) =>
      latestSha === null ? true : p.sha !== null && shasMatch(p.sha, latestSha),
    )
    if (roundProposals.some((p) => isSelfProposedVerdict(author, p.proposer))) {
      json(res, { error: 'a javaslattevő (proposer) ügynök nem adhat verdiktet a saját javaslatára' }, 403)
      return true
    }
    const latestProposal = getLatestKanbanFixProposal(cardId)
    const row = addKanbanVerdict(cardId, {
      gate,
      verdict,
      sha: providedSha,
      round: typeof round === 'number' && Number.isInteger(round) && round > 0 ? round : 1,
      findingsRef: typeof findings_ref === 'string' ? findings_ref : null,
      proposer: latestProposal ? latestProposal.proposer : null,
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

  // B2 / W3: records WHO proposed the fix a gate is being asked to verdict on. Authenticated-only
  // (an agent:<id> device key) -- the shared dashboard token cannot write a proposal, because an
  // unauthenticated claim here would be worse than none: it would make the self-exclusion look
  // enforced while being exactly as forgeable as the request-body field it replaces.
  const proposalsMatch = kanbanProposalsMatch(path)
  if (proposalsMatch && method === 'GET') {
    const cardId = decodeURIComponent(proposalsMatch[1])
    json(res, getLatestKanbanFixProposal(cardId))
    return true
  }
  if (proposalsMatch && method === 'POST') {
    const cardId = decodeURIComponent(proposalsMatch[1])
    if (!getKanbanCard(cardId)) { json(res, { error: 'Kártya nem található' }, 404); return true }
    const agentId = ctx.auth?.kind === 'device' ? agentKeyToAgentId(ctx.auth.device) : null
    if (!agentId) {
      json(res, { error: 'javaslat rögzítése kizárólag hitelesített agent:<id> kulccsal lehetséges' }, 403)
      return true
    }
    const body = await readBody(req)
    let parsed: Record<string, unknown> = {}
    if (body.length > 0) {
      try {
        parsed = JSON.parse(body.toString()) as Record<string, unknown>
      } catch {
        json(res, { error: 'Invalid JSON body' }, 400)
        return true
      }
    }
    // N5 (card 2bfa4c67 round 2, WhiteHat2 NO-GO): a proposal is bound to the SAME current round's
    // Gate-SHA the verdict-side check (above) requires, so the set-semantics exclusion stays
    // scoped to this round instead of blocking the proposer forever on a stale, superseded one.
    const providedSha = parseProvidedSha(parsed.sha)
    const shaError = shaBindingError(cardId, providedSha)
    if (shaError) {
      json(res, { error: shaError }, 400)
      return true
    }
    const row = addKanbanFixProposal(cardId, agentId, providedSha)
    json(res, row, 201)
    return true
  }

  return false
}
