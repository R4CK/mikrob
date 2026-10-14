// Gemini orchestrator draft cleanup (card b8da509b, slice 4/4 of cf757409).
//
// DECISION B (parent cf757409, Peti 11162/11164): a Gemini-orch draft never lands as comment
// text -- it goes to disk under store/drafts/<cardId>/, and the card gets only a short
// referencing comment (store/offload-dispatch.sh's draft_file_ref_comment_body(), posted by
// 2/4's gemini-orchestrator-draft.ts via OFFLOAD_DRAFT_SINK=file). Peti's own words: "A kvóta
// visszatérésekor, a draftokat ellenőrzik az ügynökök és a draft/temp adatokat törlik azután,
// hogy fel tudták-e használni az elkészült draftot." Two things already exist and are NOT
// rebuilt here: the Draft-Review marker vocabulary and its handoff-blocking guard
// (kanban-draft-review-guard.ts, card 1338e68b) -- reused directly, not re-implemented, so the
// two can never drift apart. What is new: once a Gemini-orch draft file HAS a Draft-Review
// verdict on the card, delete the on-disk draft file for that card and leave a one-line trace
// comment (kanban comments stay forever per decision B; only the file disappears).
//
// WHY A DIRECTORY-LEVEL DELETE, NOT A SINGLE-FILE DELETE: write_draft_to_file() can leave more
// than one file per card (retries before a draft that was actually reviewed). Once a verdict
// has been given, nothing on disk for that card is still "pending adjudication" -- the simplest
// correct cleanup is the whole store/drafts/<cardId>/ directory, not per-file bookkeeping.
//
// WHY FAIL-OPEN ON A DELETE/POST ERROR: this is best-effort housekeeping, not a safety gate --
// an unreadable directory or a transient API error must skip that one card and continue with
// the rest, never crash the sweep (mirrors runGeminiOrchestratorDraftSweep's per-card isolation
// in gemini-orchestrator-draft.ts).

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getKanbanComments, addKanbanComment } from './db.js'
import { DRAFT_REVIEW_RX } from './web/kanban-draft-review-guard.js'
import { GENERATED_COMMENT_AUTHORS } from './web/kanban-landed-guard.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const STORE = join(ROOT, 'store')
const DRAFTS_DIR = join(STORE, 'drafts')

const DRAFT_AUTHOR = 'local-llm'
const CLEANUP_AUTHOR = 'gemini-orch-cleanup'

// Matches the literal text draft_file_ref_comment_body() (store/offload-dispatch.sh) prints
// around the relative path -- anchored on both fixed phrases so the path itself (which may
// contain dots, e.g. "<ts>-<leaf>.md") is captured in full, not truncated at its own first dot.
const DRAFT_FILE_REF_RX = /a draft fajlban marad: (.+?)\. DRAFT-ONLY:/

export interface Comment {
  readonly author: string
  readonly content: string
  readonly created_at: number
}

/** The relative drafts-path a single Gemini-orch file-ref comment names, or null if it isn't one. */
export function extractDraftRefPath(content: string): string | null {
  const m = DRAFT_FILE_REF_RX.exec(content ?? '')
  return m ? m[1] : null
}

export interface DraftFileRef {
  readonly path: string
  readonly at: number
}

/** The NEWEST Gemini-orch file-ref comment on the card, or null if it never had one. Newest
 *  (not oldest) for the same reason kanban-draft-review-guard.ts anchors on the newest draft:
 *  a verdict is evidence only about drafts that already existed when it was written. */
export function findLatestDraftFileRef(comments: readonly Comment[]): DraftFileRef | null {
  let latest: DraftFileRef | null = null
  for (const c of comments) {
    if ((c.author ?? '').toLowerCase() !== DRAFT_AUTHOR) continue
    const path = extractDraftRefPath(c.content ?? '')
    if (!path) continue
    const at = c.created_at ?? 0
    if (!latest || at > latest.at) latest = { path, at }
  }
  return latest
}

export interface CleanupPlan {
  readonly shouldDelete: boolean
  readonly path?: string
  readonly verdict?: string
}

/** Pure decision: delete iff the card has a Gemini-orch draft file reference AND a non-generated
 *  Draft-Review verdict posted at or after it -- the EXACT freshness/authorship test
 *  kanban-draft-review-guard.ts's hasDraftReview() already enforces before a card can reach
 *  waiting, reused here rather than re-implemented so the two can never read differently. */
export function planDraftCleanup(comments: readonly Comment[]): CleanupPlan {
  const ref = findLatestDraftFileRef(comments)
  if (!ref) return { shouldDelete: false }

  const verdictComment = comments.find(
    (c) =>
      !GENERATED_COMMENT_AUTHORS.has((c.author ?? '').toLowerCase()) &&
      (c.created_at ?? 0) >= ref.at &&
      DRAFT_REVIEW_RX.test(c.content ?? '')
  )
  if (!verdictComment) return { shouldDelete: false }

  const verdictMatch = DRAFT_REVIEW_RX.exec(verdictComment.content ?? '')
  return { shouldDelete: true, path: ref.path, verdict: verdictMatch?.[1] }
}

export interface CleanupSweepSummary {
  readonly cleaned: string[]
}

/**
 * I/O wrapper: for every card id with a directory under store/drafts/, applies planDraftCleanup
 * to that card's live comments, deletes the directory and posts a one-line trace comment when
 * the plan says so. Idempotent and safe to call on every fallback-runner tick: a card already
 * cleaned by a prior sweep no longer has a directory, so listCardIds() (which reads the same
 * store/drafts/ tree) simply stops naming it -- no separate "already gone" check is needed.
 */
export function runDraftCleanupSweep(
  listCardIds: () => string[] = () =>
    existsSync(DRAFTS_DIR)
      ? readdirSync(DRAFTS_DIR, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      : [],
  getComments: (id: string) => Comment[] = (id) => getKanbanComments(id) as unknown as Comment[],
  deleteDir: (absPath: string) => void = (p) => rmSync(p, { recursive: true, force: true }),
  postComment: (id: string, author: string, content: string) => void = (id, author, content) =>
    addKanbanComment(id, author, content)
): CleanupSweepSummary {
  const cleaned: string[] = []
  for (const cardId of listCardIds()) {
    let comments: Comment[]
    try {
      comments = getComments(cardId)
    } catch (err) {
      console.warn(`[gemini-orchestrator-draft-cleanup] could not read comments for ${cardId}: ${err}`)
      continue
    }

    const plan = planDraftCleanup(comments)
    if (!plan.shouldDelete) continue

    const cardDir = join(DRAFTS_DIR, cardId)

    try {
      deleteDir(cardDir)
    } catch (err) {
      console.warn(`[gemini-orchestrator-draft-cleanup] failed to delete ${cardDir}: ${err}`)
      continue
    }

    try {
      postComment(
        cardId,
        CLEANUP_AUTHOR,
        `Draft-fajl torolve (Draft-Review: ${plan.verdict ?? '?'}) -- drafts/${cardId}/`
      )
    } catch (err) {
      console.warn(`[gemini-orchestrator-draft-cleanup] deleted but failed to post trace comment for ${cardId}: ${err}`)
    }
    cleaned.push(cardId)
  }
  if (cleaned.length > 0) {
    console.log(`[gemini-orchestrator-draft-cleanup] cleaned ${cleaned.length} card(s): ${cleaned.join(', ')}`)
  }
  return { cleaned }
}
