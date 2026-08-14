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

/**
 * PER-CATEGORY CEILING (card 09c957f7). One global ceiling turned out to be the wrong shape: it is
 * a single number for five categories whose risk is not the same kind at all, so it either sits high
 * enough to be useless or low enough to block work that was never dangerous. The measured symptom is
 * in this file already (see the note at the aggressiveness comment): almost nothing reaches the local
 * model even at RELIABLE_CEILING='feature' and 100% aggressiveness -- the categories veto first, and
 * the global gate never gets a say.
 *
 * So each category carries its own limit, and the two kinds are treated as what they are:
 *   'never'  -- a SECURITY decision. authz, tenant isolation and security-decision stay vetoed
 *               whatever the difficulty: a wrong answer there is not a quality problem, and no
 *               difficulty is low enough to make it one. Card ee43a6ac (advisory-only drafts) is
 *               where that changes, if it changes -- not here, and not as a side effect.
 *   a level  -- a QUALITY limit. multi-file wiring is hard for a 7B, not unsafe for it, so the cap
 *               is 'module': a small, contained piece of a wiring-flavoured task may draft locally,
 *               a genuine multi-file change may not. This is the card's own example, and it is the
 *               only category whose behaviour this change alters.
 * 'architecture' keeps 'never' because the taxonomy it comes from already says so: cross-file design
 * is beyond the model's reliable limit at every difficulty, so a ceiling would be a fiction.
 *
 * The ceiling only ever LOWERS the effective threshold -- it can never raise one. A category cannot
 * buy a task more headroom than the configured slider already allows.
 */
export const CATEGORY_CEILINGS: Readonly<Record<NonOffloadableCategory, CodingDifficulty | 'never'>> = {
  authz: 'never',
  isolation: 'never',
  'security-decision': 'never',
  architecture: 'never',
  'multi-file-wiring': 'module',
}

/** The lower of two difficulty levels -- the ceiling narrows a threshold, never widens it. */
function lowerDifficulty(a: CodingDifficulty, b: CodingDifficulty): CodingDifficulty {
  return CODING_DIFFICULTY_LEVELS.indexOf(a) <= CODING_DIFFICULTY_LEVELS.indexOf(b) ? a : b
}

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
  /**
   * Tags the FLEET has already attached to this work, passed as DATA rather than left in the prose
   * (card 5f0e7aa5). A `SEC` tag is not a word the classifier has to recognise -- it is a decision
   * someone already made about this card, and the router should not have to re-derive it from
   * vocabulary it may not have.
   *
   * Measured on the frozen 561-card board: 155 cards carry a SEC/CYBERSEC tag, 125 already route
   * online, and 30 route LOCAL with `classifyCategory` returning null -- their text contains no
   * signal this file recognises, in either language. Reading six of the least security-looking of
   * those 30, only two are genuinely mechanical, so the tag recovers roughly 25 real security cards
   * at the cost of about 5 mechanical ones going online.
   *
   * FAIL-CLOSED DIRECTION, as the card required: an unknown or absent tag means "no extra signal",
   * never "safe". Text classification runs exactly as before either way.
   */
  readonly tags?: readonly string[] | string
}

/** Tags that mean the fleet declared this work security-relevant. Compared as WHOLE tags, never as
 *  substrings: `[SECTION]` is not `[SEC]`, and the point of taking tags as data is to stop matching
 *  fragments of prose. */
const SECURITY_TAGS: ReadonlySet<string> = new Set(['SEC', 'CYBERSEC', 'SECURITY'])

/**
 * The leading run of `[...]` tags a fleet card title carries -- `[100%][MikroB][SEC][LOW] title...`
 * -> ['100%', 'MIKROB', 'SEC', 'LOW'].
 *
 * ONLY the leading run, and only whole tags. That is what makes this different from grepping a title
 * for "[SEC]": a card whose PROSE quotes another card's `[SEC]` marker mid-sentence contributes
 * nothing here, which is exactly the free-text brittleness the card warned against.
 *
 * This lives here rather than in the caller so both the extraction rule and the decision it feeds
 * are testable in one place; the CALLER decides where tags come from (a real kanban label when one
 * exists, this title convention until then).
 */
export function titleTags(title: string): string[] {
  const lead = /^(?:\s*\[[^\]]*\])+/.exec(typeof title === 'string' ? title : '')
  if (!lead) return []
  return [...lead[0].matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]!.trim().toUpperCase()).filter(Boolean)
}

/**
 * Whether the caller handed us a tag that declares this work security-relevant.
 *
 * ACCEPTS A STRING TOO, and refuses everything else LOUDLY (Cybersec's LOW on 0603450). The first
 * version required an array, which made two malformed inputs behave in opposite ways: `'SEC'` -- the
 * likelier caller mistake, since the shell path carries a comma-separated string right up to the
 * boundary -- returned false and the signal vanished in silence, while `[['SEC']]` DID fire, because
 * String(['SEC']) is 'SEC'. A card about a silent gap letting 30 cards through should not ship one.
 *
 * A throw is the right kind of loud here rather than a returned false: the only caller is the router
 * below, whose shell wrapper turns an exception into `router-error` -> ONLINE. So a malformed tag
 * list fails towards Claude and says why, instead of quietly reading as "no security tag".
 */
export function hasSecurityTag(tags: readonly string[] | string | undefined | null): boolean {
  if (tags === undefined || tags === null) return false
  const list = typeof tags === 'string' ? tags.split(',') : tags
  if (!Array.isArray(list)) {
    throw new TypeError(`tags must be a string or an array of strings, got ${typeof tags}`)
  }
  return list.some((t) => {
    if (typeof t !== 'string') {
      throw new TypeError(`tags must contain strings, got ${Array.isArray(t) ? 'an array' : typeof t}`)
    }
    return SECURITY_TAGS.has(t.trim().toUpperCase())
  })
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
      // Same short-stem sweep as the authz bag above (card 09c957f7). 'vuln' and 'creds' are the
      // written-down forms in real cards; the long ones ('vulnerab', 'credential') are already here
      // but do not contain them. Deliberately NOT added: 'cert' (fires inside "certain"), 'perm'
      // ("permanent"), 'priv' ("private") and 'sig' ("significant") -- each would trade a rare real
      // hit for constant false ones on ordinary prose, and this bag is read on EVERY card.
      'vuln', 'creds',
    ],
  ],
  [
    'authz',
    [
      'authz', 'authoriz', 'authentic', 'rbac', 'permission', 'role-', 'roles', 'acl',
      'access control', 'privilege', 'superadmin', 'admin-only', 'jogosult', 'hozzafer',
      // Card 7a23c045: "add step-up verification for high-risk admin actions" routed LOCAL --
      // it only routed ONLINE elsewhere by accidentally co-occurring with "authentication"/
      // "password" in the same sentence, which an adversarial (or just differently-worded) prompt
      // would not repeat.
      'step-up', 'step up',
      // SHORT STEMS (card 09c957f7, QA2 + QA independently). The bag held only the LONG forms
      // 'authoriz' and 'authentic', so "Wire the new auth middleware into main.ts" matched neither
      // and fell through to multi-file-wiring -- which used to be an unconditional veto and is now a
      // ceiling, so the gap turned from harmless into a route to the local model. 'auth' covers
      // auth/authn/authz/authoriz*/authentic* in one stem; the matcher's lookbehind means it does
      // NOT fire inside 'oauth', so that needs its own entry. The rest are abbreviations that
      // contain no long form at all: a card can say jwt/sso/mfa and never write the word out.
      //
      // The cost is measured, not hand-waved: 'auth' also fires on 'author', which routes an
      // authoring task online. That is the fail-closed direction (it costs tokens, never safety),
      // and on the live board it is worth exactly one card -- see the card's REVIEW.
      'auth', 'oauth', 'jwt', 'sso', 'mfa', 'privesc',
      // 2026-08-13: bare 'guard' and 'gate ' REMOVED -- measured false-positive on THIS fleet's own
      // dialect, where "gate" means the QA/Cybersec/Cybered review checkpoint (every card carries a
      // "Gate: ..." line -- already stripped by stripGateLine, but prose ALSO says things like "a
      // QA/gate bizonyíték" or "gate kartyánként: qa + cy...") and "guard" means any code-level safety
      // net (redispatch-guard.sh, "a repo saját guard-tesztje bukik", no-floating-promises guard).
      // Probed live: 3 same-day cards (ad78347c, 39d591b4, 85c867bf) each routed ONLINE purely on one
      // of these two words, none touching authorization -- a meaningful slice of why local-LLM
      // offload sees so few cards despite RELIABLE_CEILING='feature' and aggressiveness=100.
      // Genuine guard/gate MUTATIONS (removing, bypassing, disabling an existing check) are still
      // caught by the SHAPE_SIGNALS rule below regardless of wording; a direct authz-guard MENTION is
      // still caught by these narrower compound phrases.
      'auth guard', 'authz guard', 'access guard', 'rbac guard', 'permission guard', 'route guard',
      'security gate', 'access gate', 'auth gate',
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
  // DECISION verbs added 2026-08-13 (card 6fbf42bb). The list was purely about READING and EDITING,
  // so an authorization question phrased around a decision -- approve, reject, deny, grant, revoke --
  // matched nothing here. Measured on the real router before the change:
  //     "Which roles should be allowed to approve a shift?"        -> ONLINE  (only via the bare
  //                                                                   `roles` needle, incidentally)
  //     "Which user GROUPS should be allowed to approve a shift?"  -> LOCAL   <-- a real RBAC
  //                                                                   design question, routed local
  //     "Which user groups should be allowed to VIEW a shift?"     -> ONLINE  (verb list has `view`)
  // The same question, same meaning, differing only in whether it happened to contain the word
  // "roles". That made the protection vocabulary-dependent rather than semantic, and it was a LIVE
  // hole -- not merely a precondition for narrowing the `roles` needle later.
  ['authz', /\b(may|can|allowed to|able to|permitted to)\b[^.]{0,40}\b(read|write|see|view|access|edit|delete|list|fetch|modify|approve|reject|deny|grant|revoke)\b/],
  ['authz', /\b(invert|negate|flip|reverse)\b[^.]{0,30}\b(boolean|bool|check|result|return|flag|condition)\b/],
  ['authz', /\breturns?\b[^.]{0,25}\b(always\s+)?(true|false)\b/],
  ['authz', /\balways\s+returns?\b/],
  // (b) comparing two values that may be secrets / ids / tokens / hashes.
  //
  // The operator alone used to be enough, which was a far broader rule than the intent it was
  // written for. MEASURED on the live board: of the 117 cards still classified security-decision,
  // only FIVE contain a comparison operator at all, and every sampled one is ordinary code --
  // `sites.length === 0` for an empty state, `status === 404 || status === 0` for HTTP handling,
  // `err.code === invalid_receiving`, and a Hungarian sentence containing "commit!=elo". Not one
  // was a secret comparison. So the rule was contributing false positives and no visible true
  // positives, while being untouchable by the word-boundary/qualifier work (card c26a9064) because
  // it matches PUNCTUATION -- there is nothing for a word boundary to attach to.
  //
  // Narrowed to what it was for: an equality check where one side is a SENSITIVE value. A timing
  // -unsafe comparison of a token or digest is the real hazard; comparing a list length is not.
  // TRAILING guard only, no leading \b -- Cybered NO-GO on d1027d5a. normalizeForMatch lowercases,
  // so `userToken` arrives as `usertoken` and a leading \b never fires: the codebase's own camelCase
  // hid every identifier-shaped secret. Measured before the fix: `token !== provided` ONLINE but
  // `userToken !== provided` and `apiKey === suppliedValue` both LOCAL.
  //
  // `(?![a-z0-9])` keeps the word from matching mid-identifier -- `key` still does not fire inside
  // "keyboard", `token` not inside "tokenize", `sig` not inside "design" -- while allowing it as an
  // identifier SUFFIX, which is exactly how these values are named.
  ['security-decision', /(!==|===|!=|==)[^.]{0,40}(token|secret|password|passwd|hash|digest|signature|sig|hmac|key|nonce|otp|credential|salt)(?![a-z0-9])/],
  ['security-decision', /(token|secret|password|passwd|hash|digest|signature|sig|hmac|key|nonce|otp|credential|salt)(?![a-z0-9])[^.]{0,40}(!==|===|!=|==)/],
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
  // --- TRUST-DECISION family (card b55a3980) ----------------------------------------------------
  // Deciding whether an ARTIFACT may be installed or run is an authorization question about code
  // rather than about a user, and nothing in this file spoke that language: `trust`, `bizalmi` and
  // `telepit` appeared in no table at all. Two live cards proved the gap -- separating the TRUST
  // list from the RELEVANCE list (eb843c46: "a bizalmi listan kivuli modell CSAK explicit
  // operator-megerositessel telepulhet"), and splitting the catalogue's provenance field
  // (87d7c86f) -- both routed LOCAL on their own text and were reaching the 7B for a decision about
  // what this box may execute.
  //
  // COST, measured on the frozen 561-card board rather than argued: 6 cards match, 3 of which
  // already route online; the 3 it moves are eb843c46, 87d7c86f and fa8959cd, every one of them a
  // [SEC]-labelled trust-decision card. The reverse-order rule adds d730070e, a34effcb (both [SEC])
  // and 61a4a85f -- the model-picker UI, which is where the trust evidence is shown to the operator,
  // and eb843c46's own words for getting that screen wrong are "nem dontes hanem atkattintas".
  [
    'security-decision',
    /\b(trust|trusted|untrusted|trustworthy|bizalmi|megbizhato|megbízható)\w*\b[^.]{0,60}\b(list|lista|allowlist|allow-list|decision|dontes|döntés|install|installable|telepit|telepít|execute|run)\w*/,
  ],
  [
    'security-decision',
    /\b(install|installable|telepit|telepít|execute)\w*\b[^.]{0,60}\b(trust|trusted|untrusted|bizalmi|megbizhato|megbízható)\w*/,
  ],
  // --- INVISIBLE-TO-A-CONTROL family (card b55a3980) ---------------------------------------------
  // Rule (3) above catches CEASING to apply a control ("bypass the check"). It does not catch the
  // other half: the control still runs, and something is structurally invisible to it. Card
  // 46c4ad4a is exactly that -- a scheduler command hidden in a masked heredoc "TELJESEN lathatatlan
  // a SCHEDULER_RX ellenorzesnek", so a crontab/at/systemd-run line "eszrevetlenul athaladhat" the
  // self-pace gate. Changing what a control can SEE is a security decision even when no check is
  // removed, and the fleet writes this in Hungarian, where none of the removal grammar applies.
  //
  // `silently` was in the first draft of this rule and is NOT here: measured, it dragged in
  // 7cc8641a ("silently-dead scheduled tasks"), a plain maintenance card, because "silently" is
  // about how a FAILURE is reported far more often than about evading a control. Without it the
  // rule moves exactly one card on the whole board -- 46c4ad4a, the one it was written for.
  [
    'security-decision',
    /\b(invisible|unnoticed|undetected|unseen|lathatatlan|láthatatlan|eszrevetlen|észrevétlen|rejtve|rejtett)\w*\b[^.]{0,70}\b(check|checks|guard|gate|detector|detect|scan|scanner|validation|ellenorz|ellenőrz|detektor|szur|szűr)\w*/,
  ],
  [
    'security-decision',
    /\b(athalad|áthalad|atmegy|átmegy|slip|slips|slipped|sneak|sneaks)\w*\b[^.]{0,70}\b(check|guard|gate|detector|scan|validation|ellenorz|ellenőrz|detektor|szur|szűr)\w*/,
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

/**
 * Needles that are AMBIGUOUS IN THIS FLEET'S OWN DIALECT and therefore only count when a domain
 * qualifier sits near them. Measured over the 145 cards the classifier put in `security-decision`:
 *
 *     needle     cards   with NO auth word within +/-60 chars
 *     token        40     32  (80%)  -- LLM token COST, an `id_token` regex variable, token-in-argv
 *     session      28     21  (75%)  -- a tmux session, a Claude session, a SessionStart hook
 *
 * A bare substring match on these routes ordinary infra work online and starves the local model of
 * exactly the mechanical cards it should be drafting. This is a recurring class, not a one-off:
 * `guard` and `gate ` were deleted from the authz needles on 2026-08-13 for the same reason, one
 * word at a time, which treats instances and leaves the class.
 *
 * The qualifier lists are deliberately GENEROUS. A false negative here sends a real security card to
 * the local model; a false positive costs one online draft. Those are not symmetric, so when in
 * doubt a word stays in.
 */
// THREE SECURITY VOCABULARIES, named. Card c26a9064 was NO-GO'd because a qualifier list carries
// only as much vocabulary as its author happened to think of, and that failed three times in a row
// on the SAME shape:
//   1. `login` missing from the token list        -- found by the manual read (B.5)
//   2. isolation words missing from account/org   -- found by Cybered's pre-existing c1661fff test
//   3. predictability words missing from token/session -- found by Cybered's probes on this card
//        "the invite token is guessable" / "token entropy is too low" / "the session id is sequential"
//        all reclaimed to local, and all three are textbook security work.
//
// Patching a third list would invite a fourth. So the axes are named ONCE, and each ambiguous needle
// declares WHICH of them it can legitimately appear in. Adding a word later means adding it to an
// AXIS, where every needle that shares that axis gets it -- rather than to one list that happens to
// be the one someone was looking at.
// The axes carry HUNGARIAN terms too. The fleet's cards are written in Hungarian at least as often
// as English, and an English-only qualifier list silently reclaims every Hungarian-worded security
// card. Found in the same full read: 5b6dd606 ("futasideju token-in-argv ellenorzes ... elo
// SZIVARGAS van a lemezen") carries `token` with a leak qualifier -- in Hungarian, so nothing fired.
const V_AUTH =
  'auth|bearer|refresh|access|reset|magic|csrf|oauth|jwt|api ?key|secret|credential|login|log ?in|logout|sign ?in|revoke|expir|verify|sign|permission|privilege|impersonat' +
  '|jogosult|hozzafer|hitelesit|belepes|azonosit|titok|jelszo|kulcs'
const V_ISOLATION =
  'tenant|cross|across|between|leak|share|shar|scope|isolat|other|foreign|boundary|member' +
  '|szivarg|berlo|hataron|elkulonit|megosztas|kereszt'
// STRENGTH is the axis that was missing entirely: it is about whether a secret is HARD TO GUESS,
// which is a security decision even when no auth or isolation word appears anywhere in the sentence.
const V_STRENGTH =
  'guessab|predictab|entropy|random|sequential|brute|enumerat|collision|weak|rotat|timing|constant.?time|length|bytes|bits' +
  '|kitalalhato|megjosolhato|gyenge|veletlen|sorszamoz'
const V_CRYPTO = 'password|passwd|token|secret|signature|hmac|digest|integrity|chain|tamper|salt|bcrypt|argon|sha[0-9]'
// CRYPTO WEAKNESS is not CRYPTO CONSTRUCTION. Cybered's fifth same-shape case: the hash list named
// only what a scheme is BUILT from, so "we use sha1 for the hash" fired (sha[0-9] matched by
// accident) while "we use md5 for the hash" did not -- the same decision, opposite routes, and the
// difference had nothing to do with risk.
const V_WEAK = 'md5|sha-?1|des\\b|rc4|deprecat|legacy|outdated|obsolete'
// A FOURTH AXIS the first three missed: changing a security object's STRENGTH, LIFETIME, OWNERSHIP
// or EXISTENCE. Cybersec's six sentences all have this shape and all routed local -- "switch the
// hash to something STRONGER", "MAKE the session LAST LONGER", "SHORTEN how long the token stays
// valid", "DELETE the account", "MERGE two accounts", "MOVE a user to a different organization".
// The nouns were covered; the verb applied to them was not, so the decision was invisible.
const V_CHANGE =
  'stronger|strength|weaker|longer|shorter|shorten|extend|increase|decrease|raise|lower' +
  '|delete|remove|purge|erase|merge|move|transfer|reassign|different|another' +
  '|lifetime|ttl|duration|stays valid|valid for|last longer|expiry'

const axes = (...v: string[]): RegExp => new RegExp(v.join('|'))

const QUALIFIERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['token', axes(V_AUTH, V_ISOLATION, V_STRENGTH, V_CHANGE)],
  ['session', axes(V_AUTH, V_ISOLATION, V_STRENGTH, V_CHANGE, 'cookie|hijack|fixation')],
  ['hash', axes(V_CRYPTO, V_STRENGTH, V_WEAK, V_CHANGE)],
  ['account', axes(V_AUTH, V_ISOLATION, V_CHANGE, 'takeover|lockout|register|owner')],
  ['organization', axes(V_ISOLATION, V_AUTH, V_CHANGE, 'rbac')],
  ['organisation', axes(V_ISOLATION, V_AUTH, V_CHANGE, 'rbac')],
  ['compose', /docker|container|stack|orchestrat/],
  ['roles', axes(V_AUTH, 'rbac|allowed|grant|assign|admin|approve|deny')],
]
const QUALIFIER_WINDOW = 80

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Does this needle appear as a WORD, and -- when it is one of the ambiguous ones -- with a qualifier
 * nearby? Word-boundary matching alone already removes a class of nonsense (`escap` inside
 * "landscape"); the qualifier window removes the fleet-dialect class the measurement above found.
 */
function needleFires(text: string, needle: string): boolean {
  // NOT `\b`. Identifiers use `_` and `-` as separators, and both are... `_` is a WORD character, so
  // `\bprivilege` does NOT match inside `has_table_privilege`. That cost a real card: 187e29d9
  // ("derived privilege guard -- has_table_privilege + SET ROLE") is a database-grant verification
  // card, it was classified `authz` before this work, and word-boundary matching reclaimed it to
  // local. Found by the FULL manual read of the reclaimed set, not by any probe.
  //
  // `(?<![a-z0-9])` keeps what the boundary was for -- `scap` still does not match inside
  // "landscape", because the preceding char is a letter -- while firing after `_`, `-`, `.`, `/`
  // and whitespace, which is where identifiers actually put their separators.
  const rx = new RegExp('(?<![a-z0-9])' + escapeRx(needle), 'g')
  const qualifier = QUALIFIERS.find(([n]) => n === needle)?.[1]
  let m: RegExpExecArray | null
  while ((m = rx.exec(text)) !== null) {
    if (!qualifier) return true
    const from = Math.max(0, m.index - QUALIFIER_WINDOW)
    const window = text.slice(from, m.index + needle.length + QUALIFIER_WINDOW)
    if (qualifier.test(window)) return true
  }
  return false
}

/** The non-offloadable category a description falls into, or null. Deterministic, no LLM. */
/**
 * Categories matched on the TASK STATEMENT only, not on the whole card (card a7accbfb).
 *
 * On this board a description carries far more than the request: gate verdicts, incident history,
 * token-cost notes, quoted logs. Those are ABOUT the work, not the work -- and a word like "wire"
 * or "migration" in a quoted postmortem said nothing about what is being asked now.
 *
 * WHICH categories get this treatment is the whole safety question, and the answer is the same split
 * the ceilings use: only the QUALITY ones. If a security signal appears forty lines down -- in a
 * quoted requirement, a gate's own finding, a log line showing a token -- that is exactly the case
 * this router exists to catch, and narrowing its reading window would be a false negative in the one
 * direction that costs something real. So authz, isolation and security-decision keep reading
 * EVERYTHING; architecture and multi-file-wiring read the statement.
 */
const STATEMENT_SCOPED_CATEGORIES: ReadonlySet<NonOffloadableCategory> = new Set([
  'architecture',
  'multi-file-wiring',
])

/** How much of a description counts as the statement: the title line plus the first paragraph. */
const STATEMENT_MAX_CHARS = 600

/**
 * The task statement: the first line (a card title, or the whole prompt when there is one line) plus
 * the paragraph that follows it, capped. Everything after the first blank line that ends that
 * paragraph is context, not request.
 */
export function taskStatement(description: string): string {
  const lines = String(description ?? '').split('\n')
  const out: string[] = []
  let started = false
  for (const line of lines) {
    const blank = line.trim().length === 0
    if (blank) {
      if (started) break // the first paragraph has ended
      continue // leading blank lines are not the end of anything
    }
    started = true
    out.push(line)
    if (out.join('\n').length >= STATEMENT_MAX_CHARS) break
  }
  return out.join('\n').slice(0, STATEMENT_MAX_CHARS)
}

export function classifyCategory(description: string): NonOffloadableCategory | null {
  const text = normalizeForMatch(stripGateLine(description))
  const statement = normalizeForMatch(stripGateLine(taskStatement(description)))
  const textFor = (category: NonOffloadableCategory): string =>
    STATEMENT_SCOPED_CATEGORIES.has(category) ? statement : text

  // Keywords first, then SHAPE (Cybersec cm6054: a security change dressed as mechanical cleanup
  // names no security noun, so it is only reachable by shape) -- but both restricted to `admits`.
  const matchWithin = (
    admits: (category: NonOffloadableCategory) => boolean,
  ): NonOffloadableCategory | null => {
    for (const [category, needles] of CATEGORY_SIGNALS) {
      if (!admits(category)) continue
      const hay = textFor(category)
      for (const needle of needles) if (needleFires(hay, needle)) return category
    }
    for (const [category, pattern] of SHAPE_SIGNALS) {
      if (!admits(category)) continue
      if (pattern.test(textFor(category))) return category
    }
    return null
  }

  // RISK ORDER, NOT TABLE ORDER (Cybersec F1 on this card). Running every keyword bag before any
  // shape rule meant the LAST keyword bag outranked the FIRST shape rule: "Wire the list handler
  // into main.ts so it returns all rows regardless of the owner" matched multi-file-wiring on the
  // word `wire` and never reached the isolation shape underneath. Harmless while wiring was an
  // unconditional veto -- both answers routed online -- but once wiring got a CEILING, the shadowed
  // sentence became a path to the 7B, and the shape family is precisely the defence that exists for
  // sentences with no security noun in them. So: everything that still vetoes gets both passes
  // first, and only then the categories that merely cap.
  //
  // WHICH ones veto is DERIVED from the ceiling table, never a second list. A hand-kept copy would
  // silently stop matching the moment a category's ceiling changes (ee43a6ac is about to change
  // one), and the failure would be invisible -- the order would just quietly go back to wrong.
  const vetoes = (category: NonOffloadableCategory): boolean => CATEGORY_CEILINGS[category] === 'never'
  return matchWithin(vetoes) ?? matchWithin((category) => !vetoes(category))
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

  // A DECLARED tag outranks every inference below it (card 5f0e7aa5). Everything else in this file
  // guesses what the work is from its wording; this is the one input where somebody already decided.
  // It is checked FIRST so the answer does not depend on whether the prose happens to carry a word
  // the tables know -- which for 30 SEC-tagged cards on the live board, it does not.
  if (hasSecurityTag(input.tags)) {
    return { route: 'online', reason: 'declared security tag on the card (fleet decision, not inferred)' }
  }

  const category = classifyCategory(description)
  const categoryCeiling = category === null ? null : CATEGORY_CEILINGS[category]
  if (category !== null && categoryCeiling === 'never') {
    return { route: 'online', reason: `non-offloadable category: ${category}`, category }
  }

  if (hasAmbiguitySignal(description)) {
    return { route: 'online', reason: 'ambiguous/hedged task shape (fail-closed)' }
  }

  // Difficulty gate -- REUSES the shared taxonomy + slider default; no second threshold copy.
  // A matched category with a LEVEL ceiling narrows that threshold (card 09c957f7): the task is not
  // vetoed, it is held to what the model can do in that kind of work. Narrowing only -- taking the
  // lower of the two means a category can never hand a task more headroom than the slider allows.
  const configured =
    normalizeDifficulty(input.threshold) ?? defaultDifficultyForAggressiveness(input.aggressiveness)
  const threshold =
    categoryCeiling === null || categoryCeiling === 'never'
      ? configured
      : lowerDifficulty(configured, categoryCeiling)
  // When a category narrowed the threshold, say so in the reason and carry the category on the
  // decision: otherwise the audit line reads "exceeds threshold 'module'" and nobody can tell
  // whether that was the operator's slider or the category's own limit.
  // TWO DIFFERENT QUESTIONS, and conflating them cost a round: `inCappedCategory` is "this category
  // carries a ceiling at all" (which decides whether inference may be trusted), while `capped` is
  // "the ceiling actually lowered the configured threshold" (which only decides how the reason
  // reads). With one flag doing both, a slider already stricter than the ceiling made the category
  // rule vanish -- and the pinned multi-file-wiring case went local.
  const inCappedCategory = category !== null && categoryCeiling !== null && categoryCeiling !== 'never'
  const capped = inCappedCategory && threshold !== configured
  // The case that used to fall out of the audit line entirely (Cybersec's note on card 09c957f7):
  // when the slider is ALREADY stricter than the ceiling, nothing gets "capped", so the reason read
  // like an ordinary slider decision -- in precisely the situation where the interesting fact is
  // that this category stopped vetoing. That is the sentence we will be looking for in an incident,
  // so it says so.
  //
  // COMPOSED, NOT SPLICED (card 6034941c). This used to be a fragment that borrowed the caller's
  // surrounding quotes -- `${threshold}' (capped by category '${category}` dropped into
  // `threshold '${why}'` -- so the quote that was meant to close the THRESHOLD ended up closing the
  // category instead, the parenthesis never closed at all, and on the undeclared branch a stray
  // apostrophe landed in front of "(undeclared)". Six live cards printed it. My own histogram tool
  // found it on its first run, which is the argument for the tool: nobody reads an audit line until
  // an incident, and then it is the only thing to read. The note now carries its own quotes and
  // brackets, and the call sites interpolate it whole.
  const thresholdNote = capped
    ? `'${threshold}' (capped by category '${category}')`
    : inCappedCategory
      ? `'${threshold}' (category '${category}' caps but no longer vetoes)`
      : `'${threshold}'`
  const cat = category === null || categoryCeiling === 'never' ? {} : { category }
  const declared = normalizeDifficulty(input.difficulty)
  if (declared !== null) {
    if (!isDraftableLocally(declared, threshold)) {
      return {
        route: 'online',
        reason: `difficulty '${declared}' exceeds threshold ${thresholdNote}`,
        difficulty: declared,
        ...cat,
      }
    }
    return { route: 'local', reason: `difficulty '${declared}' within threshold ${thresholdNote}`, difficulty: declared, ...cat }
  }

  // No declared difficulty: INFER one rather than skipping the gate (card c7a0c142). Undeclared
  // used to mean unguarded, which made omitting --difficulty the cheapest way past the ceiling.
  const inferred = inferDifficulty(description)
  if (inferred !== null && !isDraftableLocally(inferred, threshold)) {
    return {
      route: 'online',
      reason: `inferred difficulty '${inferred}' exceeds threshold ${thresholdNote} (undeclared)`,
      difficulty: inferred,
      ...cat,
    }
  }
  // Nothing hard visible -> the DEFAULT stays local, as before -- EXCEPT inside a capped category.
  // There, absence of a difficulty signal is not evidence of easiness: the text already matched a
  // category the model struggles with, and these descriptions are exactly the ones with no explicit
  // difficulty word in them. A capped category therefore needs POSITIVE evidence that the piece is
  // small (a declared difficulty, or an inferred one within the ceiling); with none, it stays
  // online, which is also what this router did for the whole category before the ceiling existed.
  if (inCappedCategory) {
    // INSIDE A CAPPED CATEGORY, ONLY A DECLARED DIFFICULTY COUNTS. Inference is not evidence here,
    // and that is measured rather than assumed: the suite's own multi-file-wiring case ("Wire the
    // new store into main.ts and the composition root") infers something within 'module' and would
    // have started drafting locally -- a genuinely two-file change reading as a single-file one.
    // The inferrer under-reads exactly the texts this category is made of, so the caller has to
    // state the size. With no declaration the route is what it was before the ceiling existed.
    return {
      route: 'online',
      reason: `category '${category}' caps at '${categoryCeiling}'; no DECLARED difficulty, and inference is not trusted inside a capped category (fail-closed)`,
      ...cat,
      ...(inferred === null ? {} : { difficulty: inferred }),
    }
  }
  return inferred === null
    ? { route: 'local', reason: `default-local (no blocking signal, threshold ${thresholdNote})`, ...cat }
    : {
        route: 'local',
        reason: `inferred difficulty '${inferred}' within threshold ${thresholdNote} (undeclared)`,
        difficulty: inferred,
        ...cat,
      }
}

/** The levels that can never be offloaded, for callers that want to show the ceiling. */
export const NEVER_OFFLOADABLE_LEVELS: readonly CodingDifficulty[] = CODING_DIFFICULTY_LEVELS.slice(
  CODING_DIFFICULTY_LEVELS.indexOf(RELIABLE_CEILING) + 1,
)
