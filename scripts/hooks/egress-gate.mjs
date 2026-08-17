#!/usr/bin/env node
// PreToolUse hook: WebFetch egress allowlist enforcement.
//
// Any WebFetch call from the main agent must target a known, legitimate API
// endpoint. Arbitrary web content (RSS feeds, docs, news pages, public APIs
// not in the allowlist) MUST go through the quarantine-reader sub-agent
// instead, so the fetched content is quarantined, wrapped, and never executed
// as instructions in the main agent's context.
//
// Two-tier allowlist:
//   1. Built-in (ALLOWED_PREFIXES): hard-coded, always enforced.
//   2. Runtime (store/egress-allowlist.json): operator-managed, loaded on each
//      invocation. Shape: { "domains": ["example.com"], "prefixes": ["https://host/path/"],
//      "quarantine_domains": ["feeds.example.org"] }. All keys optional. Missing file or
//      malformed JSON -> treated as empty lists (FAIL-OPEN on the file, FAIL-SAFE on the
//      decision: the built-in list still guards; no extra URLs are allowed merely because
//      the file is missing).
//
// When a URL is not on any allowlist tier:
//   - The tool call is HARD-BLOCKED (decision: deny).
//   - The blocked call is appended to EGRESS_BLOCK_LOG for operator review.
//   - The operator can approve the URL/domain: add it to store/egress-allowlist.json,
//     then re-run the call. No restart required.
//
// The log is separate from the main Marveen log so operators can grep it
// independently: `tail -f store/egress-blocked.log`
//
// Scope: this guard covers the Claude Code WebFetch tool AND the Firecrawl MCP fetch
// tools (card 91c4a369, Cybersec blocking precondition 4). It does NOT intercept
// WebSearch or curl/Bash network calls; those channels are out of scope for this hook
// mechanism and require separate controls if needed.
//
// WHY THE FIRECRAWL TOOLS ARE HERE. The condition below used to read
// `toolName !== 'WebFetch'`, so a Firecrawl scrape carried no URL past this
// gate at all -- the allowlist simply did not apply to it, and the fleet's
// first unwrapped external-content channel would have been ungated on the one
// axis that matters. `firecrawl_scrape` and `firecrawl_map` both take a
// required `url` (measured in the pinned firecrawl-mcp@3.24.0 dist:
// `scrapeParamsSchema = z.object({ url: z.string().url(), ... })` and
// `parameters: z.object({ url: z.string().url(), search?, sitemap?, ... })`),
// so the SAME hostname rules apply to them. NOT "unchanged", which is what this
// comment used to say: `url` turned out to be only one of the ways a scrape
// reaches the network, and the hostname rules judge only that one. See
// FIRECRAWL_SCRAPE_ALLOWED_KEYS below for the second channel and the fix.
//
// THE FIRECRAWL NAMESPACE IS DEFAULT-DENY, not an allowlist of two exceptions
// bolted onto a default-allow. Everything under `mcp__firecrawl__` that is not
// scrape or map is BLOCKED here, for two measured reasons:
//   * `firecrawl_search` cannot be gated by a URL allowlist even in principle:
//     its schema has no `url` (it is `searchToolBaseFields` plus
//     `scrapeParamsSchema.omit({ url: true })`), and the server's own
//     annotation says `openWorldHint: true`, "arbitrary domains and sources".
//     Its optional `includeDomains`/`excludeDomains` do not rescue it -- they
//     are model-supplied and can simply be omitted.
//   * the server exposes 27 tools, and the rest create or drive REMOTE state
//     (monitor_create/_delete/_run, agent, interact, crawl). The
//     quarantine-reader sub-agent's `tools:` line restricts THAT sub-agent, not
//     the main agent, which can reach every tool the server offers. So the
//     tools line is a scope decision and this is the enforcement.
// A default-allow here would mean each of the other 25 stays reachable until
// someone remembers to name it, which is the shape of every gap this file
// exists to close.
//
// THE QUARANTINE TIER. The block message above tells the caller to fetch through the
// quarantine-reader sub-agent -- and until this tier existed, this same hook blocked that
// sub-agent too, so the escape hatch the gate prescribed was one the gate closed
// (kanban #224). A sub-agent's PreToolUse payload carries a field a main agent's does
// not: `agent_type` (measured 2026-08-03). `agentType` is what separates the tiers, and
// it gates BOTH channels this file judges -- WebFetch and the two URL-bearing Firecrawl
// tools -- because the quarantine-reader sub-agent's own `tools:` line lists
// firecrawl_scrape/firecrawl_map alongside WebFetch; a tier that only widened WebFetch
// would leave the sub-agent's other declared tool still hitting the ordinary allowlist.
//
// FAIL-CLOSED: only an exact `agent_type` match opens this tier. A missing, empty,
// unknown or misspelled value is treated as a main agent, i.e. blocked. A mistake here
// can only deny a fetch, never grant one.
//
// The domain list mirrors the one in the sub-agent's own definition
// (templates/sub-agents/quarantine-reader.md). That copy is a promise the sub-agent
// makes to itself in its prompt; this one is enforcement. Keep them in step -- and when
// they disagree, this file is the one that decides.
//
// AUDITED, NOT SILENT. The quarantine tier is the one grant a main agent cannot obtain,
// so every use of it (WebFetch or a Firecrawl scrape/map) leaves an ALLOWED_QUARANTINE
// line next to the denials -- the ordinary allowlist tiers stay quiet, same as before.

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { allow, deny, isInvokedDirectly } from '../hook-lib.mjs'

// Derive repo root from this script's location (scripts/hooks/egress-gate.mjs).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EGRESS_BLOCK_LOG = join(REPO_ROOT, 'store', 'egress-blocked.log')
const RUNTIME_ALLOWLIST_PATH = join(REPO_ROOT, 'store', 'egress-allowlist.json')

// Dashboard port: env WEB_PORT, else the install .env, else the 3420 default.
// A fixed 3420 in the allowlist below blocked the agent's own dashboard as soon
// as the install moved to another port.
// SECURITY: the value is interpolated into an allowlist PREFIX (`http://localhost:${PORT}/`), so it
// must be digits ONLY. An unvalidated value containing `@` turns the whole `localhost:<value>` part
// into a URL userinfo section -- `http://localhost:3420@evil.com/` resolves to host evil.com, which
// would put an attacker-chosen host on the built-in allowlist and defeat the egress gate entirely.
// Anything that is not 1-5 digits is rejected and falls back to the default port.
const isValidPort = (v) => /^\d{1,5}$/.test(v)
const DASHBOARD_PORT = (() => {
  const fromEnv = process.env['WEB_PORT']
  if (fromEnv && isValidPort(fromEnv)) return fromEnv
  try {
    const m = readFileSync(join(REPO_ROOT, '.env'), 'utf-8').match(/^WEB_PORT=(.*)$/m)
    const v = m?.[1]?.trim().replace(/^["']|["']$/g, '')
    if (v && isValidPort(v)) return v
  } catch { /* no .env: fall through to the default */ }
  return '3420'
})()

// Built-in allowlist: URL prefixes the main agent may call directly via WebFetch.
// Anything not on this list (or the runtime allowlist) must go through the
// quarantine-reader sub-agent. Keep sorted and documented so additions are
// intentional, not accidental.
const ALLOWED_PREFIXES = [
  // GitHub REST API
  'https://api.github.com/',
  // Google OAuth token endpoint
  'https://oauth2.googleapis.com/',
  // Google APIs (Calendar, Gmail, Drive, etc.)
  'https://www.googleapis.com/',
  'https://gmail.googleapis.com/',
  'https://calendar.googleapis.com/',
  // Telegram Bot API
  'https://api.telegram.org/',
  // Slack Web API
  'https://slack.com/api/',
  // Discord REST API
  'https://discord.com/api/',
  // Ollama (local LLM server) -- localhost and loopback
  'http://localhost:11434/',
  'http://127.0.0.1:11434/',
  // Marveen dashboard API (local). The port follows WEB_PORT: a fixed 3420 here
  // blocked the agent's own dashboard once the install moved to another port.
  `http://localhost:${DASHBOARD_PORT}/`,
  `http://127.0.0.1:${DASHBOARD_PORT}/`,
]

// The quarantine tier's domain list -- see the header comment for the full rationale.
const QUARANTINE_AGENT_TYPE = 'quarantine-reader'

// `path` (optional) narrows a domain to the URLs the sub-agent's definition
// actually promises. Reddit is the reason it exists: the definition allows RSS
// feeds only, and hostname matching alone would hand over the entire site.
const QUARANTINE_DOMAINS = [
  { domain: 'status.anthropic.com' },
  { domain: 'status.claude.com' },
  { domain: 'feeds.feedburner.com' },
  { domain: 'rss.arxiv.org' },
  { domain: 'export.arxiv.org' },
  { domain: 'hnrss.org' },
  { domain: 'feeds.arstechnica.com' },
  { domain: 'techcrunch.com' },
  { domain: 'feeds.reuters.com' },
  { domain: 'feeds.bbci.co.uk' },
  { domain: 'www.reddit.com', path: (p) => p.endsWith('.rss') },
  // Card 5cd87b6f (Cybersec): the GitHub-first workflow rule (root CLAUDE.md
  // rule 10) sends every agent to github.com/raw.githubusercontent.com BEFORE
  // building anything from scratch, but neither host was reachable through the
  // quarantine boundary -- only api.github.com (the REST API, builtin tier)
  // was. That structural gap steered agents toward a Bash `curl`/direct-fetch
  // bypass instead, since the sanctioned quarantined path could not reach the
  // one place the rule tells them to look first.
  { domain: 'github.com' },
  { domain: 'raw.githubusercontent.com' },
]

function matchesQuarantineDomain(url, extraDomains = []) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const hostMatches = (d) => parsed.hostname === d || parsed.hostname.endsWith('.' + d)
  for (const entry of QUARANTINE_DOMAINS) {
    if (!hostMatches(entry.domain)) continue
    if (entry.path && !entry.path(parsed.pathname)) return false
    return true
  }
  // Operator additions carry no path rule: an entry someone typed into the
  // store file is a deliberate act, and second-guessing its shape here would
  // only make the file's behaviour harder to predict.
  return extraDomains.some(hostMatches)
}

/** Firecrawl tools that carry a required `url` and can therefore be judged by the same rules as
 *  WebFetch. Anything else in the namespace is denied outright -- see the header. */
const FIRECRAWL_URL_TOOLS = new Set([
  'mcp__firecrawl__firecrawl_scrape',
  'mcp__firecrawl__firecrawl_map',
])
const FIRECRAWL_PREFIX = 'mcp__firecrawl__'

/** Parameters `firecrawl_scrape` may carry. ALLOWLIST, not a blacklist of the dangerous ones
 *  (Cybersec HIGH on 97d0c7c7, card 91c4a369).
 *
 *  Judging only `url` was not enough: the same input carries `actions`, whose types include
 *  `executeJavascript` with a free-text `script`. The package gates those behind
 *  `SAFE_MODE = process.env.CLOUD_SERVICE === 'true'`, which we do not set, so the full list --
 *  click, write, press, executeJavascript, generatePDF -- is live. A scrape of an ALLOWLISTED host
 *  could therefore run arbitrary JS on the loaded page and `fetch()` anywhere, and `click` could
 *  navigate off-domain for a later `scrape` action. None of it appears in `url`. Measured, no
 *  network: both payloads were ALLOWED with zero block-log lines, alongside a positive control
 *  (same url, no actions -> allow) and a negative one (off-allowlist url -> deny, +1 line).
 *
 *  That is worse than an ungated tool, because the deny path keeps working and the log reports a
 *  clean day while the exfiltration rides a host the operator approved. It also goes through the
 *  quarantine-reader boundary rather than around it: that boundary rests on the sub-agent holding
 *  nothing but data-returning fetchers, and one of those fetchers contains an outbound primitive.
 *
 *  An ALLOWLIST rather than `delete input.actions` on purpose: a blacklist re-opens silently on the
 *  next version that adds a field, while an unknown key here turns a schema addition into a red
 *  gate. Pinning `firecrawl-mcp@3.24.0` is what keeps that from being noisy -- a new field can only
 *  arrive with a deliberate version bump.
 *
 *  Omission is the deny: `actions`, `skipTlsVerification` (drops TLS verification on the target),
 *  `profile` (carries a browser profile/cookies between scrapes) and `proxy` are all absent, and
 *  none of them is needed for "JS-heavy structured scraping". Any of them can be added later, one
 *  at a time, with a stated reason. */
const FIRECRAWL_SCRAPE_ALLOWED_KEYS = new Set([
  'url', 'formats', 'jsonOptions', 'queryOptions', 'onlyMainContent', 'redactPII',
  'includeTags', 'excludeTags', 'waitFor', 'maxAge', 'removeBase64Images', 'mobile',
  'location', 'storeInCache', 'zeroDataRetention', 'lockdown',
])

/** Parameters `firecrawl_map` may carry (card 4de3b4d4, follow-up to 91c4a369). Same ALLOWLIST
 *  reasoning as scrape above, even though every current field is inert -- url/search/sitemap/
 *  includeSubdomains/ignoreQueryParameters/limit are all scalars, none carries an execution or
 *  outbound-fetch primitive the way scrape's `actions` did. The allowlist exists for the SAME
 *  reason scrape's does: an unknown key on a pinned-version bump turns into a red gate instead of
 *  a silent default-allow, so a future field with real capability (an `actions`-shaped addition,
 *  for instance) cannot ride through unnoticed the way scrape's did before 91c4a369. */
const FIRECRAWL_MAP_ALLOWED_KEYS = new Set([
  'url', 'search', 'sitemap', 'includeSubdomains', 'ignoreQueryParameters', 'limit',
])

const FIRECRAWL_ALLOWED_KEYS_BY_TOOL = {
  'mcp__firecrawl__firecrawl_scrape': FIRECRAWL_SCRAPE_ALLOWED_KEYS,
  'mcp__firecrawl__firecrawl_map': FIRECRAWL_MAP_ALLOWED_KEYS,
}

/** Keys the caller passed that the allowlist above does not clear. Exported so the CLI path can say
 *  WHICH rule denied: without it a block-log line reads `url="<an approved host>" reason="not on
 *  egress allowlist"`, which is false on its face and misleads exactly in the incident that matters
 *  (Cybersec MEDIUM, card 91c4a369). Empty array = nothing to object to. */
export function firecrawlDisallowedParams(toolName, toolInput) {
  const allowed = FIRECRAWL_ALLOWED_KEYS_BY_TOOL[String(toolName ?? '')]
  if (!allowed) return []
  return Object.keys(toolInput ?? {}).filter((k) => !allowed.has(k))
}

// Load the runtime allowlist from store/egress-allowlist.json.
// FAIL-OPEN on the file: missing or malformed -> empty lists, NOT an error.
// The caller must still apply the built-in ALLOWED_PREFIXES.
export function loadRuntimeAllowlist() {
  try {
    const raw = readFileSync(RUNTIME_ALLOWLIST_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    return {
      domains: Array.isArray(parsed.domains) ? parsed.domains.filter((d) => typeof d === 'string') : [],
      prefixes: Array.isArray(parsed.prefixes) ? parsed.prefixes.filter((p) => typeof p === 'string') : [],
      // Operator-managed extension of the QUARANTINE tier. Reachable ONLY by
      // the quarantine-reader sub-agent -- putting a domain here does not open
      // it to the main agent, which is the whole point of the split.
      quarantineDomains: Array.isArray(parsed.quarantine_domains)
        ? parsed.quarantine_domains.filter((d) => typeof d === 'string')
        : [],
    }
  } catch {
    // Missing file or JSON parse error: treat as empty, never propagate.
    return { domains: [], prefixes: [], quarantineDomains: [] }
  }
}

// Pure decision, with the tier that decided it.
//
// `runtimeList` is the decoded store/egress-allowlist.json (or any equivalent object) and
// `agentType` is the payload's `agent_type` -- empty for a main agent. Keeping file I/O out
// of this function makes it fully unit-testable without touching the filesystem.
//
// The tier is returned because the quarantine tier is the security-relevant exception and
// its grants are audited: a fetch nobody can see is a hole nobody can find.
//
// Domain matching uses URL-parsed hostname ONLY, not string-contains, to prevent
// bypasses like `https://evil.com/?x=docs.anthropic.com` matching the domain
// "docs.anthropic.com" via a simple includes() check.
export function egressDecision(
  toolName,
  toolInput,
  runtimeList = { domains: [], prefixes: [], quarantineDomains: [] },
  agentType = '',
) {
  const name = String(toolName ?? '')
  const isFirecrawl = name.startsWith(FIRECRAWL_PREFIX)

  // Default-deny inside the Firecrawl namespace: a tool that is not one of the two URL-bearing
  // ones cannot be checked against a hostname allowlist, so there is no version of "allowed" for
  // it here -- not even for the quarantine-reader (its own `tools:` line never lists these).
  if (isFirecrawl && !FIRECRAWL_URL_TOOLS.has(name)) {
    return { blocked: true, tier: 'firecrawl-namespace-denied' }
  }
  // Same default-deny, one level in: a permitted Firecrawl tool called with a parameter we have
  // not cleared (actions/skipTlsVerification/profile/proxy -- JS-exec/exfiltration risk, card
  // 91c4a369). Checked before the host is even looked at: an approved host does not clear a
  // disallowed parameter.
  if (firecrawlDisallowedParams(name, toolInput).length > 0) {
    return { blocked: true, tier: 'firecrawl-param-denied' }
  }
  if (name !== 'WebFetch' && !isFirecrawl) return { blocked: false, tier: 'not-webfetch' }

  const url = String(toolInput?.url ?? '')
  // A URL-bearing tool invoked WITHOUT a url is a call this gate cannot judge, so it is denied.
  // WebFetch keeps its historical behaviour (nothing to fetch, nothing to block) because a missing
  // url there is a malformed call the tool itself rejects; for Firecrawl the field is REQUIRED by
  // the schema, so its absence means the input is not what we think it is.
  if (!url) return { blocked: isFirecrawl, tier: isFirecrawl ? 'firecrawl-missing-url' : 'no-url' }

  // 1. Built-in prefix check (startsWith is correct here: the prefix already
  //    includes the trailing slash so a prefix-extension attack is impossible,
  //    e.g. 'https://api.github.com.evil.com/' does not start with
  //    'https://api.github.com/').
  if (ALLOWED_PREFIXES.some((prefix) => url.startsWith(prefix))) return { blocked: false, tier: 'builtin' }

  // 2. Runtime prefix check.
  const rtPrefixes = runtimeList.prefixes ?? []
  if (rtPrefixes.some((p) => url.startsWith(p))) return { blocked: false, tier: 'runtime-prefix' }

  // 3. Runtime domain check: parse the URL to extract a verified hostname.
  //    URL parsing fails on non-URLs -> block (fail-safe).
  const rtDomains = runtimeList.domains ?? []
  if (rtDomains.length > 0) {
    let hostname
    try {
      hostname = new URL(url).hostname
    } catch {
      // Unparseable URL: block, don't throw.
      return { blocked: true, tier: 'unparseable' }
    }
    // Match exact hostname OR any subdomain (host.endsWith('.' + domain)).
    if (rtDomains.some((d) => hostname === d || hostname.endsWith('.' + d))) return { blocked: false, tier: 'runtime-domain' }
  }

  // 4. Quarantine tier -- the ONLY tier a main agent cannot reach. Exact agent_type match
  //    required (fail-closed: anything else falls through to the block below). Applies to
  //    WebFetch and the two URL-bearing Firecrawl tools alike -- see header comment.
  if (String(agentType ?? '') === QUARANTINE_AGENT_TYPE) {
    if (matchesQuarantineDomain(url, runtimeList.quarantineDomains ?? [])) {
      return { blocked: false, tier: 'quarantine' }
    }
  }

  return { blocked: true, tier: 'none' }
}

// Back-compatible boolean form.
export function isEgressBlocked(toolName, toolInput, runtimeList, agentType) {
  return egressDecision(toolName, toolInput, runtimeList, agentType).blocked
}

// The payload's top-level FIELD NAMES, sorted -- never a value.
//
// This exists to answer one open question with data instead of a guess: does
// the PreToolUse payload carry anything that identifies the CALLER? The gate
// decides on the URL (and, now, the tool namespace) alone, so a main agent and
// a quarantine-reader sub-agent are indistinguishable to it on the URL axis --
// which is why the caller-aware quarantine tier above is built on the
// separately-verified `agent_type` field, not on this signature. Keys only, by
// construction: a value could carry a url, a prompt, or a secret, and this log
// is read casually. Nested objects contribute nothing but their own key.
export function payloadKeySignature(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
  return Object.keys(payload).sort().join(',')
}

function logLine(kind, url, detail, keys = '', agentType = '') {
  try {
    mkdirSync(join(REPO_ROOT, 'store'), { recursive: true })
    const ts = new Date().toISOString()
    const keyPart = keys ? ` payload_keys="${keys}"` : ''
    const agentPart = agentType ? ` agent_type="${agentType}"` : ''
    appendFileSync(EGRESS_BLOCK_LOG, `${ts} ${kind} url="${url}" ${detail}${agentPart}${keyPart}\n`, 'utf-8')
  } catch {
    // Never let log failure cascade into blocking the agent process itself.
  }
}

const BLOCK_MESSAGE =
  'Egress TILTOTT (egress-gate hook). Ez az URL nem szerepel a fő ágens WebFetch ' +
  'engedélylistáján. Külső web-tartalom (RSS, dokumentáció, cikkek, ismeretlen API-k) ' +
  'KIZÁRÓLAG a quarantine-reader sub-ágensen keresztül kérhető le: ' +
  'Agent({ subagent_type: "quarantine-reader", prompt: `FETCH {"url":"...","nonce":"..."}` }). ' +
  'A letiltott hívás rögzítve lett a store/egress-blocked.log fájlban. ' +
  'Ha ez a hívás jogos, az operátor jóváhagyhatja: adja hozzá az URL-t vagy domain-t a ' +
  'store/egress-allowlist.json fájlhoz ({ "domains": ["example.com"] } vagy ' +
  '{ "prefixes": ["https://example.com/api/"] }), majd futtassa újra a WebFetch hívást.'

/** The host was fine; the parameters were not. Says which one and what to do, because the generic
 *  message above would send the reader off to edit the domain allowlist, which fixes nothing here.
 *  Tool-specific (card 4de3b4d4): the scrape-only danger explanation (executeJavascript/click) is
 *  false for firecrawl_map, whose current fields are all inert scalars -- naming the wrong tool and
 *  the wrong exploit in a denial message is its own kind of misleading. */
const PARAM_BLOCK_MESSAGE = (toolName, keys) => {
  const short = String(toolName ?? '').replace(FIRECRAWL_PREFIX, '')
  const danger = short === 'firecrawl_scrape'
    ? `Ezek egy MÁSODIK kimenő csatornát nyitnának egy jóváhagyott hoszton keresztül (az actions[] ` +
      `tömb executeJavascript/click akciói tetszőleges JS-t futtatnak és bárhová fetch-elhetnek), ` +
      `vagy a kapcsolat védelmét gyengítenék (skipTlsVerification, proxy, profile). `
    : `Ma egyik ismert mező sem visz kimenő/végrehajtási képességet, de egy jövőbeli sématovábbítás ` +
      `(pinnelt verzió-bővítés) csendben adhatna hozzá egy ilyet, és az allowlist híján ez a hívás ` +
      `automatikusan átment volna. `
  return (
    `Egress TILTOTT (egress-gate hook): a hoszt rendben van, de a ${short} hívás olyan ` +
    `paramétert visz, ami nincs engedélyezve: ${keys.join(', ')}. ` +
    danger +
    `TEENDŐ: hívd újra ezeket a mezőket ELHAGYVA. Ha egy ilyen mező tényleg kell, az BIZTONSÁGI ` +
    `döntés: a scripts/hooks/egress-gate.mjs FIRECRAWL_${short === 'firecrawl_scrape' ? 'SCRAPE' : 'MAP'}_ALLOWED_KEYS ` +
    `listájába indoklással kerül be.`
  )
}

// allow()/deny()/isInvokedDirectly() are shared with the other PreToolUse
// gates -- see hook-lib.mjs.

if (isInvokedDirectly(import.meta.url)) {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    allow() // malformed/empty input must never block the agent
  }
  const url = String(payload?.tool_input?.url ?? '')
  const agentType = String(payload?.agent_type ?? '')
  const runtimeList = loadRuntimeAllowlist()

  // Which rule denied, before the generic one: a param denial can land on an APPROVED host, and
  // "not on egress allowlist" would then be a false explanation pointing at the wrong fix.
  const badParams = firecrawlDisallowedParams(payload?.tool_name, payload?.tool_input)
  if (badParams.length > 0) {
    logLine(
      'BLOCKED',
      url,
      `reason="disallowed firecrawl parameter: ${badParams.join(', ')}"`,
      payloadKeySignature(payload),
      agentType,
    )
    deny(PARAM_BLOCK_MESSAGE(payload?.tool_name, badParams))
  }

  const decision = egressDecision(payload?.tool_name, payload?.tool_input, runtimeList, agentType)
  if (decision.blocked) {
    logLine('BLOCKED', url, 'reason="not on egress allowlist"', payloadKeySignature(payload), agentType)
    deny(BLOCK_MESSAGE)
  }
  // Audited, not silent: the quarantine tier is the one grant a main agent cannot obtain, so
  // every use of it (WebFetch or a Firecrawl scrape/map) leaves a line next to the denials. The
  // other tiers are the ordinary allowlist and stay quiet.
  if (decision.tier === 'quarantine') {
    logLine('ALLOWED_QUARANTINE', url, 'reason="quarantine-reader tier"', '', agentType)
  }
  allow()
}
