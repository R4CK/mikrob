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
      // Card 7a23c045 (Cybersec): TOTP/2FA/OTP generation+verification and login rate-limiting are
      // auth-implementation primitives that named none of the words above -- "implement TOTP
      // generation and verification" and "add login rate-limiting" both routed LOCAL with zero
      // matching signal, confirmed by directly probing routeTask before this fix.
      'totp', '2fa', 'two-factor', 'one-time password', 'rate limit', 'rate-limit', 'throttl',
      'brute force', 'brute-force', 'kétfaktoros', 'ketfaktoros',
    ],
  ],
  [
    'authz',
    [
      'authz', 'authoriz', 'authentic', 'rbac', 'permission', 'role-', 'roles', 'acl', 'guard',
      'gate ', 'access control', 'privilege', 'superadmin', 'admin-only', 'jogosult', 'hozzafer',
      // Card 7a23c045: "add step-up verification for high-risk admin actions" routed LOCAL --
      // it only routed ONLINE elsewhere by accidentally co-occurring with "authentication"/
      // "password" in the same sentence, which an adversarial (or just differently-worded) prompt
      // would not repeat.
      'step-up', 'step up',
    ],
  ],
  [
    'isolation',
    [
      'tenant', 'multi-tenant', 'isolation', 'rls', 'row-level', 'cross-tenant', 'scope leak',
      'data leak', 'izolacio', 'izoláció', 'berlo',
      // Card c1661fff: the same isolation defect described with a tenant SYNONYM the fleet's own
      // card language actually uses, rather than the word "tenant" itself.
      'organization', 'organisation', 'company', 'account',
      // Cybered NO-GO on c1661fff (comment 10714): matching is plain substring, so a REGULAR
      // plural (organizations/accounts) already contains its singular and needed no separate
      // entry -- but "company" -> "companies" is an IRREGULAR plural (y -> ies) that does not
      // contain "company" as a substring, so it silently bypassed every rule above. Checked the
      // rest of this bag for the same shape: 'tenant'/'berlo' pluralize regularly in both
      // languages (tenants, bérlők both keep the stem as a substring); 'company' was the only gap.
      'companies',
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
  // --- OUTCOME / POLICY family (Cybersec 2nd NO-GO) -------------------------------------------
  // Rule (c) needs a mutation verb AND a guard NOUN. This family has the verb but names no control
  // artifact -- it states the OUTCOME or POLICY ("grant access", "treat a missing role as owner",
  // "return results unfiltered") instead of the thing being changed ("the guard", "the permission
  // check"). Same act, described by its effect, so (c) never fired and these -- fail-open,
  // access-default, tenant-scope-drop, validation-moved-client -- are the fleet's own highest-
  // frequency defect classes. Deliberately guard-noun-FREE.
  // (1) granting access / letting a request through.
  ['authz', /\b(grant|grants|granting|allow|allows|allowing|permit|permits|permitting|authorize|authorise|let)\b[^.]{0,35}\b(access|request|through|user|users|caller|everyone|anyone|any user)\b/],
  // (2) treating one thing AS a more privileged thing.
  ['authz', /\b(treat|treats|treating|interpret|consider|considers|count|counts|regard|regards|map|maps)\b[^.]{0,45}\bas\b[^.]{0,25}\b(owner|admin|administrator|superuser|root|all|everyone|public|authorized|authorised|valid|trusted|allowed)\b/],
  // (3) ceasing to apply a control -- stated as an activity, not a named artifact.
  ['authz', /\b(stop|stops|stopping|skip|skips|skipping|bypass|bypasses|disable|disables|disabling|drop|drops|dropping|avoid|omit|no longer)\b[^.]{0,35}\b(apply|applying|applies|filter|filters|filtering|check|checks|checking|validat|scoping|scope|restrict)\w*/],
  // (4) an explicitly unscoped/unfiltered result set.
  ['isolation', /\b(unfiltered|unscoped|unrestricted|without filtering|without scoping|without the filter|across all tenants|for all tenants|regardless of (the )?(owner|tenant|site|user|company))\b/],
  // (5) moving a server-side control to an untrusted client.
  ['security-decision', /\b(move|moves|moving|shift|shifts|relocate|push|pushes)\b[^.]{0,45}\b(validation|validate|check|checks|authorization|authorisation|authz|auth|permission)\w*\b[^.]{0,35}\b(client|frontend|front-end|browser|ui)\b/],
  // --- WIDENING family (card c1661fff, Cybered) -------------------------------------------------
  // Every rule above is tuned to the REMOVAL grammar (remove/skip/bypass a check, drop a filter).
  // A row-scope/tenant-isolation removal can just as easily be phrased as an EXPANSION -- nothing
  // is described as removed, so (c) and the OUTCOME family both miss it. Three real cards routed
  // local this way: "return rows for every company, not just the current one"; "widen the query so
  // a foreman sees all crews"; "open any work order, not only their own".
  // (6) an explicit widen/broaden/expand verb next to a scope-shaped noun.
  ['isolation', /\b(widen|widens|widening|broaden|broadens|broadening|expand|expands|expanding)\b[^.]{0,50}\b(quer(?:y|ies)|scope|filter|filtering|access|visibility|results?|rows?|records?|endpoint)\b/],
  // (7) every/all/any + a tenant-or-resource noun, qualified by "not just/only" (or its siblings)
  // -- the noun alone is too generic (any/all USER input is fine), the QUALIFIER is what marks this
  // as a scope being widened past its current boundary rather than a plain plural reference.
  [
    'isolation',
    /\b(every|all|any)\b[^.]{0,40}\b(compan(?:y|ies)|organi[sz]ations?|accounts?|tenants?|crews?|customers?|clients?|records?|rows?|databases?|work\s?orders?)\b[^.]{0,40}\b(not\s+(?:just|only)|instead of|rather than)\b/,
  ],
  // --- BURN/single-use family (card 7a23c045, plural fix: card b215ca62, Cybersec follow-up) -----
  // "burn" alone is too common a word to route on directly (burn rate, burndown, slow burn) -- but
  // "burn" NEAR a one-time-use noun is specifically the exactly-once-redemption security property
  // (a magic link / OTP / recovery token used twice is a replay). Both word orders, matching this
  // file's own established mirrored-pair convention: "mark the ... code as burned" and "burn the
  // magic link" both need to match, and so does "single-use burn semantics" (noun before verb).
  //
  // (token|code|link|otp)? MUST accept the plural too -- \b requires an exact word match, so
  // "burn the magic LINKS"/"the OTPS get burned"/"mark the login CODES as burned" all silently fell
  // through to local (security-critical) until this fix. "token" alone happened to be masked from
  // this specific gap because it is ALSO a separate substring keyword in CATEGORY_SIGNALS above
  // (matches "tokens" as a substring of "token" regardless), but code/link/otp had no such backup.
  [
    'security-decision',
    /\bburn(s|ed|ing)?\b[^.]{0,40}\b(tokens?|codes?|links?|otps?|one-time|single-use|magic)\b/,
  ],
  [
    'security-decision',
    /\b(tokens?|codes?|links?|otps?|one-time|single-use|magic)\b[^.]{0,40}\bburn(s|ed|ing)?\b/,
  ],
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


// Same line-shape gate-dispatch-check.sh already extracts (its GATE_LINE lookup) -- reused here so
// the two never drift on what counts as a Gate: line, even though this file uses it for the
// opposite purpose (removing the line, not reading its value).
const GATE_LINE_RX = /^[ \t]*Gate[ \t]*:[ \t]*.*$/gim

/** Strips the card's own "Gate: ..." metadata line(s) (card 14a73ce6, measured false-positive:
 *  543d62ff). This line names WHO reviews the card ("Gate: QA + Cybersec (biztonsag-relevans
 *  guard tesztlefedettsege...)"), not what the task IS, but routinely carries security vocabulary
 *  the classifier would otherwise read as describing the task's own content -- 2 of 6 measured
 *  false positives (54699bbb, 47bc80e1) were driven entirely by this line. Deliberately narrow:
 *  only removes lines shaped like the fleet's own Gate: convention, nothing else. */
export function stripGateLine(description: string): string {
  return description.replace(GATE_LINE_RX, '').trim()
}

/** The non-offloadable category a description falls into, or null. Deterministic, no LLM. */
export function classifyCategory(description: string): NonOffloadableCategory | null {
  const text = normalizeForMatch(stripGateLine(description))
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
 * Signals that a task is HARD, used only when the caller declared no difficulty.
 *
 * WHY THIS EXISTS (card c7a0c142, Cybersec on the c6cc2c97 gate). Without `--difficulty` the gate
 * below never ran: the threshold reached the REASON STRING and nothing else, so the ceiling applied
 * to whoever declared honestly and not to whoever left the flag off. A control that only binds the
 * cooperative caller is not a control, and this one guards the local 7B's reliability limit.
 *
 * DELIBERATELY NARROW. The fleet directive is to offload aggressively, and a false "too hard" costs
 * a real offload every time it fires. So these match only work that is hard by SHAPE -- several
 * files, a whole module, a schema change carried with its code, a design decision -- never mere
 * length or vocabulary. Anything unmatched keeps today's default-local answer untouched.
 */
const HARDNESS_SIGNALS: ReadonlyArray<readonly [CodingDifficulty, RegExp]> = [
  // Design/architecture asks: the caller wants a decision made, not a function written.
  ['architecture', /\b(design|architect|re-?architect)\b[^.]{0,40}\b(system|architecture|schema|data model|module|service|integration)\b/],
  ['architecture', /\b(architecture|architectural)\b[^.]{0,30}\b(change|refactor|decision|redesign)\b/],
  // Work whose unit is "the whole thing" rather than a named function.
  ['feature', /\b(across|throughout)\b[^.]{0,25}\b(the )?(codebase|repo|repository|app|application|project)\b/],
  ['feature', /\b(multi|several|multiple)[-\s]?(file|files|module|modules|package|packages)\b/],
  ['feature', /\b(end[-\s]?to[-\s]?end|full[-\s]?stack)\b/],
  ['feature', /\b(wire|wiring|hook)\s+up\b[^.]{0,30}\b(route|endpoint|adapter|store|handler|service)\b/],
  // A migration travelling with the code that reads it is never an isolated snippet.
  ['feature', /\bmigration\b[^.]{0,40}\b(and|plus|\+)\b[^.]{0,30}\b(adapter|handler|endpoint|route|store|code)\b/],
  ['feature', /\b(rewrite|overhaul|port)\b[^.]{0,25}\b(the )?(module|package|service|feature|page)\b/],
]

/**
 * The difficulty implied by a description, or null when nothing hard is visible.
 *
 * Returns the HIGHEST level any signal implies -- one architecture-shaped phrase is enough, because
 * the cost of under-calling here is a 7B draft nobody can use.
 */
export function inferDifficulty(description: string): CodingDifficulty | null {
  const text = normalizeForMatch(description)
  let worst: CodingDifficulty | null = null
  for (const [level, pattern] of HARDNESS_SIGNALS) {
    if (!pattern.test(text)) continue
    if (worst === null || CODING_DIFFICULTY_LEVELS.indexOf(level) > CODING_DIFFICULTY_LEVELS.indexOf(worst)) {
      worst = level
    }
  }
  return worst
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

  // No declared difficulty: INFER one rather than skipping the gate (card c7a0c142). Undeclared
  // used to mean unguarded, which made omitting --difficulty the cheapest way past the ceiling.
  const inferred = inferDifficulty(description)
  if (inferred !== null && !isDraftableLocally(inferred, threshold)) {
    return {
      route: 'online',
      reason: `inferred difficulty '${inferred}' exceeds threshold '${threshold}' (undeclared)`,
      difficulty: inferred,
    }
  }
  // Nothing hard visible -> the DEFAULT stays local, as before.
  return inferred === null
    ? { route: 'local', reason: `default-local (no blocking signal, threshold '${threshold}')` }
    : {
        route: 'local',
        reason: `inferred difficulty '${inferred}' within threshold '${threshold}' (undeclared)`,
        difficulty: inferred,
      }
}

/** The levels that can never be offloaded, for callers that want to show the ceiling. */
export const NEVER_OFFLOADABLE_LEVELS: readonly CodingDifficulty[] = CODING_DIFFICULTY_LEVELS.slice(
  CODING_DIFFICULTY_LEVELS.indexOf(RELIABLE_CEILING) + 1,
)
