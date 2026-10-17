// MT-05 (card c991508f): the actual capture pipeline -- REVIEW + Gate-SHA diff -> local LLM draft
// -> validator -> solution-csomópont + horgonyok + élek, run once a card's capture row is pending
// (capture.ts enqueued it when the card closed). Kept separate from capture.ts (the queue state
// layer) and from the HTTP/CLI entry points that call it, so the decision logic is a single,
// synchronously testable function with every I/O boundary injected (injected-port-adapters skill):
// no test here needs a real gate-closure-check.py subprocess or a real Ollama call.
//
// EK-MT-2/3/4 (MODULTERV section 12) are the three behaviours this function must prove:
//   EK-MT-2: done + gate AGREE -> 1..3 ACTIVE solutions, each anchored on the Gate-SHA, with
//            `produced` (card->solution) and `implemented_in` (solution->commit) edges.
//   EK-MT-3: NOSHA or DISAGREE (or any non-AGREE verdict) -> at most DRAFT solutions, never active.
//   EK-MT-4: a REVIEW carrying a known secret shape -> no node at all, queue row failed/secret.

import type Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { getKanbanCard, getKanbanComments, type KanbanComment } from '../db.js'
import {
  REVIEW_RX,
  GATE_AGENT_NAMES,
  latestReviewGateSha,
  extractGateLine,
  parseGateDesignation,
} from '../web/kanban-gate-completeness-guard.js'
import { GENERATED_COMMENT_AUTHORS } from '../web/kanban-landed-guard.js'
import { mapProjectToPartition } from './project-map.js'
import { upsertNode, upsertEdge, upsertAnchor, findSecretShape, type KgNodeInput } from './store.js'
import { markCaptureDone, markCaptureFailed, markCaptureSkipped } from './capture.js'

export type ClosureVerdictWord =
  | 'AGREE' | 'DISAGREE' | 'FAILED' | 'MISSING' | 'NOSHA' | 'STALE' | 'UNRESOLVED'
  | 'UNSUPERSEDED' | 'UNLANDED' | 'BUMPSHA' | 'UNVERIFIED-AUTHOR' | 'UNREADABLE'

export interface ClosureResult {
  readonly verdict: ClosureVerdictWord
  readonly sha: string | null
}

export interface DraftSolution {
  title: string
  body?: string
  snippet?: string
  keywords?: string
}

export interface CaptureDeps {
  /** Default: shells out to store/gate-closure-check.py (same tool MikroB's own closure sweep
   *  uses), feeding it this card's own comments on stdin -- never re-derived independently, so a
   *  future change to what "AGREE" means only has to happen in one place. */
  closureCheck: (cardId: string, comments: readonly KanbanComment[]) => ClosureResult
  /** Default: shells out to store/local-llm.sh --task kg-capture. Returns the model's raw text
   *  output (expected to be a JSON array per store/local-llm-skills/kg-capture.txt); this module
   *  parses and validates it, never trusts it as-is. */
  draftFn: (reviewText: string) => string
  now: () => number
  extractor: string
}

function commitNodeId(sha: string): string {
  return `commit:${sha}`
}

function solutionNodeId(cardId: string, index: number): string {
  return `sol:${cardId}:${index}`
}

/** The latest builder REVIEW comment -- same filter `latestReviewGateSha` applies (exclude gate
 *  verdicts and generated/draft comments), kept here as its own lookup because that function only
 *  returns the sha, not the comment this capture needs the full text of. */
function latestReviewComment(comments: readonly KanbanComment[]): KanbanComment | null {
  let best: KanbanComment | null = null
  for (const c of comments) {
    const author = (c.author ?? '').toLowerCase()
    if (GATE_AGENT_NAMES.has(author) || GENERATED_COMMENT_AUTHORS.has(author)) continue
    if (!REVIEW_RX.test(c.content ?? '')) continue
    if (!best || c.created_at >= best.created_at) best = c
  }
  return best
}

/** Parses the local-LLM draft's JSON array, validated against KG_MAX_SOLUTIONS_PER_CARD and
 *  against non-empty titles -- malformed output is a capture failure, not a best-effort guess at a
 *  single node, so a confused draft never silently ships a low-quality node. */
function parseDraft(raw: string, maxSolutions: number): DraftSolution[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  const out: DraftSolution[] = []
  for (const item of parsed.slice(0, maxSolutions)) {
    if (!item || typeof item !== 'object') return null
    const title = (item as Record<string, unknown>).title
    if (typeof title !== 'string' || !title.trim()) return null
    out.push({
      title: title.trim(),
      body: typeof (item as Record<string, unknown>).body === 'string' ? (item as Record<string, unknown>).body as string : undefined,
      snippet: typeof (item as Record<string, unknown>).snippet === 'string' ? (item as Record<string, unknown>).snippet as string : undefined,
      keywords: typeof (item as Record<string, unknown>).keywords === 'string' ? (item as Record<string, unknown>).keywords as string : undefined,
    })
  }
  return out
}

/** Reuses store/gate-closure-check.py exactly as MikroB's own closure sweep calls it (root
 *  CLAUDE.md rule 4a): the card's comments JSON on stdin, the card's OWN "Gate: ..." line (if any)
 *  as the designated-gates argument. Exit code is always 0 per the script's own contract -- the
 *  one line of stdout IS the answer. A subprocess failure (script missing, python3 missing) is
 *  UNREADABLE, never silently treated as AGREE. */
export function defaultClosureCheck(cardId: string, comments: readonly KanbanComment[]): ClosureResult {
  try {
    const card = getKanbanCard(cardId)
    const gateLine = card ? extractGateLine(card.description) : null
    const designated = gateLine ? parseGateDesignation(gateLine) : null
    const args = ['/home/neon/marveen/store/gate-closure-check.py']
    if (designated && designated.size > 0) args.push([...designated].join(','))
    const out = execFileSync('python3', args, { input: JSON.stringify(comments), encoding: 'utf8' }).trim()
    const [word, sha] = out.split('|')
    const verdict = (word ?? 'UNREADABLE') as ClosureVerdictWord
    return { verdict, sha: verdict === 'AGREE' && sha ? sha : null }
  } catch {
    return { verdict: 'UNREADABLE', sha: null }
  }
}

export function defaultDraftFn(reviewText: string): string {
  return execFileSync(
    '/home/neon/marveen/store/local-llm.sh',
    ['--task', 'kg-capture', '--caller', 'kg-capture-worker', reviewText],
    { encoding: 'utf8' },
  )
}

export function defaultDeps(): CaptureDeps {
  return {
    closureCheck: defaultClosureCheck,
    draftFn: defaultDraftFn,
    now: () => Math.floor(Date.now() / 1000),
    extractor: 'local-llm:kg-capture@v1',
  }
}

export interface CaptureRunResult {
  readonly outcome: 'captured' | 'skipped' | 'failed'
  readonly reason: string
  readonly solutionIds: readonly string[]
}

/** The MT-05 pipeline for one card. Idempotent by construction (same reasoning as
 *  import-from-relations.ts): solution node ids are deterministic (`sol:<cardId>:<index>`), so
 *  re-running capture for the same card upserts the same rows rather than duplicating them. */
export function runCapture(
  mainDb: Database.Database,
  kgDb: Database.Database,
  cardId: string,
  maxSolutions: number,
  deps: CaptureDeps,
): CaptureRunResult {
  const now = deps.now()
  const card = getKanbanCard(cardId)
  if (!card) {
    markCaptureFailed(kgDb, cardId, 'card not found', now)
    return { outcome: 'failed', reason: 'card not found', solutionIds: [] }
  }
  const comments = getKanbanComments(cardId)
  const review = latestReviewComment(comments)
  if (!review) {
    markCaptureSkipped(kgDb, cardId, 'no REVIEW comment to capture from', now)
    return { outcome: 'skipped', reason: 'no REVIEW comment', solutionIds: [] }
  }

  const project = mapProjectToPartition(card.project)
  const cardNodeId = `card:${cardId}`

  // EK-MT-4: a secret shape anywhere in the REVIEW text must produce NO node at all. Reuses
  // store.ts's own `findSecretShape` (which reuses src/security/secret-gate.ts) -- the exact same
  // detector upsertNode itself enforces on every write, so there is still only one place that
  // defines "what a secret shape looks like" even though this check runs before any write.
  const secretHit = findSecretShape(review.content)
  if (secretHit) {
    markCaptureFailed(kgDb, cardId, `secret shape in REVIEW: matches pattern '${secretHit}'`, now)
    return { outcome: 'failed', reason: 'secret', solutionIds: [] }
  }

  const closure = deps.closureCheck(cardId, comments)
  const allowedActive = closure.verdict === 'AGREE'
  const gateSha = allowedActive ? closure.sha : (latestReviewGateSha(comments) ?? null)

  const raw = deps.draftFn(review.content)
  const drafts = parseDraft(raw, maxSolutions)
  if (!drafts) {
    markCaptureFailed(kgDb, cardId, 'draft did not parse as a valid solution array', now)
    return { outcome: 'failed', reason: 'draft_parse_error', solutionIds: [] }
  }

  if (!kgDb.prepare('SELECT 1 FROM kg_nodes WHERE id = ?').get(cardNodeId)) {
    upsertNode(kgDb, {
      id: cardNodeId,
      type: 'card',
      project,
      title: card.title,
      source_ref: `kanban_cards:${cardId}`,
      extractor: 'kg-capture:card-ref',
    })
  }

  const solutionIds: string[] = []
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i]!
    const id = solutionNodeId(cardId, i)
    const input: KgNodeInput = {
      id,
      type: 'solution',
      project,
      title: d.title,
      body: d.body ?? null,
      snippet: d.snippet ?? null,
      keywords: d.keywords ?? null,
      // EK-MT-3: never active unless the gate AGREE'd on THIS sha.
      status: allowedActive ? 'active' : 'draft',
      source_ref: `kanban_comments:${review.id}`,
      gate_sha: gateSha ?? null,
      extractor: deps.extractor,
    }
    upsertNode(kgDb, input)
    solutionIds.push(id)

    upsertEdge(kgDb, { src: cardNodeId, dst: id, rel: 'produced', source: 'kg-capture' })

    // EK-MT-2: at least one anchor on the Gate-SHA -- only possible when a sha exists at all.
    if (gateSha) {
      const commitId = commitNodeId(gateSha)
      if (!kgDb.prepare('SELECT 1 FROM kg_nodes WHERE id = ?').get(commitId)) {
        upsertNode(kgDb, {
          id: commitId,
          type: 'commit',
          project,
          title: gateSha,
          source_ref: `git:${gateSha}`,
          extractor: 'kg-capture:commit-ref',
        })
      }
      upsertEdge(kgDb, { src: id, dst: commitId, rel: 'implemented_in', source: 'kg-capture' })
      upsertAnchor(kgDb, {
        node_id: id,
        repo: 'marveen',
        path: `kanban_comments:${review.id}`,
        sha: gateSha,
        state: 'fresh',
      })
    }
  }

  markCaptureDone(kgDb, cardId, now)
  return { outcome: 'captured', reason: closure.verdict, solutionIds }
}
