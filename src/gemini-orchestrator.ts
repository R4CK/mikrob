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
// DEDUP NOTE (condition 6): the full is_gemini_blocked vocabulary lives INLINE inside
// store/offload-dispatch.sh, which card c7abdf57 is actively building on right now -- extracting
// it to a shared module this session risks a collision with that in-flight work. This module
// therefore PORTS the same project-allowlist + tag-block + content-stem vocabulary rather than
// importing it live; flagged in the REVIEW as a follow-up dedup once c7abdf57 lands.

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { geminiGenerate, GEMINI_VAULT_KEY_ID, type GeminiCallOptions, type GeminiResult } from './gemini-client.js'
import { getSecret } from './web/vault.js'
import { listKanbanCards, getLabelsForAllCards } from './db.js'

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

function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

// Ported 1:1 from store/offload-dispatch.sh is_gemini_blocked's BLOCKED_TAGS set (card a92e9913).
const BLOCKED_TAG_WORDS = new Set([
  'mopsion', 'cleancore', 'sec', 'security', 'auth', 'authz', 'rbac', 'tenant', 'superadmin',
  'pii', 'penz', 'penzugy', 'finance', 'billing', 'payment', 'secret', 'crypto',
  'gdpr', 'privacy', 'legal', 'cybersec',
])

// Ported 1:1 from the same function's SENS_RE (leading-boundary-only stem match).
const SENSITIVE_STEM_RE = new RegExp(
  '\\b(biztons|security|auth|authz|rbac|tenant|superadmin' +
    '|penz|penzugy|fizet|szamla|afa|payroll|berszamfejtes|jelszo|password' +
    '|token|secret|titok|jogosult|gdpr|privacy|kulcs' +
    '|kripto|crypto|pii|billing|payment|legal|jogi|cybersec|fin' +
    '|hacker|exploit|pentest|inject|sqli|xss)',
  'i',
)

function isSensitiveText(s: string): boolean {
  return SENSITIVE_STEM_RE.test(normalize(s))
}

/**
 * Conditions 5+6: a card must never be offered to Gemini -- not even its title+labels -- if it is
 * a mopsion-project card, carries a BLOKKOLT-* label, or its title/labels match the a92e9913
 * sensitive-domain vocabulary. Mirrors is_gemini_blocked's project ALLOWLIST (only "MikroB",
 * case/accent-insensitive; empty/unknown/mopsion are all excluded, fail-closed) rather than a
 * blocklist.
 */
export function isEligibleForGeminiOrdering(card: OrchestratorCard): boolean {
  if (normalize(card.project ?? '') !== 'mikrob') return false

  for (const label of card.labels) {
    const l = normalize(label).replace(/^@/, '')
    if (l.startsWith('blokkolt')) return false
    if (BLOCKED_TAG_WORDS.has(l)) return false
    if (isSensitiveText(label)) return false
  }

  if (isSensitiveText(card.title)) return false

  return true
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

function readFallbackRoute(): 'claude' | 'gemini' {
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

// Entry point when run directly: node dist/gemini-orchestrator.js
if (process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^.*[/\\]/, '/'))) {
  runGeminiOrchestratorSweep(loadOrchestratorCardsFromDb)
    .then(() => process.exit(0))
    .catch((err) => { console.error('[gemini-orchestrator] Fatal:', err); process.exit(1) })
}
