// LLM-generated capability summaries for LOCAL agents -- the substance of the
// routing catalog (the owner explicitly rejected one-line keyword blurbs as a
// routing basis). A few sentences per agent, generated from the agent's
// ROLE-SPECIFIC persona head + its skills, cached in
// store/capability-summaries.json and regenerated only when the sources
// change. No LLM call ever runs in an HTTP request path -- the background
// runner (startCapabilitySummaryRunner) does the work, at most a couple of
// generations per tick, serialized through the shared agent worker.
//
// PRIVACY MODEL (adversarially reviewed):
//   - Generation INPUT is minimized: displayName + model + the CLAUDE.md
//     content BEFORE the '## Memoria rendszer' heading (everything from that
//     heading on is fleet-identical boilerplate carrying the owner's name,
//     Drive folder, token paths, curl shapes) + skill names/descriptions.
//     SOUL.md is excluded entirely -- pure persona, zero routing signal.
//   - The prompt bans personal data AND the output is checked
//     DETERMINISTICALLY (containsPrivateData): a summary that still carries
//     the owner's name, chat id, Drive folder, a token, or a known internal
//     system name is REJECTED, never cached; a rejection marker keyed to the
//     sourceHash prevents a retry loop (regenerate only when sources change).
//   - The MAIN agent's summary is a FIXED template, never LLM-generated:
//     PROJECT_ROOT/CLAUDE.md is the operator's persona file.
//   - Whether summaries ship to a given peer is the per-peer opt-in
//     shareCapabilitySummaries flag; the manifest assembler re-checks
//     containsPrivateData as a second chokepoint (stale/hand-edited cache).
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { STORE_DIR, BOT_NAME, OWNER_NAME, OWNER_NAME_PLACEHOLDER, OWNER_DRIVE_FOLDER, ALLOWED_CHAT_ID } from '../../config.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { logger } from '../../logger.js'
import { agentDir, readAgentDisplayName, readAgentModel } from '../agent-config.js'
import { getFederationConfig } from './config.js'
import { listAgentLocalSkills } from './local-catalog.js'

export const CAPABILITY_CACHE_FILENAME = 'capability-summaries.json'
export const CAPABILITY_SUMMARY_MAX_CHARS = 600
// Per-generation budget: a wedged 2-sentence generation must not hold the
// single serialized worker for the global 20min default.
export const CAPABILITY_GENERATION_TIMEOUT_MS = 5 * 60_000
// Failure backoff: base doubles per consecutive failure, capped at a day --
// one permanently failing agent must not starve the rest of the catalog.
export const CAPABILITY_FAILURE_BACKOFF_BASE_MS = 30 * 60_000
export const CAPABILITY_FAILURE_BACKOFF_MAX_MS = 24 * 60 * 60_000

export interface CapabilityCacheEntry {
  summary?: string
  sourceHash: string
  generatedAt?: number
  lastAttemptAt?: number
  consecutiveFailures?: number
  // Set when a generated summary failed the privacy scrub for THIS hash:
  // do not retry until the sources change (the model would likely repeat it).
  rejected?: boolean
}

export type CapabilityCache = Record<string, CapabilityCacheEntry>

// Test seam (config.ts precedent: explicit override, no NODE_ENV magic).
let storeDir = STORE_DIR
let cache: CapabilityCache | null = null

function cachePath(): string { return join(storeDir, CAPABILITY_CACHE_FILENAME) }

export function _setCapabilityStoreDirForTest(dir: string): void {
  storeDir = dir
  cache = null
}

export function readCapabilityCache(): CapabilityCache {
  if (cache !== null) return cache
  try {
    if (!existsSync(cachePath())) { cache = {}; return cache }
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf-8'))
    cache = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as CapabilityCache : {}
  } catch {
    cache = {}
  }
  return cache
}

export function writeCapabilityCache(next: CapabilityCache): void {
  atomicWriteFileSync(cachePath(), JSON.stringify(next, null, 2))
  cache = next
}

/** Full-removal purge (idempotent, ENOENT-tolerant). Lossless DISABLE keeps
 *  the cache (regeneration is expensive); only removal deletes it. */
export function purgeCapabilityCache(): void {
  try {
    unlinkSync(cachePath())
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ err }, 'capabilities: cache unlink failed')
    }
  }
  cache = {}
}

// ---- source material ---------------------------------------------------------

// The fleet-boilerplate heading: everything from here on is identical across
// agents and saturated with private constants -- zero routing signal.
const BOILERPLATE_HEADING_RX = /^## Mem[oó]ria rendszer\s*$/m

/** Role-specific head of an agent's CLAUDE.md (before the fleet boilerplate);
 *  the whole file when the heading is absent (hand-written personas). */
export function roleSpecificHead(claudeMd: string): string {
  const m = BOILERPLATE_HEADING_RX.exec(claudeMd)
  return m ? claudeMd.slice(0, m.index) : claudeMd
}

export interface SummarySource {
  displayName: string
  model: string
  roleHead: string
  skills: Array<{ name: string; description: string }>
}

export function readSummarySource(agentName: string): SummarySource {
  let claudeMd = ''
  try { claudeMd = readFileSync(join(agentDir(agentName), 'CLAUDE.md'), 'utf-8') } catch { /* absent: hash covers it */ }
  return {
    displayName: readAgentDisplayName(agentName),
    model: readAgentModel(agentName),
    roleHead: roleSpecificHead(claudeMd),
    skills: listAgentLocalSkills(agentName).map((s) => ({ name: s.name, description: s.description })),
  }
}

export function summarySourceHash(src: SummarySource, lang: 'hu' | 'en'): string {
  const h = createHash('sha256')
  // lang is part of the identity: a DASHBOARD_LANG flip must bump the hash so
  // the runner regenerates in the new language (else the old-language text
  // stays 'fresh' forever, and a rejected entry is never re-attempted).
  h.update(lang).update(' ').update(src.displayName).update('\0').update(src.model).update('\0').update(src.roleHead).update('\0')
  for (const s of src.skills) h.update(s.name).update('\0').update(s.description).update('\0')
  return h.digest('hex')
}

// ---- deterministic privacy scrub ----------------------------------------------

// Hardcoded internal-system literals the scaffolder bakes into fleet rules.
const INTERNAL_SYSTEM_LITERALS = ['alkotmany', 'iskb', 'circleback']

function readDashboardTokenBestEffort(): string {
  // Mirror loadOrCreateDashboardToken's resolution order (env FIRST, then
  // file) read-only -- an install that sets DASHBOARD_TOKEN in the env never
  // writes the file, so a file-only lookup would drop the ACTIVE token from
  // the scrub set. Read-only on purpose: loadOrCreateDashboardToken would
  // MINT one.
  const fromEnv = process.env['DASHBOARD_TOKEN']?.trim()
  if (fromEnv) return fromEnv
  try { return readFileSync(join(storeDir, '.dashboard-token'), 'utf-8').trim() } catch { return '' }
}

/** The owner-name scrub needle. The distribution placeholder ('Owner') maps
 *  to '' (= skipped by the empty-value rule below): it is a generic English
 *  word, and scrubbing it false-positives on fixed template text like the
 *  main-agent summary's "owner channels" -- which would silently suppress
 *  every capability summary on an unconfigured install. A REAL configured
 *  name (env/onboarding) is scrubbed as before. Pure + exported for tests. */
export function ownerScrubNeedle(name: string, placeholder: string = OWNER_NAME_PLACEHOLDER): string {
  const v = (name || '').trim()
  return v.toLowerCase() === placeholder.trim().toLowerCase() ? '' : v
}

/** Deterministic outbound-content check. Returns the LABEL of the first
 *  private constant found in the text (case-insensitive substring -- covers
 *  Hungarian inflected forms, suffixes append), or null when clean. Empty
 *  constants are SKIPPED (''.includes() would reject everything). */
export function containsPrivateData(text: string): string | null {
  const lower = text.toLowerCase()
  const checks: Array<[string, string]> = [
    ['owner name', ownerScrubNeedle(OWNER_NAME)],
    ['drive folder', OWNER_DRIVE_FOLDER],
    ['chat id', ALLOWED_CHAT_ID],
    ['token path', 'store/.dashboard-token'],
    ['dashboard token', readDashboardTokenBestEffort()],
  ]
  for (const peer of getFederationConfig().peers) {
    checks.push(['peer token', peer.inboundToken], ['peer token', peer.outboundToken])
  }
  for (const lit of INTERNAL_SYSTEM_LITERALS) checks.push(['internal system name', lit])
  for (const [label, value] of checks) {
    const v = (value || '').trim().toLowerCase()
    if (v.length === 0) continue
    if (lower.includes(v)) return label
  }
  return null
}

// ---- read side -----------------------------------------------------------------

/** Fixed main-agent summary -- NEVER LLM-generated (the main persona file is
 *  the operator's own). */
export function mainAgentCapabilitySummary(lang: 'hu' | 'en'): string {
  return lang === 'en'
    ? `${BOT_NAME}: the system's main coordinator — owner channels, task breakdown and distribution to local specialists, policy decisions; the entry point for complex or multi-agent requests.`
    : `${BOT_NAME}: a rendszer fő koordinátora — tulaj-csatornák, feladatbontás és szétosztás a helyi specialisták közt, házirendi döntések; összetett vagy több-ügynökös kérések belépési pontja.`
}

/** Cached summary for a local sub-agent, with a freshness verdict computed
 *  against the CURRENT sources (two file reads + a hash -- same cost class as
 *  the manifest's per-request reads). A stale or rejected entry yields no
 *  summary for the wire (fresh-or-nothing) but is still returned for the
 *  local directory, which can mark it stale instead of losing the signal. */
export function getCapabilitySummary(agentName: string, lang: 'hu' | 'en'): { summary: string | null; fresh: boolean } {
  const entry = readCapabilityCache()[agentName]
  if (!entry || !entry.summary) return { summary: null, fresh: false }
  const fresh = entry.sourceHash === summarySourceHash(readSummarySource(agentName), lang)
  return { summary: entry.summary, fresh }
}

// ---- pick-one-stale decision (pure) --------------------------------------------

export function failureBackoffMs(consecutiveFailures: number): number {
  return Math.min(
    CAPABILITY_FAILURE_BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1),
    CAPABILITY_FAILURE_BACKOFF_MAX_MS,
  )
}

/** Which agents NEED (re)generation right now. Pure: candidates come with
 *  their current source hash; the cache and clock are inputs. Skips entries
 *  rejected for the same hash and entries inside their failure backoff;
 *  orders least-recently-attempted first. */
export function pickStaleAgents(
  candidates: Array<{ name: string; sourceHash: string }>,
  cacheState: CapabilityCache,
  now: number,
  limit: number,
): string[] {
  const eligible = candidates.filter((c) => {
    const e = cacheState[c.name]
    if (!e) return true
    if (e.sourceHash === c.sourceHash) {
      if (e.summary) return false // fresh
      if (e.rejected) return false // privacy-rejected for THIS content: wait for a source change
      // failed generation for this hash: respect the backoff
      const failures = e.consecutiveFailures ?? 0
      if (failures > 0 && e.lastAttemptAt !== undefined && now - e.lastAttemptAt < failureBackoffMs(failures)) return false
      return true
    }
    // sources changed: fresh attempt regardless of old failure state
    return true
  })
  eligible.sort((a, b) => (cacheState[a.name]?.lastAttemptAt ?? 0) - (cacheState[b.name]?.lastAttemptAt ?? 0))
  return eligible.slice(0, limit).map((c) => c.name)
}

// ---- generation ----------------------------------------------------------------

export function buildSummaryPrompt(agentName: string, src: SummarySource, lang: 'hu' | 'en'): string {
  const skillLines = src.skills.map((s) => `- ${s.name}: ${s.description}`).join('\n') || '(none)'
  const langLine = lang === 'en' ? 'Write in English.' : 'Írj magyarul.'
  return `Summarize in 2-4 sentences what the following AI agent can DO, as a routing aid for other agents deciding whom to delegate a task to.

STRICT RULES:
- Capabilities only, in GENERIC domain wording (e.g. "infrastructure monitoring and alert calibration"). NO client, system, project or product proper nouns.
- NEVER include personal data, names of people, chat/sender ids, URLs, file paths, tokens or credentials. Refer to the human only as "the operator" if needed.
- Return ONLY the summary text, no headings, no markdown fences. ${langLine}

Agent id: ${agentName}
Display name: ${src.displayName}
Model: ${src.model}

Role description (persona head):
${src.roleHead.slice(0, 6000)}

Skills:
${skillLines}`
}

/** One generation attempt for one agent; updates the cache with either the
 *  scrub-checked summary or the failure/rejection state. Returns what
 *  happened (for the runner's log line). */
export async function generateOneSummary(
  agentName: string,
  lang: 'hu' | 'en',
  runLLM: (prompt: string) => Promise<{ text: string | null; error?: string }>,
): Promise<'ok' | 'rejected' | 'failed'> {
  const src = readSummarySource(agentName)
  const sourceHash = summarySourceHash(src, lang)
  const now = Date.now()
  const current = readCapabilityCache()
  const prev = current[agentName]

  let text: string | null = null
  let error: string | undefined
  try {
    const r = await runLLM(buildSummaryPrompt(agentName, src, lang))
    text = r.text
    error = r.error
  } catch (err) {
    error = String(err)
  }

  if (!text || error) {
    const failures = (prev?.sourceHash === sourceHash ? prev?.consecutiveFailures ?? 0 : 0) + 1
    writeCapabilityCache({
      ...current,
      [agentName]: { ...(prev?.sourceHash === sourceHash ? prev : {}), sourceHash, lastAttemptAt: now, consecutiveFailures: failures },
    })
    logger.warn({ agent: agentName, error, failures }, 'capabilities: summary generation failed')
    return 'failed'
  }

  // Single line + cap at the single source of truth (cache write): the
  // manifest, the directory and every peer view carry identical text.
  const summary = text.replace(/\s*\n\s*/g, ' ').trim().slice(0, CAPABILITY_SUMMARY_MAX_CHARS)
  const hit = containsPrivateData(summary)
  if (hit) {
    writeCapabilityCache({
      ...current,
      [agentName]: { sourceHash, lastAttemptAt: now, rejected: true },
    })
    logger.warn({ agent: agentName, hit }, 'capabilities: generated summary REJECTED by the privacy scrub; degrading to skills-only until sources change')
    return 'rejected'
  }
  writeCapabilityCache({
    ...current,
    [agentName]: { summary, sourceHash, generatedAt: now, lastAttemptAt: now },
  })
  logger.info({ agent: agentName, chars: summary.length }, 'capabilities: summary generated')
  return 'ok'
}

/** Drop cache entries for agents that no longer exist (poller peer-prune
 *  convention). Covers manual agents/<name> directory removals too. */
export function pruneCapabilityCache(validNames: Set<string>): void {
  const current = readCapabilityCache()
  const keys = Object.keys(current)
  const keep = keys.filter((k) => validNames.has(k))
  if (keep.length === keys.length) return
  const next: CapabilityCache = {}
  for (const k of keep) next[k] = current[k]
  writeCapabilityCache(next)
}
