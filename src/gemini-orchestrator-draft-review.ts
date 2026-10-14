// Gemini orchestrator draft review (card 626df838, slice 3/4 of cf757409).
//
// SCOPE (card title): "Gemini elso koros draft-ellenorzes, KIZAROLAG MikroB-projekt kartyakon."
// While Claude's quota is exhausted, 1/4 picks the order and 2/4 drives the local-LLM draft onto
// disk (store/drafts/<cardId>/, decision B). This slice has Gemini give a FIRST-ROUND opinion on
// that draft -- standing in for MikroB's normal "is this worth a role-agent's time" triage, not
// for the role-agent's own review. Point 4 of the parent phase (b8da509b, already built) is the
// REAL adjudication: a human/role-agent `Draft-Review: <verdict>` comment, posted after the quota
// resets, is what unblocks the card (kanban-draft-review-guard.ts) and what 4/4 deletes the draft
// file on. This module changes neither of those gates.
//
// WHY THE POSTED COMMENT MUST NEVER MATCH `Draft-Review: ...` (DRAFT_REVIEW_RX). Peti's own words
// on the parent card: "a draftokat ellenorzik az ugynokok" -- the role AGENTS adjudicate, not
// Gemini alone. If this module's opinion satisfied kanban-draft-review-guard.ts, a card could
// reach `waiting` -- and 4/4 could delete its draft file -- on Gemini's say-so by itself, which is
// exactly the self-satisfying-review hole CLAUDE.md's gate rules exist to close (see
// kanban-draft-review-guard.ts's own header on the plan-grilling guard precedent). The marker used
// below (GEMINI_FIRST_PASS_PREFIX) is therefore a visibly different string, and a test in this
// module's test file asserts it against the REAL imported DRAFT_REVIEW_RX, not a hand-copied
// pattern that could silently drift into a false match later.
//
// ELIGIBILITY, TWO GATES, BOTH REQUIRED (unlike 1/4, which only ever sees title+labels, this
// module reads the card's full description AND the draft's full text -- a materially larger
// exposure, so both gates below apply before anything leaves this process):
//   (a) PROJECT: card.project must be exactly "MikroB" (casefold) -- the title's "KIZAROLAG
//       MikroB-projekt kartyakon". mopsion and every other/unknown project are out, no exception.
//   (b) CONTENT: the landed is_gemini_blocked filter (store/offload-dispatch.sh --check-blocked,
//       the same single source of truth 1/4 already calls via isBlockedByLandedFilter) still runs
//       on the card's title+desc+tags -- a MikroB-project card CAN carry a BLOKKOLT-* or sensitive
//       label (e.g. a MikroB-project security/infra card about secrets handling), and gate (a)
//       alone would not catch that.
// On top of both: a fail-closed secret-shape scan (reusing security/secret-gate.ts's
// SECRET_PATTERNS, not a second hand-copied list) runs on the ACTUAL text about to be sent --
// title, description and draft body -- right before the Gemini call. Any hit skips the card with
// no API call and no comment, same as any other fail-closed outcome in this file.
//
// FAIL-CLOSED SHAPE (mirrors 1/4 and 2/4): kill switch OFF by default, route must be exactly
// "gemini". Per-card: any failure (ineligible, secret-shaped, unreadable draft file, outside the
// drafts directory, unparsable Gemini response) skips that one card and the sweep continues --
// one bad card must never stall the rest.

import { readFileSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { geminiGenerate, GEMINI_VAULT_KEY_ID, type GeminiCallOptions, type GeminiResult } from './gemini-client.js'
import { getSecret } from './web/vault.js'
import { getKanbanCard, getKanbanComments, addKanbanComment, getLabelsForCard } from './db.js'
import { isGeminiOrchestratorEnabled, readFallbackRoute, isBlockedByLandedFilter } from './gemini-orchestrator.js'
import { listDraftCardIds, findLatestDraftFileRef, DRAFTS_DIR, type Comment } from './gemini-orchestrator-draft-cleanup.js'
import { DRAFT_REVIEW_RX } from './web/kanban-draft-review-guard.js'
import { GENERATED_COMMENT_AUTHORS } from './web/kanban-landed-guard.js'
import { SECRET_PATTERNS } from './security/secret-gate.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const STORE = join(ROOT, 'store')

/** The author this module posts under -- deliberately absent from GENERATED_COMMENT_AUTHORS
 *  would be WRONG here: a Gemini-opinion comment satisfying hasDraftReview()'s author check (even
 *  though its content never matches DRAFT_REVIEW_RX) is a second, unnecessary route to the same
 *  hole the marker-distinctness design above already closes structurally. Listed in
 *  GENERATED_COMMENT_AUTHORS so BOTH checks hold independently, not just one. */
export const REVIEW_AUTHOR = 'gemini-orch-review'

/** Distinct from kanban-draft-review-guard.ts's `Draft-Review:` marker on purpose -- see header. */
const GEMINI_FIRST_PASS_PREFIX = 'GEMINI-ELSO-KOR'

const REQUIRED_PROJECT = 'mikrob'

export interface DraftReviewCardMeta {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly project: string | null
  readonly tags: string
}

/** Gate (a)+(b) from the header: exact project match, then the landed content filter. */
export function isEligibleForGeminiDraftReview(card: DraftReviewCardMeta): boolean {
  if ((card.project ?? '').trim().toLowerCase() !== REQUIRED_PROJECT) return false
  return !isBlockedByLandedFilter(card.project ?? '', card.tags, card.title, card.description)
}

/** Fail-closed secret-shape scan over the exact text about to leave the process. Reuses
 *  security/secret-gate.ts's patterns rather than a second hand-copied list (the precise mistake
 *  RedHat's 17510 finding on the Bash-side gate already measured drifting once). */
export function containsSecretShape(text: string): boolean {
  return SECRET_PATTERNS.some(({ pattern }) => pattern.test(text))
}

/** Resolves a ref.path (relative to STORE, e.g. "drafts/<card>/<file>.md") to an absolute path,
 *  or null if it would land outside DRAFTS_DIR. The writer (store/offload-dispatch.sh) already
 *  sanitizes the card/leaf id into [A-Za-z0-9_-] before building this path, so an escape should
 *  be impossible by construction -- this is a second, independent check on the READ side, same
 *  defense-in-depth posture as the rest of this pipeline. */
export function resolveDraftPathSafely(relPath: string): string | null {
  const abs = resolve(STORE, relPath)
  if (abs !== DRAFTS_DIR && !abs.startsWith(DRAFTS_DIR + sep)) return null
  return abs
}

/** True when the card already has an adjudication at or after the given draft timestamp -- either
 *  a real human/role-agent Draft-Review verdict, or a prior first-pass opinion from this module.
 *  Either one means this sweep has nothing new to do for this card. */
export function alreadyAdjudicated(comments: readonly Comment[], draftAt: number): boolean {
  return comments.some((c) => {
    if ((c.created_at ?? 0) < draftAt) return false
    const author = (c.author ?? '').toLowerCase()
    if (author === REVIEW_AUTHOR) return true
    if (!GENERATED_COMMENT_AUTHORS.has(author) && DRAFT_REVIEW_RX.test(c.content ?? '')) return true
    return false
  })
}

export function buildReviewPrompt(card: DraftReviewCardMeta, draftText: string): string {
  return [
    'You are giving a FIRST-PASS opinion on a draft a small local model wrote for a software task.',
    'A human engineer will make the real decision later -- your job is only to help them triage',
    'faster: is this draft worth reading closely, or should it likely be ignored/rewritten.',
    '',
    'Read the task spec FIRST and ask what is MISSING from the draft relative to it, not only',
    'whether what IS in the draft looks correct.',
    '',
    'Return STRICT JSON ONLY, no prose, no markdown fences:',
    '{"verdict": "USABLE" | "PARTIAL" | "UNUSABLE", "reason": "<one or two sentences>"}',
    '',
    '=== TASK SPEC ===',
    `Title: ${card.title}`,
    `Description: ${card.description}`,
    '',
    '=== DRAFT ===',
    draftText,
  ].join('\n')
}

export interface ReviewVerdict {
  readonly verdict: 'USABLE' | 'PARTIAL' | 'UNUSABLE'
  readonly reason: string
}

/** Fail-closed parser (mirrors parseOrderingResponse in gemini-orchestrator.ts): anything but the
 *  exact two-field shape with a valid verdict value returns null. */
export function parseReviewResponse(text: string): ReviewVerdict | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  if (obj.verdict !== 'USABLE' && obj.verdict !== 'PARTIAL' && obj.verdict !== 'UNUSABLE') return null
  if (typeof obj.reason !== 'string' || obj.reason.length === 0) return null
  return { verdict: obj.verdict, reason: obj.reason }
}

export function formatReviewComment(verdict: ReviewVerdict): string {
  return (
    `${GEMINI_FIRST_PASS_PREFIX}: ${verdict.verdict}\n` +
    `${verdict.reason}\n\n` +
    'Ez Gemini elsokoros velemenye (kartya 626df838), NEM a hivatalos elbiralas -- a kvota ' +
    'visszaterese utan a felelos agent sajat "Draft-Review: ..." sora donti el, mi tortenik a ' +
    'drafttal (card 1338e68b, 4/4 ezen felirat utan torli a fajlt).'
  )
}

export interface DraftReviewResult {
  readonly id: string
  readonly reviewed: boolean
  readonly reason?: string
}

/**
 * Reviews exactly one card's newest draft. Never throws: every exit is `{ reviewed: false, reason
 * }`. callGemini is injectable for tests; readCard/readComments/readLabels/readDraft/postComment
 * are injectable so the pure decision logic (eligibility, secret scan, parsing) can be tested
 * without touching the DB or filesystem.
 */
export async function reviewOneCard(
  cardId: string,
  apiKey: string | null,
  deps: {
    readCard: (id: string) => { title: string; description: string | null; project: string | null } | undefined
    readComments: (id: string) => Comment[]
    readLabels: (id: string) => readonly { name: string }[]
    readDraft: (absPath: string) => string
    postComment: (id: string, author: string, content: string) => void
    callGemini: (opts: GeminiCallOptions) => Promise<GeminiResult>
  },
): Promise<DraftReviewResult> {
  let comments: Comment[]
  try {
    comments = deps.readComments(cardId)
  } catch (err) {
    return { id: cardId, reviewed: false, reason: `comments_unreadable: ${String(err)}` }
  }

  const ref = findLatestDraftFileRef(comments)
  if (!ref) return { id: cardId, reviewed: false, reason: 'no_draft' }
  if (alreadyAdjudicated(comments, ref.at)) return { id: cardId, reviewed: false, reason: 'already_adjudicated' }

  const absPath = resolveDraftPathSafely(ref.path)
  if (!absPath) return { id: cardId, reviewed: false, reason: 'unsafe_draft_path' }

  let card: { title: string; description: string | null; project: string | null } | undefined
  try {
    card = deps.readCard(cardId)
  } catch (err) {
    return { id: cardId, reviewed: false, reason: `card_unreadable: ${String(err)}` }
  }
  if (!card) return { id: cardId, reviewed: false, reason: 'card_missing' }

  let labels: readonly { name: string }[]
  try {
    labels = deps.readLabels(cardId)
  } catch {
    labels = []
  }
  const meta: DraftReviewCardMeta = {
    id: cardId,
    title: card.title,
    description: card.description ?? '',
    project: card.project,
    tags: labels.map((l) => l.name.replace(/^@/, '')).join(','),
  }

  if (!isEligibleForGeminiDraftReview(meta)) return { id: cardId, reviewed: false, reason: 'not_eligible' }

  let draftText: string
  try {
    draftText = deps.readDraft(absPath)
  } catch (err) {
    return { id: cardId, reviewed: false, reason: `draft_unreadable: ${String(err)}` }
  }

  if (containsSecretShape(meta.title) || containsSecretShape(meta.description) || containsSecretShape(draftText)) {
    return { id: cardId, reviewed: false, reason: 'secret_shape_detected' }
  }

  const prompt = buildReviewPrompt(meta, draftText)
  const result = await deps.callGemini({ apiKey, prompt })
  if (!result.ok || !result.text) return { id: cardId, reviewed: false, reason: result.reason ?? 'no_response' }

  const verdict = parseReviewResponse(result.text)
  if (!verdict) return { id: cardId, reviewed: false, reason: 'invalid_response_schema' }

  try {
    deps.postComment(cardId, REVIEW_AUTHOR, formatReviewComment(verdict))
  } catch (err) {
    return { id: cardId, reviewed: false, reason: `post_failed: ${String(err)}` }
  }
  return { id: cardId, reviewed: true }
}

export interface DraftReviewSweepSummary {
  ran: boolean
  reason?: string
  results?: DraftReviewResult[]
}

/**
 * I/O wrapper (mirrors runGeminiOrchestratorSweep/runGeminiOrchestratorDraftSweep's shape): kill
 * switch + route gated, then reviews every card currently carrying a draft file, one at a time,
 * in no particular order (unlike 1/4's order queue -- a first-pass opinion has no sequencing
 * requirement, it only needs to eventually happen for every eligible card). A single card's
 * failure never stops the sweep.
 */
export async function runGeminiOrchestratorDraftReviewSweep(
  listCardIds: () => string[] = listDraftCardIds,
  callGemini: (opts: GeminiCallOptions) => Promise<GeminiResult> = geminiGenerate,
): Promise<DraftReviewSweepSummary> {
  if (!isGeminiOrchestratorEnabled()) {
    console.log('[gemini-orchestrator-draft-review] kill switch is OFF -- no-op.')
    return { ran: false, reason: 'kill_switch_off' }
  }
  if (readFallbackRoute() !== 'gemini') {
    console.log('[gemini-orchestrator-draft-review] route is not gemini -- no-op.')
    return { ran: false, reason: 'not_gemini_route' }
  }

  const apiKey = getSecret(GEMINI_VAULT_KEY_ID) ?? null
  const deps = {
    readCard: (id: string) => getKanbanCard(id),
    readComments: (id: string) => getKanbanComments(id) as unknown as Comment[],
    readLabels: (id: string) => getLabelsForCard(id),
    readDraft: (absPath: string) => readFileSync(absPath, 'utf-8'),
    postComment: (id: string, author: string, content: string) => addKanbanComment(id, author, content),
    callGemini,
  }

  const results: DraftReviewResult[] = []
  for (const id of listCardIds()) {
    results.push(await reviewOneCard(id, apiKey, deps))
  }
  const reviewedCount = results.filter((r) => r.reviewed).length
  console.log(`[gemini-orchestrator-draft-review] checked ${results.length} card(s), ${reviewedCount} reviewed.`)
  return { ran: true, results }
}

/** Entry-point body, extracted (mirrors the sibling modules) so it is directly testable without
 *  the module-load-time process.argv guard below ever firing in a test. */
export function runAsEntryPoint(): void {
  runGeminiOrchestratorDraftReviewSweep()
    .then(() => process.exit(0))
    .catch((err) => { console.error('[gemini-orchestrator-draft-review] Fatal:', err); process.exit(1) })
}

// Entry point when run directly: node dist/gemini-orchestrator-draft-review.js
if (process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^.*[/\\]/, '/'))) {
  runAsEntryPoint()
}
