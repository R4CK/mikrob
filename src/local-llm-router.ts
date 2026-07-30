// AUTO-ROUTER for local-LLM offload (card a31e8ddf, epic 5f182b68).
//
// GOAL (Peti 2026-07-25): local offload is the DEFAULT; going ONLINE is opt-IN. A task is routed
// ONLINE only when it is (a) in a NON-OFFLOADABLE category -- authz, tenant/isolation, architecture,
// multi-file wiring, security decision -- or (b) harder than the configured difficulty threshold
// (which is itself capped by the reliable ceiling). Everything else drafts locally on the GPU.
//
// FAIL-CLOSED: this classifier is a SAFETY policy, not a quality optimizer. A false positive (an
// easy task sent online) costs tokens; a false NEGATIVE (a security decision handed to the 7B) is a
// real risk. So matching is deliberately generous, an ambiguous/hedged signal routes ONLINE, and an
// unparseable/empty input routes ONLINE.
//
// DETERMINISTIC BY DESIGN: the category + shape matching is CODE (keyword/shape tables below), never
// an LLM call -- a classifier that decides what may skip review must not itself be a 7B guess. Only
// a genuinely fuzzy tie-break may be escalated to the model, and that path defaults ONLINE.
//
// Threshold logic is REUSED from ./web/routes/local-llm.js (CODING_DIFFICULTY_LEVELS, the reliable
// ceiling, the aggressiveness-slider default and isDraftableLocally) -- this module adds no second
// copy of the threshold rules (rag.sh already mirrors them in python; a third copy would drift).
//
// GitHub-first (rule 10): surveyed WayfinderRouter (deterministic local-vs-hosted by complexity
// score), ulab-uiuc/LLMRouter and NVIDIA-AI-Blueprints/llm-router (KNN/SVM/MLP/CLIP-embedding
// quality-cost routers). DECISION = adapt + build: the tiered-threshold idea is adopted, but all
// three route on predicted ANSWER QUALITY, need training data/embeddings/model weights, and none
// encodes a fail-closed per-category safety policy over OUR difficulty taxonomy. Pulling an ML
// router in for a keyword policy would add supply-chain and memory weight on the WSL box for no gain.

import {
  CODING_DIFFICULTY_LEVELS,
  RELIABLE_CEILING,
  defaultDifficultyForAggressiveness,
  isDraftableLocally,
  normalizeDifficulty,
  type CodingDifficulty,
} from './web/routes/local-llm.js'

/** Categories that NEVER draft locally, however easy they look (Peti's offload directive). */
export const NON_OFFLOADABLE_CATEGORIES = [
  'authz',
  'isolation',
  'architecture',
  'multi-file-wiring',
  'security-decision',
] as const
export type NonOffloadableCategory = (typeof NON_OFFLOADABLE_CATEGORIES)[number]

export type Route = 'local' | 'online'

export interface RouteDecision {
  readonly route: Route
  /** Why -- one short, loggable reason (also the audit trail on a card). */
  readonly reason: string
  /** The category that forced ONLINE, when one did. */
  readonly category?: NonOffloadableCategory
  /** The difficulty actually used for the gate (declared or inferred). */
  readonly difficulty?: CodingDifficulty
}

export interface RouteInput {
  /** Free-text task description / prompt shape. */
  readonly description: string
  /** Declared coding difficulty, if the caller knows it. */
  readonly difficulty?: string | null
  /** Offload aggressiveness slider (0-100); used when no explicit threshold is given. */
  readonly aggressiveness?: number
  /** Explicit configured threshold; falls back to the slider-derived default. */
  readonly threshold?: string | null
}

// --- deterministic signal tables --------------------------------------------------------------
// Generous on purpose (fail-closed): a near-miss should route ONLINE, not local. Hungarian terms are
// included because fleet cards are written in Hungarian.

const CATEGORY_SIGNALS: ReadonlyArray<readonly [NonOffloadableCategory, readonly string[]]> = [
  [
    'security-decision',
    [
      'security', 'secure', 'vulnerab', 'exploit', 'attack', 'threat', 'cve', 'owasp', 'crypto',
      'encrypt', 'decrypt', 'signature', 'signing', 'hash', 'hmac', 'secret', 'password', 'token',
      'credential', 'csrf', 'xss', 'injection', 'sanitiz', 'escap', 'cookie', 'session', 'tls',
      'certificate', 'audit log', 'tamper', 'biztonsag', 'biztonsági', 'sebezhet', 'titok', 'jelszo',
    ],
  ],
  [
    'authz',
    [
      'authz', 'authoriz', 'authentic', 'rbac', 'permission', 'role-', 'roles', 'acl', 'guard',
      'gate ', 'access control', 'privilege', 'superadmin', 'admin-only', 'jogosult', 'hozzafer',
    ],
  ],
  [
    'isolation',
    [
      'tenant', 'multi-tenant', 'isolation', 'rls', 'row-level', 'cross-tenant', 'scope leak',
      'data leak', 'izolacio', 'izoláció', 'berlo',
    ],
  ],
  [
    'architecture',
    [
      'architect', 'design the system', 'system design', 'module boundary', 'port and adapter',
      'schema design', 'db schema', 'migration', 'refactor the', 'restructure', 'architektura',
      'architektúra', 'tervezd meg',
    ],
  ],
  [
    'multi-file-wiring',
    [
      'wire ', 'wiring', 'compose', 'composition root', 'multiple files', 'across files',
      'end-to-end', 'integrate', 'main.ts', 'bekot', 'osszekot', 'több fájl', 'tobb fajl',
    ],
  ],
]

/** Hedge/ambiguity markers: the requester is unsure, so the shape cannot be trusted -> ONLINE. */
const AMBIGUITY_SIGNALS: readonly string[] = [
  'not sure', 'unsure', 'figure out', 'investigate', 'decide whether', 'somehow', 'maybe',
  'nem tudom', 'derits', 'talald ki', 'valamilyen', 'dontsd el',
]

// --- SHAPE signals (Cybersec NO-GO cm6054) -----------------------------------------------------
// The keyword nouns above catch the VOCABULARY of security but not its SHAPE: 9/10 real authz changes
// written in innocuous "mechanical cleanup" language routed LOCAL (default-a-role-to-admin, return-all-
// rows-instead-of-filtering, invert-canAccess, !==-to-===, remove-the-early-return, ...). Those are one
// for one this fleet's own bug classes (access-default, tenant-scope, authz-flip, timing-unsafe compare),
// and the "typo fix" framing invites a LIGHTER re-check downstream -- so the misroute is worst exactly
// where the backstop is weakest. These four rules route ONLINE on the SHAPE of the change, whatever
// vocabulary it uses. False positives here cost tokens; that is the intended direction.
const SHAPE_SIGNALS: ReadonlyArray<readonly [NonOffloadableCategory, RegExp]> = [
  // (a) returning / inverting a boolean about who may DO or SEE something.
  ['authz', /\bcan[a-z]*\s*\(|\bcan[A-Z]/],
  ['authz', /\b(may|can|allowed to|able to|permitted to)\b[^.]{0,40}\b(read|write|see|view|access|edit|delete|list|fetch|modify)\b/],
  ['authz', /\b(invert|negate|flip|reverse)\b[^.]{0,30}\b(boolean|bool|check|result|return|flag|condition)\b/],
  ['authz', /\breturns?\b[^.]{0,25}\b(always\s+)?(true|false)\b/],
  ['authz', /\balways\s+returns?\b/],
  // (b) comparing two values that may be secrets / ids / tokens / hashes.
  ['security-decision', /(!==|===|!=|==)/],
  ['security-decision', /\b(compare|comparison|equality|equals|equal)\b/],
  // (c) modifying / removing / defaulting / loosening an EXISTING check, guard, filter, WHERE,
  //     early-return or middleware. Requires a MUTATION verb + a GUARD noun, so "add a regex that
  //     validates a postal code" (no mutation of an existing control) stays local.
  [
    'authz',
    /\b(remove|removing|delete|deleting|drop|dropping|skip|skipping|bypass|disable|loosen|relax|weaken|simplify|inline|replace|replacing|strip|omit|instead of)\b[^.]{0,60}\b(check|checks|guard|filter|filtering|where clause|where|early return|middleware|validation|predicate|condition|scope|owner|tenant)\b/,
  ],
  [
    'authz',
    /\b(check|guard|filter|where clause|early return|middleware|validation|predicate)\b[^.]{0,60}\b(remove|removed|drop|dropped|skip|skipped|bypass|disabled|loosen|relaxed|weaken|simplif|inline|replaced|pass for everyone|always pass)\b/,
  ],
  // (d) shifting a DEFAULT toward MORE access (privilege-escalating access-default).
  [
    'authz',
    /\b(default|defaults|defaulting|fallback|falls back|when missing|when empty|if absent|on error)\b[^.]{0,60}\b(admin|owner|superuser|root|full access|all rows|all records|everything|everyone|true|allow|grant)\b/,
  ],
  ['isolation', /\ball\s+(rows|records|results|tenants|companies|users)\b/],
  ['security-decision', /\bfail[-\s]?(closed|open)\b/],
]

/** Strip zero-width/control chars and collapse letter-spaced runs ("s e c u r i t y" -> "security")
 *  BEFORE matching, so accidental formatting cannot slip a signal past the tables. */
export function normalizeForMatch(input: string): string {
  const stripped = input
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
  // Join runs of >=3 single letters separated by single spaces.
  return stripped.replace(/\b(?:[a-z]\s){2,}[a-z]\b/g, (run) => run.replace(/\s/g, ''))
}


/** The non-offloadable category a description falls into, or null. Deterministic, no LLM. */
export function classifyCategory(description: string): NonOffloadableCategory | null {
  const text = normalizeForMatch(description)
  for (const [category, needles] of CATEGORY_SIGNALS) {
    for (const needle of needles) if (text.includes(needle)) return category
  }
  // SHAPE match (Cybersec cm6054): catches a security change dressed as mechanical cleanup.
  for (const [category, pattern] of SHAPE_SIGNALS) if (pattern.test(text)) return category
  return null
}

/** Whether the description hedges (caller is unsure) -- fail-closed to ONLINE. */
export function hasAmbiguitySignal(description: string): boolean {
  const text = normalizeForMatch(description)
  return AMBIGUITY_SIGNALS.some((needle) => text.includes(needle))
}

/**
 * Route one task: LOCAL by default, ONLINE only when a non-offloadable category matches, the
 * declared difficulty exceeds the configured threshold, or the input is ambiguous/unusable.
 */
export function routeTask(input: RouteInput): RouteDecision {
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  // Unusable input -> ONLINE (never guess a route from nothing).
  if (description.length === 0) {
    return { route: 'online', reason: 'empty or non-string description (fail-closed)' }
  }

  const category = classifyCategory(description)
  if (category !== null) {
    return { route: 'online', reason: `non-offloadable category: ${category}`, category }
  }

  if (hasAmbiguitySignal(description)) {
    return { route: 'online', reason: 'ambiguous/hedged task shape (fail-closed)' }
  }

  // Difficulty gate -- REUSES the shared taxonomy + slider default; no second threshold copy.
  const threshold =
    normalizeDifficulty(input.threshold) ?? defaultDifficultyForAggressiveness(input.aggressiveness)
  const declared = normalizeDifficulty(input.difficulty)
  if (declared !== null) {
    if (!isDraftableLocally(declared, threshold)) {
      return {
        route: 'online',
        reason: `difficulty '${declared}' exceeds threshold '${threshold}'`,
        difficulty: declared,
      }
    }
    return { route: 'local', reason: `difficulty '${declared}' within threshold '${threshold}'`, difficulty: declared }
  }

  // No declared difficulty and no blocking signal -> the new DEFAULT is local.
  return { route: 'local', reason: `default-local (no blocking signal, threshold '${threshold}')` }
}

/** The levels that can never be offloaded, for callers that want to show the ceiling. */
export const NEVER_OFFLOADABLE_LEVELS: readonly CodingDifficulty[] = CODING_DIFFICULTY_LEVELS.slice(
  CODING_DIFFICULTY_LEVELS.indexOf(RELIABLE_CEILING) + 1,
)
