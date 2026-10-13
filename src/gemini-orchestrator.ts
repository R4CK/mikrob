// Gemini orchestrator loop (card 23a14c4b, slice 1/4 of cf757409). Plan-grilling verdict
// (cf757409 comment 17552, MikroB) sets seven mandatory conditions this module follows:
// (1) kill switch OFF by default (store/gemini-orchestrator-enabled.json, missing/invalid -> off);
// (2) Gemini receives ONLY title+label metadata for the ordering decision, never description/code
//     (enforced by buildOrderingMetadata's payload shape, not by a text grep);
// (3) fail-closed on any error/timeout/invalid response -- no action taken, a log line only;
// (4) this module NEVER marks a card done and never writes a draft -- it only proposes an order;
// (5) mopsion-project and BLOKKOLT-* cards must never reach Gemini, not even as a title+label;
// (6) reuses the a92e9913 content-gate vocabulary (store/offload-dispatch.sh is_gemini_blocked)
//     rather than inventing a new one;
// (7) everything here sits behind the kill switch -- the pre-existing dispatch path is untouched.
//
// SCOPE: this is ONLY the sequencing decision (which planned/in_progress card Gemini thinks
// should go next when the fleet is already on the gemini route, per gemini-fallback-runner.ts's
// state). It never drafts, never reviews, never writes to a card. Drafting (2/4), Gemini review
// (3/4) and the post-reset draft-review/cleanup (4/4) are separate, later cards.
//
// CONDITION 6 / WHITEHAT F1 FIX (comment 17666, card 23a14c4b re-gate): an earlier version of this
// module PORTED the is_gemini_blocked vocabulary into TypeScript by hand. WhiteHat's NO-GO showed
// the port had already drifted from the landed filter (a92e9913) the moment it shipped -- missing
// the permission/access/szemelyes/hozzaferes stems and the non-ASCII strip, both of which the
// landed filter already covers. This module now calls the LANDED shell filter itself
// (store/offload-dispatch.sh --check-blocked, added for exactly this purpose) as the single
// source of truth, instead of keeping a second copy of the sensitive-word list that can silently
// diverge again on the next edit to either side.
//
// WHITEHAT2 F1' DELTA FIX (comment 17828/17831, same re-gate): --check-blocked now extracts the
// title-prefix "[SEC]"/"[BLOKKOLT-*]" bracket tags ITSELF (store/offload-dispatch.sh, same regex
// tags_for() uses), instead of relying on this module's caller to have already folded them into
// `tags`. isEligibleForGeminiOrdering below still only sends `card.labels` as tags -- that is now
// sufficient, because the wrapper reconstructs the title-prefix half of the tag set on its own
// side. RedHat N1/N2 in the same delta: the exit-code contract moved to the sentinel RC documented
// on isBlockedByLandedFilter below, and offload-dispatch.sh's content gate now also runs on tag
// text, not just title/desc.

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { geminiGenerate, GEMINI_VAULT_KEY_ID, type GeminiCallOptions, type GeminiResult } from './gemini-client.js'
import { getSecret } from './web/vault.js'
import { initDatabase, listKanbanCards, getLabelsForAllCards } from './db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const STORE = join(ROOT, 'store')

const KILL_SWITCH_PATH = join(STORE, 'gemini-orchestrator-enabled.json')
const QUEUE_PATH = join(STORE, 'gemini-orchestrator-queue.json')
const FALLBACK_STATE_PATH = join(STORE, 'gemini-fallback-state.json')

/** Condition 1: default OFF. A missing file, invalid JSON, or anything but a literal `true` all
 *  read as disabled -- the safe direction for a kill switch is always "off". */
export function isGeminiOrchestratorEnabled(): boolean {
  try {
    const raw = JSON.parse(readFileSync(KILL_SWITCH_PATH, 'utf-8')) as Record<string, unknown>
    return raw.enabled === true
  } catch {
    return false
  }
}

export interface OrchestratorCard {
  id: string
  title: string
  labels: string[]
  project: string | null
  status: 'planned' | 'in_progress'
}

/** The ONLY shape that may ever reach Gemini (condition 2) -- no description, no project, no status. */
export interface OrchestratorCardMeta {
  id: string
  title: string
  labels: string[]
}

const OFFLOAD_DISPATCH_SCRIPT = join(STORE, 'offload-dispatch.sh')

/** Only this exact exit code means a deliberate, completed "allowed" verdict (N1 below). */
const CHECK_BLOCKED_ALLOWED_RC = 42
/** Fail-closed ceiling on the subprocess itself (N4, RedHat 17825): an unbounded spawnSync could
 *  hang the whole sweep forever on a wedged bash/python; a timeout turns that into a (fail-closed)
 *  blocked verdict instead, same as any other abnormal exit below. */
const CHECK_BLOCKED_TIMEOUT_MS = 10_000

/**
 * Calls the landed, already-gated is_gemini_blocked (card a92e9913, store/offload-dispatch.sh) via
 * its --check-blocked entry point, instead of keeping a second copy of its vocabulary.
 *
 * N1 (RedHat 17825/17831): checks for the EXACT sentinel exit code 42, not "anything other than
 * blocked's 0". A plain `status !== 1` reading (the previous shape here) collapses the moment the
 * wrapper's own exit code collides with bash's generic failure code -- which is also 1 -- so a
 * stray BASH_ENV, an unset-variable trip, or any other accidental shell failure on the far side
 * would read as "allowed". The wrapper itself now emits 42 for a deliberate allow and 0 for every
 * other outcome (blocked, or any failure at all) -- this function fails CLOSED (treated as
 * blocked) on anything that is not exactly 42: a missing interpreter, a crashed subprocess, a
 * killed-by-signal or timed-out run (status null) -- because "could not confirm this is safe"
 * must never be read as "safe".
 */
function isBlockedByLandedFilter(project: string, tags: string, title: string, desc: string): boolean {
  const result = spawnSync('bash', [OFFLOAD_DISPATCH_SCRIPT, '--check-blocked', project, tags, title, desc], {
    encoding: 'utf-8',
    timeout: CHECK_BLOCKED_TIMEOUT_MS,
  })
  return result.status !== CHECK_BLOCKED_ALLOWED_RC
}

/**
 * Conditions 5+6: a card must never be offered to Gemini -- not even its title+labels -- if the
 * landed filter (a92e9913) would block it: mopsion/unknown project, a BLOKKOLT-* or sensitive-
 * domain label, or a sensitive-domain title. The "@agent" label prefix is stripped before joining,
 * matching offload-dispatch.sh's own tags_for() input shaping; the actual classification
 * (normalization, stems, project allowlist) all happens inside the landed filter itself.
 */
export function isEligibleForGeminiOrdering(card: OrchestratorCard): boolean {
  const tags = card.labels.map((l) => l.replace(/^@/, '')).join(',')
  return !isBlockedByLandedFilter(card.project ?? '', tags, card.title, '')
}

/** Condition 2, enforced structurally: strips every card down to id+title+labels. */
export function buildOrderingMetadata(cards: readonly OrchestratorCard[]): OrchestratorCardMeta[] {
  return cards.map((c) => ({ id: c.id, title: c.title, labels: [...c.labels] }))
}

export function buildOrderingPrompt(metadata: readonly OrchestratorCardMeta[]): string {
  return [
    'You are ordering a backlog of software tasks by priority. You are given ONLY each task\'s',
    'id, title and labels below -- you do not have, and must not assume, any other information',
    '(no description, no code, no comments).',
    '',
    'Return STRICT JSON ONLY: an array of the "id" strings below, ordered from the one that',
    'should be worked on next to the one that should be worked on last. Include every id exactly',
    'once, no duplicates, no additions. No prose, no markdown fences, just the JSON array.',
    '',
    JSON.stringify(metadata),
  ].join('\n')
}

/**
 * Fail-closed response parser (condition 3): anything that is not EXACTLY a JSON array containing
 * every valid id exactly once returns null -- a partial list, an unknown id, a duplicate, a
 * non-array, or unparsable text are all treated the same as a hard failure, never as "do the best
 * we can with what we got".
 */
export function parseOrderingResponse(text: string, validIds: readonly string[]): string[] | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null

  const validSet = new Set(validIds)
  const seen = new Set<string>()
  const order: string[] = []
  for (const item of parsed) {
    if (typeof item !== 'string' || !validSet.has(item) || seen.has(item)) return null
    seen.add(item)
    order.push(item)
  }
  if (order.length !== validIds.length) return null

  return order
}

export interface OrchestratorDecision {
  ok: boolean
  order?: string[]
  reason?: string
}

/**
 * Pure(ish) decision: given the candidate cards and an injectable Gemini caller, either returns a
 * validated order or a fail-closed reason. Never throws (condition 3): any error from the Gemini
 * call is already caught inside geminiGenerate and returned as `{ ok: false, reason }`.
 */
export async function decideGeminiOrder(
  cards: readonly OrchestratorCard[],
  apiKey: string | null,
  callGemini: (opts: GeminiCallOptions) => Promise<GeminiResult> = geminiGenerate,
): Promise<OrchestratorDecision> {
  const eligible = cards.filter(
    (c) => (c.status === 'planned' || c.status === 'in_progress') && isEligibleForGeminiOrdering(c),
  )
  if (eligible.length === 0) return { ok: false, reason: 'no_eligible_cards' }

  const metadata = buildOrderingMetadata(eligible)
  const prompt = buildOrderingPrompt(metadata)

  const result = await callGemini({ apiKey, prompt })
  if (!result.ok || !result.text) {
    return { ok: false, reason: result.reason ?? 'no_response' }
  }

  const order = parseOrderingResponse(result.text, eligible.map((c) => c.id))
  if (!order) return { ok: false, reason: 'invalid_response_schema' }

  return { ok: true, order }
}

// Exported (card 21fbc293, Gemini-orch 2/4): the draft-driving loop needs the same route check
// before it spends a local-LLM call on anything -- re-exporting the existing single source of
// truth instead of a second copy that could drift (the exact anti-pattern WhiteHat's F1 finding
// on this file's own is_gemini_blocked port already demonstrated once).
export function readFallbackRoute(): 'claude' | 'gemini' {
  try {
    const raw = JSON.parse(readFileSync(FALLBACK_STATE_PATH, 'utf-8')) as Record<string, unknown>
    return raw.route === 'gemini' ? 'gemini' : 'claude'
  } catch {
    return 'claude'
  }
}

/**
 * I/O wrapper (conditions 1, 3, 4, 7): checks the kill switch and the current fallback route
 * before doing anything, calls the pure decision above, and on success ONLY writes a proposed
 * order to a queue file -- it never touches a kanban card, never closes anything. On any
 * fail-closed outcome it writes nothing and leaves whatever queue file already exists untouched
 * (a failed run must never look like a stale success, nor erase a still-valid prior one).
 */
export async function runGeminiOrchestratorSweep(
  loadCards: () => readonly OrchestratorCard[],
  callGemini: (opts: GeminiCallOptions) => Promise<GeminiResult> = geminiGenerate,
): Promise<void> {
  if (!isGeminiOrchestratorEnabled()) {
    console.log('[gemini-orchestrator] kill switch is OFF -- no-op.')
    return
  }
  if (readFallbackRoute() !== 'gemini') {
    console.log('[gemini-orchestrator] route is not gemini -- no-op.')
    return
  }

  const apiKey = getSecret(GEMINI_VAULT_KEY_ID) ?? null
  const cards = loadCards()
  const decision = await decideGeminiOrder(cards, apiKey, callGemini)

  if (!decision.ok) {
    console.log(`[gemini-orchestrator] fail-closed, no action (reason=${decision.reason ?? 'unknown'}).`)
    return
  }

  writeFileSync(
    QUEUE_PATH,
    JSON.stringify({ order: decision.order, decidedAt: Date.now() }, null, 2) + '\n',
    { mode: 0o600 },
  )
  console.log(`[gemini-orchestrator] wrote proposed order for ${decision.order!.length} card(s).`)
}

/** Production card source: planned/in_progress cards from the live DB, title+labels+project only. */
export function loadOrchestratorCardsFromDb(): OrchestratorCard[] {
  const labelsByCard = getLabelsForAllCards()
  return listKanbanCards()
    .filter((c): c is typeof c & { status: 'planned' | 'in_progress' } => c.status === 'planned' || c.status === 'in_progress')
    .map((c) => ({
      id: c.id,
      title: c.title,
      labels: (labelsByCard.get(c.id) ?? []).map((l) => l.name),
      project: c.project,
      status: c.status,
    }))
}

/**
 * Entry-point body, extracted (RedHat N3, comment 17825) so F2 (initDatabase before the DB read)
 * is directly testable -- the guard below is gated on `process.argv[1]` at module-load time, so
 * a test that merely imports this module can never reach it, and removing initDatabase() here
 * stayed GREEN on every existing test for exactly that reason.
 */
export function runAsEntryPoint(): void {
  initDatabase()
  runGeminiOrchestratorSweep(loadOrchestratorCardsFromDb)
    .then(() => process.exit(0))
    .catch((err) => { console.error('[gemini-orchestrator] Fatal:', err); process.exit(1) })
}

// Entry point when run directly: node dist/gemini-orchestrator.js
if (process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^.*[/\\]/, '/'))) {
  runAsEntryPoint()
}
