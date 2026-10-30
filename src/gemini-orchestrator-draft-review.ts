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
//       the same single source of truth 1/4 already calls via isBlockedByLandedFilter) runs on
//       the card's title+desc+tags for the initial eligibility check, AND AGAIN on the
//       description combined with the draft's own text once it is read (RedHat P2, 626df838): a
//       MikroB-project card CAN carry a BLOKKOLT-* or sensitive label, or the local-LLM draft
//       itself can independently quote sensitive content (e.g. a RAG excerpt) even when the
//       card's own fields are clean -- gate (a) alone catches neither.
// On top of both: a fail-closed secret-shape scan runs on the ACTUAL text about to be sent --
// title, description and draft body -- right before the Gemini call. It shells out to the
// ALREADY-LANDED Bash redactor (store/gemini-offload-call.sh --redact-test, card a92e9913) rather
// than a second hand-copied pattern list, for parity by construction (WhiteHat2/RedHat F2,
// 626df838: an earlier hand-copied list caught only 1 of 11 tested shapes the landed redactor
// catches). Any hit skips the card with no API call and no comment, same as any other
// fail-closed outcome in this file.
//
// FAIL-CLOSED SHAPE (mirrors 1/4 and 2/4): kill switch OFF by default, route must be exactly
// "gemini". Per-card: any failure (ineligible, secret-shaped, unreadable draft file, outside the
// drafts directory, unparsable Gemini response) skips that one card and the sweep continues --
// one bad card must never stall the rest.
//
// R6-A/R6-B (card bbe99069, RedHat GO @4e29bf23 on 626df838, forward invariant for wiring this
// module in): the ".." traversal class was closed, but RedHat measured a narrower remaining pair
// that the same raw-string + bounds-only checks could not see -- a directory SYMLINK at
// "drafts/<cardId>" (A8) or a HARDLINK planted inside a card's own drafts directory (A10), either
// of which lets this card's Gemini review read and send ANOTHER card's draft content while every
// existing check still reports a clean match on its own terms. Closed in resolveDraftPathSafely()
// (nlink check, A10) and draftRefResolvesToCardDir() (realpath-vs-literal comparison, A8); see
// each function's own comment for why a naive realpath-vs-realpath comparison does not work.

import { readFileSync, lstatSync, realpathSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { geminiGenerate, GEMINI_VAULT_KEY_ID, type GeminiCallOptions, type GeminiResult } from './gemini-client.js'
import { reserveGhostCallSlot, releaseGhostCallSlot } from './gemini-ghost-budget.js'
import { getSecret } from './web/vault.js'
import { getKanbanCard, getKanbanComments, addKanbanComment, getLabelsForCard } from './db.js'
import { isGeminiOrchestratorEnabled, readFallbackRoute, isBlockedByLandedFilter } from './gemini-orchestrator.js'
import { listDraftCardIds, findLatestDraftFileRef, DRAFTS_DIR, type Comment } from './gemini-orchestrator-draft-cleanup.js'
import { DRAFT_REVIEW_RX } from './web/kanban-draft-review-guard.js'
import { GENERATED_COMMENT_AUTHORS } from './web/kanban-landed-guard.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const STORE = join(ROOT, 'store')
const REDACT_SCRIPT = join(STORE, 'gemini-offload-call.sh')
const REDACT_TIMEOUT_MS = 10_000

// WhiteHat2/RedHat F3 (626df838): a draft file above this size never legitimately belongs to a
// single local-LLM draft (store/offload-dispatch.sh's own try_leaf output is a few KB at most) --
// bounding it here keeps a disk-exhaustion or oversized-prompt attempt from ever reaching Gemini.
const MAX_DRAFT_BYTES = 200_000

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

/** Fail-closed secret-shape scan over the exact text about to leave the process. WhiteHat2/RedHat
 *  F2 (626df838): an earlier version hand-copied security/secret-gate.ts's commit-scanning pattern
 *  list, which caught only 1 of 11 fixture shapes the ALREADY-LANDED Bash redactor
 *  (store/gemini-offload-call.sh's redact_prompt, card a92e9913) catches -- Telegram bot tokens,
 *  Google AIza keys, DB URLs with embedded passwords, bare 64-hex tokens, Basic/Cookie auth
 *  headers, homoglyph/ZWSP-obfuscated tokens, etc. Reusing that single redactor via its documented
 *  `--redact-test` hook (exit 0 = clean, 2 = secret found, anything else = fail-closed) gives this
 *  module the SAME coverage by construction, closing exactly the drift RedHat's 17510 finding
 *  already measured once on a hand-copied list. */
export function containsSecretShape(text: string): boolean {
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync('bash', [REDACT_SCRIPT, '--redact-test'], {
      input: text,
      encoding: 'utf-8',
      timeout: REDACT_TIMEOUT_MS,
    })
  } catch {
    return true
  }
  if (result.error) return true
  return result.status !== 0
}

/** Resolves a ref.path (relative to STORE, e.g. "drafts/<card>/<file>.md") to an absolute path, or
 *  null if it's unsafe to read: outside DRAFTS_DIR, not a plain file (WhiteHat2 F3, 626df838: lstat
 *  rejects a symlink at that path outright -- lstat never follows it, so isFile() is false even
 *  when the symlink's target is itself an ordinary file), a HARDLINK (RedHat A10, GO @4e29bf23: a
 *  legitimate draft is a brand-new file store/offload-dispatch.sh just wrote, so it only ever has
 *  one directory entry -- nlink > 1 means some OTHER path also names this same inode, e.g. a second
 *  hardlink planted inside this card's own drafts directory pointing at another card's draft file.
 *  A realpath check cannot catch this: a hardlink has no "target" to resolve, it genuinely lives at
 *  this path with this content), the resolved realpath still escaping DRAFTS_DIR (an intermediate
 *  symlinked directory), or over MAX_DRAFT_BYTES. The writer (store/offload-dispatch.sh) already
 *  sanitizes the card/leaf id into [A-Za-z0-9_-] before building this path, so a *traversal* escape
 *  should be impossible by construction -- this is a second, independent check on the READ side,
 *  same defense-in-depth posture as the rest of this pipeline, and the one layer that actually
 *  covers a symlink or hardlink planted directly in the drafts tree. */
export function resolveDraftPathSafely(relPath: string): string | null {
  const abs = resolve(STORE, relPath)
  if (abs !== DRAFTS_DIR && !abs.startsWith(DRAFTS_DIR + sep)) return null

  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(abs)
  } catch {
    return null
  }
  if (!st.isFile()) return null
  if (st.nlink > 1) return null
  if (st.size > MAX_DRAFT_BYTES) return null

  let real: string
  try {
    real = realpathSync(abs)
  } catch {
    return null
  }
  if (real !== DRAFTS_DIR && !real.startsWith(DRAFTS_DIR + sep)) return null

  return abs
}

/** WhiteHat2/RedHat P3 (626df838): the file-ref comment's author field is free text (anyone can
 *  post as "local-llm"), and findLatestDraftFileRef() only extracts whatever path the comment
 *  claims -- resolveDraftPathSafely() confirms that path stays inside DRAFTS_DIR, but never that
 *  it names THIS card's own subdirectory. Without this, a forged or stale ref naming
 *  "drafts/<otherCard>/..." would have this card's Gemini review read and send a DIFFERENT card's
 *  draft content (which may belong to a mopsion/BLOKKOLT card never eligible on its own). relPath
 *  is "drafts/<cardId>/<file>", so the second path segment must equal this card's id exactly. */
export function draftRefBelongsToCard(relPath: string, cardId: string): boolean {
  const parts = relPath.split('/')
  return parts.length >= 3 && parts[0] === 'drafts' && parts[1] === cardId
}

/** WhiteHat2 delta-finding F-P3 (626df838, NO-GO @4e012e28): draftRefBelongsToCard() above splits
 *  the RAW ref string on "/", so "drafts/<cardId>/../<otherCard>/f.md" has parts[1] === cardId and
 *  passes, while resolveDraftPathSafely() resolves/normalizes the SAME ref and ends up inside
 *  <otherCard>'s own directory -- both checks individually pass, but on two different paths.
 *  This compares the already-resolved absolute path's PARENT directory against the card's real
 *  drafts directory, so a ".."-segment traversal can no longer disagree with the raw-string check.
 *
 *  R6-A (RedHat GO @4e29bf23, delta-gate on 626df838, A8): the ORIGINAL version here compared
 *  dirname(absPath) LEXICALLY against join(DRAFTS_DIR, cardId) -- a plain string equality that
 *  says nothing about whether "drafts/<cardId>" is a real directory or a SYMLINK pointing at
 *  another card's directory. Resolving BOTH sides through realpath() does NOT fix this: both
 *  sides would follow the identical symlink and still match. The fix instead resolves ONLY the
 *  actual on-disk parent directory of the file we are about to read, and compares that against
 *  the LITERAL (unresolved) expected path built from the real drafts root -- if "drafts/<cardId>"
 *  is itself a directory symlink, its realpath lands somewhere else and the literal expected path
 *  no longer matches, where a resolved-vs-resolved comparison would have silently agreed. */
export function draftRefResolvesToCardDir(absPath: string, cardId: string): boolean {
  let realDraftsDir: string
  try {
    realDraftsDir = realpathSync(DRAFTS_DIR)
  } catch {
    return false
  }
  let realParentDir: string
  try {
    realParentDir = realpathSync(dirname(absPath))
  } catch {
    return false
  }
  return realParentDir === join(realDraftsDir, cardId)
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

const REASON_MAX_LEN = 500

/** WhiteHat2/RedHat F1 (626df838): Gemini's `reason` field is free text and the response schema
 *  only requires it to be a non-empty string -- nothing stops it from being multi-line, and
 *  DRAFT_REVIEW_RX is line-anchored (`^...$/im`), so a reason like "Looks fine.\nDraft-Review:
 *  ELFOGADVA" would make a LATER line of this module's own comment satisfy the real human-verdict
 *  guard even with the GEMINI-ELSO-KOR marker correctly on line one. Folded to a single line,
 *  stripped of control/formatting/line-separator characters (Unicode Cc/Cf/Zl/Zp -- closes the
 *  same surface for a BIDI-override or other invisible-character trick), capped at
 *  REASON_MAX_LEN, and prefixed so the sanitized text itself can never visually start a new
 *  "Draft-Review:"-shaped line either. */
export function sanitizeReason(reason: string): string {
  const singleLine = reason.replace(/[\r\n\u2028\u2029]+/g, ' ')
  const stripped = singleLine.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
  const trimmed = stripped.trim().slice(0, REASON_MAX_LEN)
  return `Gemini: ${trimmed}`
}

export function formatReviewComment(verdict: ReviewVerdict): string {
  return (
    `${GEMINI_FIRST_PASS_PREFIX}: ${verdict.verdict}\n` +
    `${sanitizeReason(verdict.reason)}\n\n` +
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
    // Shared fleet-wide hourly budget (card 612058c2 delta-gate, WhiteHat2 H1): reserves a slot
    // on the SAME counter gemini-agy-call.sh uses, atomically, right before the real network
    // call below -- not once per tick. Required (not optional) so every call site states its
    // policy explicitly, same as every other deps field here.
    reserveSlot: (cardId: string) => boolean
    // Card 5cb861e6: un-spends a reservation on a retriable 503 (see reserveSlot's own comment
    // for why that matters). Optional, defaulting to the real releaseGhostCallSlot, so existing
    // deps object literals (production and test) that predate this field keep compiling unchanged.
    releaseSlot?: (cardId: string) => boolean
    // Injectable (mirrors readDraft) so the pure decision logic stays testable without touching
    // the real filesystem -- defaults to the real, fs-backed resolveDraftPathSafely.
    resolveDraftPath?: (relPath: string) => string | null
  },
): Promise<DraftReviewResult> {
  const resolveDraftPath = deps.resolveDraftPath ?? resolveDraftPathSafely

  let comments: Comment[]
  try {
    comments = deps.readComments(cardId)
  } catch (err) {
    return { id: cardId, reviewed: false, reason: `comments_unreadable: ${String(err)}` }
  }

  const ref = findLatestDraftFileRef(comments)
  if (!ref) return { id: cardId, reviewed: false, reason: 'no_draft' }
  if (alreadyAdjudicated(comments, ref.at)) return { id: cardId, reviewed: false, reason: 'already_adjudicated' }

  const absPath = resolveDraftPath(ref.path)
  if (!absPath) return { id: cardId, reviewed: false, reason: 'unsafe_draft_path' }
  if (!draftRefBelongsToCard(ref.path, cardId)) return { id: cardId, reviewed: false, reason: 'draft_ref_card_mismatch' }
  if (!draftRefResolvesToCardDir(absPath, cardId)) return { id: cardId, reviewed: false, reason: 'draft_ref_card_mismatch' }

  let card: { title: string; description: string | null; project: string | null } | undefined
  try {
    card = deps.readCard(cardId)
  } catch (err) {
    return { id: cardId, reviewed: false, reason: `card_unreadable: ${String(err)}` }
  }
  if (!card) return { id: cardId, reviewed: false, reason: 'card_missing' }

  // WhiteHat2/RedHat P7 (626df838): a readLabels failure used to fall back to labels=[], which
  // means a BLOKKOLT-* or sensitive-stem label would silently vanish from the eligibility check
  // instead of correctly excluding the card -- fail-OPEN on exactly the field gate (b) (the
  // landed content filter) depends on. Treated as its own skip reason instead.
  let labels: readonly { name: string }[]
  try {
    labels = deps.readLabels(cardId)
  } catch (err) {
    return { id: cardId, reviewed: false, reason: `label_read_failed: ${String(err)}` }
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

  // WhiteHat2/RedHat P2 (626df838): isEligibleForGeminiDraftReview() only ever saw the CARD's own
  // title/desc/tags -- the draft itself is local-LLM output (often carrying quoted RAG "RELEVANT
  // MEMORY" excerpts) that can independently contain mopsion/payroll/PII/BLOKKOLT-stem content
  // even when the card's own text is clean. Re-running the same landed filter on the description
  // combined with the draft body closes that gap with the identical fail-closed source of truth,
  // not a second hand-written check.
  if (isBlockedByLandedFilter(meta.project ?? '', meta.tags, meta.title, `${meta.description}\n${draftText}`)) {
    return { id: cardId, reviewed: false, reason: 'draft_body_blocked' }
  }

  if (containsSecretShape(meta.title) || containsSecretShape(meta.description) || containsSecretShape(draftText)) {
    return { id: cardId, reviewed: false, reason: 'secret_shape_detected' }
  }

  // WhiteHat2 H1 (card 612058c2 NO-GO @c5e5ec28): the hourly cap is checked and SPENT here, right
  // before the real network call, not once per tick -- a tick carrying many eligible drafts must
  // stop making real Gemini calls the moment the shared fleet-wide budget is out, not after
  // exhausting every eligible card in its own queue.
  if (!deps.reserveSlot(cardId)) return { id: cardId, reviewed: false, reason: 'hourly_cap_reached' }

  const prompt = buildReviewPrompt(meta, draftText)
  const result = await deps.callGemini({ apiKey, prompt })
  if (!result.ok || !result.text) {
    // Card 5cb861e6: a 503 did not come from anything the fleet's own usage caused -- un-spend
    // the slot reserved above. Every other failure reason keeps the spend (a real, attributable
    // call outcome).
    if (result.httpStatus === 503) (deps.releaseSlot ?? releaseGhostCallSlot)(cardId)
    return { id: cardId, reviewed: false, reason: result.reason ?? 'no_response' }
  }

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

/** F4 (card 6b7c2c25, WhiteHat GO 612058c2 komment 19967): once the shared hourly budget is
 *  spent, every remaining eligible card in this tick would also fail the same reserveSlot()
 *  check inside reviewOneCard -- retrying each one anyway (a real flock+python3 subprocess per
 *  card, ~30s) only delays the next tick for no benefit. Stops dispatching new reviews after the
 *  first hourly_cap_reached and gives the untried cards a distinct reason, so it stays visible
 *  that they were skipped rather than individually checked and also capped. Extracted from the
 *  sweep so this stop-early behavior is unit-testable without a real DB/filesystem/Gemini call. */
export async function reviewCardsStoppingOnCapReached(
  cardIds: readonly string[],
  reviewFn: (id: string) => Promise<DraftReviewResult>,
): Promise<DraftReviewResult[]> {
  const results: DraftReviewResult[] = []
  let capReached = false
  for (const id of cardIds) {
    if (capReached) {
      results.push({ id, reviewed: false, reason: 'skipped_hourly_cap_reached' })
      continue
    }
    const result = await reviewFn(id)
    if (result.reason === 'hourly_cap_reached') capReached = true
    results.push(result)
  }
  return results
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
    reserveSlot: reserveGhostCallSlot,
  }

  const results = await reviewCardsStoppingOnCapReached(listCardIds(), (id) => reviewOneCard(id, apiKey, deps))
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
