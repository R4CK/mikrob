// Refuse to close a card whose OWN "Gate: X (+ Y (+ Z))" line names gate agents that never
// verdicted (card fca19f33, Cybered's finding on 243de9b9).
//
// THE INCIDENT: a `Gate: QA + Cybersec + Cybered` card was closed to `done` by QA alone, on its own
// PASS, while Cybersec and Cybered had not commented at all. Both later gave NO-GO on a real,
// shipped, page-breaking regression (a script-load-order bug) that was already live in production
// by the time anyone looked again. The close API (`PUT`/`POST .../move` to `status: done`) never
// read the card's own Gate: line at all -- any single gate agent (or MikroB) could close a
// multi-gate card on one PASS, and nothing noticed the missing two.
//
// THE PRECEDENT THIS FOLLOWS: kanban-landed-guard.ts already does the same shape of thing for a
// different claim -- "the REVIEW names a commit that reached origin/main" -- gated on the same
// close paths, same force-actor escape hatch, same fail-open-on-internal-error rule (a guard that
// throws must not become a guard that freezes the board), same "distinguish unverifiable from
// verified-and-passed" logging discipline. This file mirrors that shape deliberately rather than
// inventing a second one.
//
// PARSING, reused rather than reinvented: store/gate-dispatch-check.sh already solved "which gates
// does THIS card's Gate: line actually designate" the hard way, closing two real false-positive
// classes along the way (cards 241532d8, 35533cca -- an EXCLUDED gate named inside its own
// exclusion-reasoning parenthetical, e.g. "QA (... trust boundary, ezért Cybersec, nem Cybered)."
// used to wake the excluded gate because its name appeared anywhere in the line). The fix there was
// clause-scoping: only the text BEFORE the first `.`/`(`/`!`/`?` is the actual designation clause.
// Ported here verbatim rather than re-derived, so this guard inherits that hardening instead of
// re-introducing the bug it fixed.
import { getKanbanCard, getKanbanComments } from '../db.js'
import { logger } from '../logger.js'
import type { LandedVerdict } from './kanban-landed-guard.js'

export type GateAgent = 'qa' | 'qa2' | 'cybersec' | 'cybered'

/** Only agents allowed to close a card despite a missing gate verdict -- same actor set as the
 *  landing guard, same reasoning: MikroB is the orchestrator with final call. */
const FORCE_ACTORS = new Set(['mikrob'])

const GATE_LINE_RX = /\bGate\s*:\s*(.+)$/gim

/** The card's own "Gate: ..." line, from its description. LAST match wins (card 84fd2839's shape,
 *  mirrored from the shell tool): an earlier tier decision can be superseded by a later one
 *  appended to the description rather than edited in place, and the newest line is the live one. */
export function extractGateLine(description: string | null): string | null {
  if (!description) return null
  GATE_LINE_RX.lastIndex = 0
  let last: string | null = null
  let m: RegExpExecArray | null
  while ((m = GATE_LINE_RX.exec(description)) !== null) last = m[1] ?? null
  return last
}

function widenQa(names: Set<GateAgent>): Set<GateAgent> {
  if (names.has('qa') || names.has('qa2')) {
    names.add('qa')
    names.add('qa2')
  }
  return names
}

/** Which gate agents a Gate: line actually designates -- `null` if it names none (an unparseable or
 *  free-text line makes no verifiable claim, so this guard has nothing to check, same silent-vs-
 *  verified split as the landing guard's `allowUnverified`). */
export function parseGateDesignation(gateLine: string): Set<GateAgent> | null {
  const clauseEnd = /[.(!?]/.exec(gateLine)
  const clause = clauseEnd ? gateLine.slice(0, clauseEnd.index) : gateLine
  const low = clause.toLowerCase()
  const names = new Set<GateAgent>()
  if (/\bqa2\b/.test(low)) names.add('qa2')
  if (/\bqa\b/.test(low)) names.add('qa')
  if (/\bcybersec\b/.test(low)) names.add('cybersec')
  if (/\bcybered\b/.test(low)) names.add('cybered')
  if (names.size === 0) return null
  return widenQa(names)
}

// PASS/GO/SKIP only -- the card's own wording (243de9b9): a gate must have APPROVED or explicitly
// declined jurisdiction, not merely commented. A NO-GO or FAIL is deliberately NOT a satisfying
// verdict here: that gate looked and said no, and the guard's whole job is to stop a DONE with an
// open "no" sitting on the card, not just a DONE with silence. `(?<!NO[- ])\bGO\b` keeps "GO" from
// matching inside "NO-GO"/"NO GO" -- a later "now fixed, GO" in the SAME comment still counts, only
// the negated form does not.
const VERDICT_RX = /\bPASS\b|\bSKIP\b|(?<!NO[- ])\bGO\b/i
// `m` (multiline): a comment conventionally opens with `Gate-SHA: ...` on its OWN first line (root
// CLAUDE.md rule 4b) and "REVIEW" on the line after it -- without `m`, `^` anchors to the absolute
// start of the whole comment, so that (very common) shape never matched at all (card b68ddae8's own
// completion comment, 13817, is exactly this shape).
const REVIEW_RX = /^\s*REVIEW\b/im
/** QA's own verdict convention prefixes with "REVIEW: QA PASS/FAIL" -- the SAME word builders use
 *  to announce a new round. Counting a gate's own verdict comment as a round-marker made every
 *  OTHER gate's verdict posted BEFORE it look stale, even when nothing had changed (card b68ddae8:
 *  Cybered's GO landed before QA's "REVIEW: QA PASS", so QA's own comment "started a new round" a
 *  moment after Cybered had already verdicted the SAME commit -- Cybered's real, fresh GO was
 *  discarded as pre-round). Only a non-gate author (the builder, MikroB, ...) can open a new round. */
const GATE_AGENT_NAMES: ReadonlySet<string> = new Set<GateAgent>(['qa', 'qa2', 'cybersec', 'cybered'])

interface Comment {
  readonly author: string
  readonly content: string
  readonly created_at: number
}

/** The timestamp of the newest REVIEW comment, or null if the card carries none. A verdict that
 *  predates the newest REVIEW answered an EARLIER round -- a fix can land after a NO-GO, and the
 *  old NO-GO must not keep counting as "Cybersec looked at this" for the new commit. Same freshness
 *  rule gate-dispatch-check.sh already applies per-gate, generalised here to "every designated
 *  gate must have looked at the CURRENT round", not just the one a dispatch happened to target.
 *
 *  FALLBACK ONLY (Cybersec NO-GO on this card, HIGH): a round-boundary defined purely by "who wrote
 *  a REVIEW-shaped comment" breaks the moment a builder hands off a new round WITHOUT the literal
 *  word "REVIEW" (a terse status ping, an inter-agent message summarised into the comment, ...) --
 *  nothing then marks the round change at all, and an OLD verdict for OLD code keeps reading as
 *  fresh forever. currentRoundStartTs (below) anchors to the Gate-SHA identity instead, which is
 *  immune to that gap; this function only runs when NO comment on the card ever used that
 *  convention at all (the field stays optional, CLAUDE.md 4b). */
function latestReviewAt(comments: readonly Comment[]): number | null {
  const stamps = comments
    .filter((c) => REVIEW_RX.test(c.content ?? '') && !GATE_AGENT_NAMES.has((c.author ?? '').toLowerCase()))
    .map((c) => c.created_at)
  return stamps.length ? Math.max(...stamps) : null
}

// `m`: a Gate-SHA line can sit on any line of a comment (CLAUDE.md 4b: "line-initial", not
// necessarily comment-initial), same reasoning as REVIEW_RX above.
const GATE_SHA_LINE_RX = /^\s*Gate-SHA\s*:\s*(.+)$/gim

/** Every short-sha token declared on a Gate-SHA line in `content` (lowercased, deduped). A card can
 *  legitimately cite more than one commit on one line ("Gate-SHA: e46f9968, 9e9a79bc"). */
function extractGateShas(content: string): ReadonlySet<string> {
  GATE_SHA_LINE_RX.lastIndex = 0
  const out = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = GATE_SHA_LINE_RX.exec(content)) !== null) {
    for (const tok of (m[1] ?? '').split(',')) {
      const sha = /^[0-9a-f]{6,40}/i.exec(tok.trim())?.[0]?.toLowerCase()
      if (sha) out.add(sha)
    }
  }
  return out
}

/** The PRIMARY round-boundary (Cybersec's suggested direction, round 1; corrected round 3 after
 *  their second HIGH NO-GO). "The current round" is whichever Gate-SHA was cited most recently on
 *  the card (by any author, REVIEW-worded or not). Anchoring to the actual commit identity, not to
 *  comment wording, closes the round-1 bypass: a builder hand-off with no literal "REVIEW" still
 *  moves the boundary, as long as it states the new Gate-SHA.
 *
 *  ROUND-3 CORRECTION: the start is the LATEST of each cited sha's OWN earliest-introduction time,
 *  not the earliest comment sharing ANY of them. "Earliest shared comment" let an old, already-
 *  closed sha drag the boundary back to ITS first mention the moment a later comment cited it
 *  ALONGSIDE a genuinely new sha (a documented, supported shape: "Gate-SHA: <old>, <new>" citing a
 *  diff range across a fix) -- Cybersec's own probe: aaaaaaa1 first mentioned t=100, a real new
 *  round starts at bbbbbbb2 (first mentioned t=200), then QA cites "aaaaaaa1, bbbbbbb2" together at
 *  t=250 -- the old logic anchored on aaaaaaa1's t=100, making a Cybersec verdict for aaaaaaa1 from
 *  t=120 read as fresh for a round it never saw. Per-sha introduction time, then the LATEST of
 *  those among the cited set, means an old sha bundled into a later multi-sha citation cannot pull
 *  the boundary earlier than the newest sha in that same citation.
 *
 *  Returns null when NOT ONE comment on the card ever used the Gate-SHA convention -- the caller
 *  falls back to {@link latestReviewAt} for that card, unchanged. */
function currentRoundStartTs(comments: readonly Comment[]): number | null {
  const introducedAt = new Map<string, number>()
  let latest: Comment | null = null
  let latestShas: ReadonlySet<string> = new Set()
  for (const c of comments) {
    const shas = extractGateShas(c.content ?? '')
    if (shas.size === 0) continue
    for (const s of shas) {
      const prior = introducedAt.get(s)
      if (prior === undefined || c.created_at < prior) introducedAt.set(s, c.created_at)
    }
    if (!latest || c.created_at > latest.created_at) {
      latest = c
      latestShas = shas
    }
  }
  if (!latest) return null
  let start = -Infinity
  for (const s of latestShas) {
    const t = introducedAt.get(s)
    if (t !== undefined && t > start) start = t
  }
  return start
}

/** Does `agent` have a fresh (post-latest-REVIEW) verdict-shaped comment on this card? */
function hasFreshVerdict(comments: readonly Comment[], agent: GateAgent, sinceTs: number | null): boolean {
  return comments.some(
    (c) =>
      (c.author ?? '').toLowerCase() === agent &&
      VERDICT_RX.test(c.content ?? '') &&
      (sinceTs === null || c.created_at >= sinceTs),
  )
}

function allowUnverified(cardId: string, reason: string, extra: Record<string, unknown> = {}): LandedVerdict {
  logger.info({ cardId, reason, ...extra }, 'gate-completeness-guard: allowing a close it could NOT verify')
  return { blocked: false }
}

/** Blocks a move to `done` when the card's own Gate: line designates an agent that has not posted a
 *  fresh PASS/GO/SKIP-shaped comment for the current round. */
export function gateCompletenessGuardVerdict(cardId: string, nextStatus: unknown, force: boolean, actor?: string): LandedVerdict {
  if (nextStatus !== 'done') return { blocked: false }
  if (force && actor !== undefined && FORCE_ACTORS.has(actor)) return { blocked: false }

  let card: ReturnType<typeof getKanbanCard>
  let comments: Comment[]
  try {
    card = getKanbanCard(cardId)
    comments = getKanbanComments(cardId)
  } catch (err) {
    // Same rule as the landing guard: a guard that throws must not become a guard that freezes the
    // board. The failure is in the checker, not the claim, so stand aside.
    logger.warn({ err, cardId }, 'gate-completeness-guard could not read the card; allowing the close')
    return { blocked: false }
  }

  const gateLine = extractGateLine(card?.description ?? null)
  if (gateLine === null) return allowUnverified(cardId, 'no-gate-line')

  const designated = parseGateDesignation(gateLine)
  if (designated === null) return allowUnverified(cardId, 'gate-line-names-no-known-agent', { gateLine })

  // SHA-anchored round boundary first (closes the Cybersec NO-GO bypass); only when NOT ONE comment
  // on the card ever cited a Gate-SHA does this fall back to the word/author-based heuristic.
  const sinceTs = currentRoundStartTs(comments) ?? latestReviewAt(comments)
  // QA/QA2 are ONE requirement, not two (widenQa above is about not falsely EXCLUDING qa2 from
  // acting, not about requiring both). A Gate line naming only "QA" must not demand a qa2 verdict
  // that nothing ever asked for -- either one satisfies the QA-family requirement.
  const missing: string[] = []
  if (designated.has('qa') || designated.has('qa2')) {
    const qaFamilyOk = hasFreshVerdict(comments, 'qa', sinceTs) || hasFreshVerdict(comments, 'qa2', sinceTs)
    if (!qaFamilyOk) missing.push('QA')
  }
  if (designated.has('cybersec') && !hasFreshVerdict(comments, 'cybersec', sinceTs)) missing.push('Cybersec')
  if (designated.has('cybered') && !hasFreshVerdict(comments, 'cybered', sinceTs)) missing.push('Cybered')
  if (missing.length === 0) return { blocked: false }

  const names = missing.join(', ')
  return {
    blocked: true,
    message:
      `Ez a kártya nem zárható: a kártya saját "Gate: ${gateLine.trim()}" sora ${names} verdiktjét is megköveteli, ` +
      `de ${missing.length === 1 ? 'tőle' : 'tőlük'} még nincs friss PASS/GO/SKIP-verdikt-komment (egy NO-GO/FAIL nem számít annak -- az nyitott "nem") a jelenlegi ` +
      `körre (kártya 243de9b9: egy 3-gate kártyát QA egyedül zárt, a másik két gate NO-GO-t adott volna egy éles ` +
      `regresszióra). Dispatcheld a hiányzó gate(ek)nek, és csak a verdikt(ek) beérkezése után zárd. ` +
      `Ha tudatosan mégis zárni kell, MikroB force: true-val megteheti.`,
  }
}
