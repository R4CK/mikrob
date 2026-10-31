// Pure logic for the model-fallback-on-limit feature.
//
// Motivation: when an agent's Claude plan usage limit is reached, the Claude
// Code session pauses and prints a usage-limit banner in its tmux pane. Until
// the window resets (or the user intervenes) the agent is deaf. This feature
// detects that banner and downgrades the agent one step down a configured model
// chain (e.g. opus -> sonnet -> haiku), respawning the session so the cheaper
// model -- on a separate budget -- takes over without losing the conversation.
// After a revert window with no limit in sight, it climbs back to the primary.
//
// This module stays dependency-light -- its only import is the dep-free model-id allowlist
// (model-id.js), so every decision is still unit-testable without a clock, tmux, or the filesystem.
// The I/O (capture-pane, model write, restart)
// lives in src/web/model-fallback-runner.ts; the config store lives in
// src/web/model-fallback-store.ts.

// Resolved full model IDs, mirroring MODEL_ALIASES in src/web/agent-config.ts.
// chain[0] is the primary (what we revert UP to); each subsequent entry is the
// next downgrade target. Kept as literals here to preserve the zero-import,
// trivially-testable property of this module.
import { isValidModelId, InvalidModelIdError } from './model-id.js'

export const DEFAULT_MODEL_CHAIN: readonly string[] = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
]

// Revert only well after the typical 5-hour plan window so we do not climb back
// to the primary just to re-trip the same limit. Configurable.
export const DEFAULT_REVERT_AFTER_MINUTES = 330

// Weekly-tier stepdown (card 5d2002b5, Peti). INDEPENDENT of the 5h-banner
// fallback and the 90% hard stop: as the WEEKLY usage % climbs, every role agent
// steps one tier down the model chain so work continues on a cheaper model
// instead of stopping. Two configurable thresholds -> tier 1 / tier 2.
export const DEFAULT_WEEKLY_TIER1_PERCENT = 75
export const DEFAULT_WEEKLY_TIER2_PERCENT = 85

// Hysteresis deadband (percentage points). A tier is entered when the weekly %
// crosses its threshold going UP, but only released when the % falls this far
// BELOW the threshold, so a % hovering on a boundary cannot flap the whole fleet
// between two models every read.
export const WEEKLY_TIER_DEADBAND = 3

export interface ModelFallbackConfig {
  /** Master toggle for the banner-driven fallback. When false no agent is auto-switched by it. */
  enabled: boolean
  /** Primary-first model chain. Downgrades walk forward; revert goes to [0]. */
  chain: string[]
  /** Minutes a downgraded agent must stay limit-free before climbing back. */
  revertAfterMinutes: number
  /** Toggle for the weekly-% tier stepdown. Independent of `enabled` (opt-in). */
  weeklyTierEnabled: boolean
  /** Weekly % at/above which every agent drops one tier (chain[0]->chain[1]). */
  weeklyTier1Percent: number
  /** Weekly % at/above which every agent drops a further tier (->chain[2]). Must exceed tier1. */
  weeklyTier2Percent: number
}

export const DEFAULT_MODEL_FALLBACK: ModelFallbackConfig = {
  enabled: false,
  chain: [...DEFAULT_MODEL_CHAIN],
  revertAfterMinutes: DEFAULT_REVERT_AFTER_MINUTES,
  weeklyTierEnabled: false,
  weeklyTier1Percent: DEFAULT_WEEKLY_TIER1_PERCENT,
  weeklyTier2Percent: DEFAULT_WEEKLY_TIER2_PERCENT,
}

/** Clamp an untrusted value to an integer percentage in 1..100, or the fallback on junk. */
function clampPercent(v: unknown, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(100, Math.round(n)))
}

/** Trim, drop empty/non-string entries, and dedupe (first occurrence wins) a candidate chain. */
export function sanitizeChain(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of raw) {
    if (typeof m !== 'string') continue
    const t = m.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/** Coerce an untrusted parsed-JSON value into a valid config (defaults on junk). */
export function normalizeModelFallbackConfig(raw: unknown): ModelFallbackConfig {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const enabled = o.enabled === true
  let chain = DEFAULT_MODEL_FALLBACK.chain
  const cleaned = sanitizeChain(o.chain)
  // A chain needs at least a primary + one fallback to be meaningful.
  if (cleaned.length >= 2) chain = cleaned
  let revertAfterMinutes = DEFAULT_MODEL_FALLBACK.revertAfterMinutes
  if (typeof o.revertAfterMinutes === 'number' && Number.isFinite(o.revertAfterMinutes) && o.revertAfterMinutes > 0) {
    revertAfterMinutes = Math.floor(o.revertAfterMinutes)
  }
  const weeklyTierEnabled = o.weeklyTierEnabled === true
  let weeklyTier1Percent = clampPercent(o.weeklyTier1Percent, DEFAULT_WEEKLY_TIER1_PERCENT)
  let weeklyTier2Percent = clampPercent(o.weeklyTier2Percent, DEFAULT_WEEKLY_TIER2_PERCENT)
  // tier1 must sit strictly below tier2, else the two tiers are meaningless. A
  // stored/hand-edited pair that violates it falls back to the safe defaults
  // rather than serving an order that never crosses into tier 1.
  if (weeklyTier1Percent >= weeklyTier2Percent) {
    weeklyTier1Percent = DEFAULT_WEEKLY_TIER1_PERCENT
    weeklyTier2Percent = DEFAULT_WEEKLY_TIER2_PERCENT
  }
  return { enabled, chain, revertAfterMinutes, weeklyTierEnabled, weeklyTier1Percent, weeklyTier2Percent }
}

/** Thrown by parseModelFallbackUpdate on invalid operator input (rule 12: descriptive, not silent). */
export class ModelFallbackConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelFallbackConfigError'
  }
}

/**
 * Validate a partial config update from the dashboard, throwing a descriptive
 * ModelFallbackConfigError on bad input (so the endpoint returns 400 rather than
 * silently substituting a default). Only the fields actually present are
 * validated + returned. Free-text model IDs are accepted verbatim (a future
 * model can be typed in and used with zero code change); the only chain rules
 * are: array of >=2 non-empty, deduped strings.
 */
export function parseModelFallbackUpdate(body: unknown): Partial<ModelFallbackConfig> {
  const o = (body && typeof body === 'object') ? body as Record<string, unknown> : {}
  const out: Partial<ModelFallbackConfig> = {}

  if ('enabled' in o) out.enabled = o.enabled === true
  if ('weeklyTierEnabled' in o) out.weeklyTierEnabled = o.weeklyTierEnabled === true

  if ('chain' in o) {
    if (!Array.isArray(o.chain)) {
      throw new ModelFallbackConfigError('A modell-lánc egy tömb kell legyen.')
    }
    if (o.chain.some((m) => typeof m !== 'string')) {
      throw new ModelFallbackConfigError('A modell-lánc minden eleme szöveges modell-azonosító kell legyen.')
    }
    const chain = sanitizeChain(o.chain)
    if (chain.length < 2) {
      throw new ModelFallbackConfigError('A modell-lánc legalább 2 különböző, nem üres modell-azonosítót kell tartalmazzon (elsődleges + legalább egy visszalépés).')
    }
    // Card b7fa5281: a chain id is resolved and launched exactly like a per-agent model, so it goes
    // through the SAME shell command string. Reject a shell-unsafe entry here rather than store it.
    const bad = chain.find((m) => !isValidModelId(m))
    if (bad !== undefined) {
      throw new ModelFallbackConfigError(new InvalidModelIdError(bad).message)
    }
    out.chain = chain
  }

  const parsePercent = (v: unknown, label: string): number => {
    const n = Number(v)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 100) {
      throw new ModelFallbackConfigError(`A(z) "${label}" küszöb 1 és 100 közötti egész szám kell legyen.`)
    }
    return n
  }
  const hasT1 = 'weeklyTier1Percent' in o
  const hasT2 = 'weeklyTier2Percent' in o
  const t1 = hasT1 ? parsePercent(o.weeklyTier1Percent, 'weeklyTier1Percent') : undefined
  const t2 = hasT2 ? parsePercent(o.weeklyTier2Percent, 'weeklyTier2Percent') : undefined
  if (t1 !== undefined && t2 !== undefined && t1 >= t2) {
    throw new ModelFallbackConfigError(
      `A "tier 1" küszöb kisebb kell legyen a "tier 2" küszöbnél (${t1} >= ${t2}): különben sosem lépne az első olcsóbb szintre.`,
    )
  }
  if (t1 !== undefined) out.weeklyTier1Percent = t1
  if (t2 !== undefined) out.weeklyTier2Percent = t2

  if ('revertAfterMinutes' in o) {
    const n = Number(o.revertAfterMinutes)
    if (!Number.isFinite(n) || n <= 0) {
      throw new ModelFallbackConfigError('A "revertAfterMinutes" pozitív szám kell legyen.')
    }
    out.revertAfterMinutes = Math.floor(n)
  }

  return out
}

// The Claude Code usage-limit banner appears at the bottom of the pane (above
// the footer) when the plan budget is exhausted or nearly so. Match only the
// live banner region so a message body or scrollback that merely quotes the
// phrase does not trip a downgrade.
export const USAGE_LIMIT_BANNER_REGION_LINES = 15

// Distinctive plan-limit phrasings. Deliberately NARROW: a generic "rate limit"
// / "API Error: 429" (transient overload, handled elsewhere) must NOT match --
// that is a momentary blip, not a plan-budget exhaustion that warrants a model
// switch.
// NOTE (2026-06-30): dropped the "upgrade to increase your usage limit" token.
// It matched Claude Code's "/upgrade to increase your usage limit." STARTUP HINT
// shown in every fresh idle pane, so freshly-booted agents read as limited and
// would be needlessly downgraded. Real limits still match via "usage limit
// reached" / "limit will reset at" / "N-hour limit reached".
//
// FORK/UPSTREAM RESOLUTION (2026-08-14, card f085fd44) -- this line is a standing merge conflict,
// so the rule is written down rather than re-derived under time pressure at the next integration:
//   ADOPT from upstream: the "session limit" alternative. Production shows
//     "You hit your session limit - resets 5:50pm" (upstream, 2026-08-08), and nothing else in this
//     pattern covers it -- "resets 5:50pm" is not "limit will reset at". Without it a genuinely
//     limited agent reads as healthy and keeps hammering a paused session.
//   KEEP from the fork: the absence of "upgrade to increase your usage limit" (above).
// The two changes are independent, which is why neither side's file can be taken wholesale: a
// theirs-merge reintroduces the fleet-wide false positive, an ours-merge drops a real detection.
//
// CONSOLIDATION (card 115c21e7): this list used to be re-typed independently in 7 other files
// (5 shell scripts + a Python bridge), and had drifted -- 3 phrasings from the interactive
// limit-modal ("wait for limit to reset", "stop and wait for limit", "upgrade your plan", added
// 2026-07-11 by commit 5fccf4f9 for the SAME modal's other menu options) existed only in the shell
// side and were MISSING here, a real detection gap in this module's own path. This module cannot
// read them from a shared file at runtime -- its own header states "every decision is still
// unit-testable without a clock, tmux, or the filesystem", a load-bearing zero-fs-dependency
// property this consolidation does not get to break. So this array stays the literal, in-memory
// source of truth, and store/session-limit-pattern.json (read by the 6 non-TS consumers) is kept
// equal to it by a dedicated consistency test (session-limit-pattern-consistency.test.ts) rather
// than by a shared runtime read. ERE-safe on purpose (no \d, no (?:...)) so the exact same fragment
// strings compile under bash `grep -E`, Python `re`, and this RegExp unchanged.
export const USAGE_LIMIT_FRAGMENTS = [
  'usage limit reached',
  'reached your (usage|weekly) limit',
  'hit (your|the) (session|usage) limit',
  'approaching (your )?(usage|weekly) limit',
  '(weekly|session) limit reached',
  'usage limit (will )?reset',
  'limit will reset at',
  '[0-9]+-hour limit reached',
  'wait for limit to reset',
  'stop and wait for limit',
  'upgrade your plan',
]
const USAGE_LIMIT_RX = new RegExp(`(${USAGE_LIMIT_FRAGMENTS.join('|')})`, 'i')

// The region-wide SHAPE guard that used to live here (card 381b6f49: require
// the absence of the live idle footer / busy indicator before trusting a
// phrase match) is RETIRED as of Koteg 22 -- its premise ("footer present
// means healthy, not limited") turned out to be false: Claude Code renders
// the same idle footer underneath a real plan-limit banner too (measured
// against two new upstream features that need usageLimitBannerLine to detect
// a banner sitting right next to that exact footer). Replaced by a per-line
// START anchor in usageLimitBannerLine below (a phrase only counts when it
// opens its own line, right after the glyph prefix) -- same false-positive
// case this guard was built for (a quoted/discussed mention never opens its
// line that way), without the footer-presence assumption that broke.

// The exhausted-extra-usage reply. Measured on the live install: the main
// session answered 2798 turns with exactly this synthetic API-error message
// between 2026-09-20T02:19Z and 2026-09-21T03:59Z (transcript records with
// isApiErrorMessage=true, error="rate_limit", apiErrorStatus=429), and
// USAGE_LIMIT_RX matched none of them. Observed wordings, verbatim:
//   "You're out of extra usage · resets 6am (Europe/Budapest)"            (2609)
//   "You're out of extra usage · resets Sep 21, 6am (Europe/Budapest)"    (189)
// The phrase itself is easy to quote in ordinary conversation (an agent
// reporting this very bug writes it), so the match is anchored to the banner
// SHAPE: the phrase opens its own line (after indentation and the "⎿" / "●"
// glyph Claude Code draws before an API-error reply) and the line either ends
// there or continues only with the "· resets ..." tail. A sentence that merely
// mentions it mid-line, or continues past it ("..., so the heartbeat ..."),
// does not match. Kept separate from USAGE_LIMIT_RX because it needs the
// multiline flag, and the older alternatives must keep matching mid-line.
const EXTRA_USAGE_EXHAUSTED_RX =
  /^[\s⎿●>]*you(?:['’]re| are) out of extra usage[ \t]*(?:[·∙•][^\n]*)?$/im

/**
 * True when the live pane shows a Claude *plan usage-limit* banner (not a
 * transient API 429). Pure + dependency-free. Restricted to the bottom region
 * so quoted text in scrollback or a reply body cannot trigger it, and gated on
 * the ABSENCE of the live idle footer / busy chrome so a healthy session that
 * merely quotes the phrase (see the SHAPE guard comment above) does not.
 */
export function detectsUsageLimit(pane: string): boolean {
  return usageLimitBannerLine(pane) !== null
}

// Leading pane glyphs a banner line can open with, before the phrase itself:
// whitespace, the API-error reply markers (⎿, ●, >), or a paused-plan warning
// glyph (⚠). Shared by the line-start anchor check and the trim below so the
// two cannot drift (card 381b6f49-class risk otherwise).
const BANNER_GLYPH_PREFIX_RX = /^[\s⎿●>⚠]*/

// After the glyph prefix, a real banner's own SUBJECT may still sit before the
// USAGE_LIMIT_FRAGMENTS match ("You have reached...", "You hit...", "Your limit
// will..."), because the fragments are deliberately partial, not full sentences
// (see the comment above USAGE_LIMIT_FRAGMENTS). This is the ONLY prose allowed
// between the glyph prefix and the match: a discussion/analysis sentence ("the
// detector matches...", "the card says...", "Quoting the source comment...")
// never fits this narrow a shape, which is exactly the card 381b6f49 false
// positive this anchor exists to keep excluding.
const BANNER_SUBJECT_LEADIN_RX = /^(You|Your|You're|You've)?\s*(have|hit|reached)?\s*$/i

/**
 * The banner line detectsUsageLimit() matched, trimmed and stripped of the
 * leading pane glyphs (e.g. "You're out of extra usage · resets 6am
 * (Europe/Budapest)"), or null when there is none. Lets a caller key a limit
 * episode by its wording and read the reset tail without re-deriving the
 * match.
 *
 * Koteg 22 (upstream) needed a per-line extraction (EXTRA_USAGE_EXHAUSTED_RX
 * and the reset-tail text) that still detects a genuine banner sitting right
 * next to the pane's NORMAL idle/busy footer -- which Claude Code renders
 * underneath a real plan-limit screen too, so "footer present" never proved
 * "healthy, not limited" to begin with (measured: the live idle footer and a
 * real banner routinely co-occur). The fork's prior region-wide busy/idle
 * guard (card 381b6f49) is replaced here with a STRICTER, per-line one that
 * keeps its actual intent: a USAGE_LIMIT_RX hit only counts when the phrase
 * opens its own line (immediately after the glyph prefix, nothing else before
 * it) -- the same anchoring EXTRA_USAGE_EXHAUSTED_RX already uses. A quoted or
 * discussed mention ("the detector matches \"usage limit reached\"...")
 * never opens its line that way, so it still correctly does not match; a real
 * banner line always does, footer or no footer.
 */
export function usageLimitBannerLine(pane: string): string | null {
  if (!pane || !pane.trim()) return null
  const lines = pane.split('\n')
  const regionLines = lines.slice(-USAGE_LIMIT_BANNER_REGION_LINES)
  // Bottom-up: the newest banner is the one that describes the live state.
  for (let i = regionLines.length - 1; i >= 0; i--) {
    const line = regionLines[i]
    if (EXTRA_USAGE_EXHAUSTED_RX.test(line)) {
      return line.replace(BANNER_GLYPH_PREFIX_RX, '').trim()
    }
    const prefixLen = (line.match(BANNER_GLYPH_PREFIX_RX)?.[0] ?? '').length
    const m = USAGE_LIMIT_RX.exec(line)
    if (m && m.index >= prefixLen && BANNER_SUBJECT_LEADIN_RX.test(line.slice(prefixLen, m.index))) {
      return line.replace(BANNER_GLYPH_PREFIX_RX, '').trim()
    }
  }
  return null
}

/**
 * The next model one step down the chain from `current`, or null if already at
 * the bottom. An unrecognised current model is treated as the primary, so the
 * first downgrade target (chain[1]) applies.
 */
export function nextFallbackModel(current: string, chain: string[]): string | null {
  if (chain.length < 2) return null
  const idx = chain.indexOf(current)
  if (idx < 0) return chain[1] ?? null
  if (idx >= chain.length - 1) return null
  return chain[idx + 1]
}

/**
 * Target chain index for the fleet from the live WEEKLY usage %, WITH HYSTERESIS.
 *
 *   percent >= tier2  -> 2   (two tiers down: chain[2])
 *   percent >= tier1  -> 1   (one tier down:  chain[1])
 *   below both        -> 0   (primary)
 *
 * `currentIndex` is the tier the fleet is at now. A boundary already crossed
 * (currentIndex > its position) is only released once the % drops
 * WEEKLY_TIER_DEADBAND below its threshold; an uncrossed boundary is entered the
 * moment the % reaches it. So the fleet steps UP a tier exactly at the
 * threshold but must fall a few points BELOW before climbing back -- no flapping
 * on a % that hovers on a boundary. Pure: the runner supplies the live % + last
 * tier and applies the result.
 *
 * An unknown/negative % holds the current tier (never flaps to 0 on a transient
 * unreadable weekly-% flag).
 */
export function weeklyTierIndex(
  percent: number,
  cfg: Pick<ModelFallbackConfig, 'weeklyTier1Percent' | 'weeklyTier2Percent'>,
  currentIndex: number,
): 0 | 1 | 2 {
  const clampIdx = (n: number): 0 | 1 | 2 => (n <= 0 ? 0 : n >= 2 ? 2 : 1)
  const cur = clampIdx(currentIndex)
  if (!Number.isFinite(percent) || percent < 0) return cur
  const boundaries = [cfg.weeklyTier1Percent, cfg.weeklyTier2Percent]
  let idx = 0
  for (let i = 0; i < boundaries.length; i++) {
    const thr = boundaries[i]
    const wasActive = cur > i
    const active = wasActive ? percent >= thr - WEEKLY_TIER_DEADBAND : percent >= thr
    if (!active) break // ascending boundaries: once one is inactive, higher ones are too
    idx = i + 1
  }
  return clampIdx(idx)
}

export interface ModelFallbackFacts {
  /** Whether the agent's pane currently shows a usage-limit banner. */
  limitDetected: boolean
  /** The agent's current resolved model id. */
  currentModel: string
  /** Primary-first model chain. */
  chain: string[]
  /** When this agent was last downgraded (ms epoch), or null if on primary. */
  downgradedAt: number | null
  /** Current time (ms epoch). */
  now: number
  /** Revert window in ms. */
  revertAfterMs: number
}

export type ModelAction =
  | { kind: 'none' }
  | { kind: 'downgrade'; model: string }
  | { kind: 'revert'; model: string }

/**
 * Decide what to do for one agent. Pure: the runner gates the I/O (idle pane,
 * actual write+restart) separately.
 *
 *   - limit detected & a lower model exists -> downgrade to it.
 *   - limit detected & already at the bottom -> nothing inside the revert
 *     window; past it, revert anyway (a stale --continue banner must not pin it).
 *   - no limit & downgraded long enough ago -> revert to the primary (chain[0]).
 *   - otherwise -> nothing.
 */
export function decideModelAction(f: ModelFallbackFacts): ModelAction {
  if (f.limitDetected) {
    const next = nextFallbackModel(f.currentModel, f.chain)
    if (next && next !== f.currentModel) return { kind: 'downgrade', model: next }
    // At the bottom of the chain (FALLBACKSTUCK924): a limit
    // banner here must not block the revert forever. After a downgrade the
    // session restarts with --continue, so on an idle pane the OLD banner can
    // sit in the bottom region indefinitely and the agent never gets back to
    // the primary. Past the revert window, try the primary anyway: if the
    // limit is real, the next sweep sees the banner on the primary and
    // downgrades again -- at most one retry per window, never a pinned fleet.
    if (f.downgradedAt === null || f.now - f.downgradedAt < f.revertAfterMs) return { kind: 'none' }
  }
  if (f.downgradedAt !== null && f.now - f.downgradedAt >= f.revertAfterMs) {
    const primary = f.chain[0]
    if (primary && f.currentModel !== primary) return { kind: 'revert', model: primary }
  }
  return { kind: 'none' }
}
