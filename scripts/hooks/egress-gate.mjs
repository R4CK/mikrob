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
//      invocation. Shape: { "domains": ["example.com"], "prefixes": ["https://host/path/"] }
//      Both keys are optional. Missing file or malformed JSON -> treated as empty
//      lists (FAIL-OPEN on the file, FAIL-SAFE on the decision: the built-in list
//      still guards; no extra URLs are allowed merely because the file is missing).
//
// When a URL is not on either allowlist:
//   - The tool call is HARD-BLOCKED (decision: deny).
//   - The blocked call is appended to EGRESS_BLOCK_LOG for operator review.
//   - The operator can approve the URL/domain: add it to store/egress-allowlist.json,
//     then re-run the WebFetch. No restart required.
//
// The log is separate from the main Marveen log so operators can grep it
// independently: `tail -f store/egress-blocked.log`
//
// Scope: this guard covers the Claude Code WebFetch tool AND the Firecrawl MCP
// fetch tools (card 91c4a369, Cybersec blocking precondition 4). It does NOT
// intercept WebSearch or curl/Bash network calls; those channels are out of
// scope for this hook mechanism and require separate controls if needed.
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

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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
    }
  } catch {
    // Missing file or JSON parse error: treat as empty, never propagate.
    return { domains: [], prefixes: [] }
  }
}

// Pure decision: allowed (false) or blocked (true)?
//
// `runtimeList` is the decoded store/egress-allowlist.json (or any equivalent
// object). Keeping file I/O out of this function makes it fully unit-testable
// without touching the filesystem.
//
// Domain matching uses URL-parsed hostname ONLY, not string-contains, to prevent
// bypasses like `https://evil.com/?x=docs.anthropic.com` matching the domain
// "docs.anthropic.com" via a simple includes() check.
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

export function isEgressBlocked(toolName, toolInput, runtimeList = { domains: [], prefixes: [] }) {
  const name = String(toolName ?? '')
  const isFirecrawl = name.startsWith(FIRECRAWL_PREFIX)
  // Default-deny inside the Firecrawl namespace: a tool that is not one of the two URL-bearing ones
  // cannot be checked against a hostname allowlist, so there is no version of "allowed" for it here.
  if (isFirecrawl && !FIRECRAWL_URL_TOOLS.has(name)) return true
  // Same default-deny, one level in: a permitted tool called with a parameter we have not cleared.
  if (name === 'mcp__firecrawl__firecrawl_scrape') {
    const extra = Object.keys(toolInput ?? {}).filter((k) => !FIRECRAWL_SCRAPE_ALLOWED_KEYS.has(k))
    if (extra.length > 0) return true
  }
  if (name !== 'WebFetch' && !isFirecrawl) return false
  const url = String(toolInput?.url ?? '')
  // A URL-bearing tool invoked WITHOUT a url is a call this gate cannot judge, so it is denied.
  // WebFetch keeps its historical behaviour (nothing to fetch, nothing to block) because a missing
  // url there is a malformed call the tool itself rejects; for Firecrawl the field is REQUIRED by
  // the schema, so its absence means the input is not what we think it is.
  if (!url) return isFirecrawl

  // 1. Built-in prefix check (startsWith is correct here: the prefix already
  //    includes the trailing slash so a prefix-extension attack is impossible,
  //    e.g. 'https://api.github.com.evil.com/' does not start with
  //    'https://api.github.com/').
  if (ALLOWED_PREFIXES.some((prefix) => url.startsWith(prefix))) return false

  // 2. Runtime prefix check.
  const rtPrefixes = runtimeList.prefixes ?? []
  if (rtPrefixes.some((p) => url.startsWith(p))) return false

  // 3. Runtime domain check: parse the URL to extract a verified hostname.
  //    URL parsing fails on non-URLs -> block (fail-safe).
  const rtDomains = runtimeList.domains ?? []
  if (rtDomains.length > 0) {
    let hostname
    try {
      hostname = new URL(url).hostname
    } catch {
      // Unparseable URL: block, don't throw.
      return true
    }
    // Match exact hostname OR any subdomain (host.endsWith('.' + domain)).
    if (rtDomains.some((d) => hostname === d || hostname.endsWith('.' + d))) return false
  }

  return true
}

function logBlocked(url, reason) {
  try {
    mkdirSync(join(REPO_ROOT, 'store'), { recursive: true })
    const ts = new Date().toISOString()
    appendFileSync(EGRESS_BLOCK_LOG, `${ts} BLOCKED url="${url}" reason="${reason}"\n`, 'utf-8')
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

function allow() { process.exit(0) }

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

function isInvokedDirectly() {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
    return self === entry
  } catch {
    return false
  }
}

if (isInvokedDirectly()) {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    allow() // malformed/empty input must never block the agent
  }
  const url = String(payload?.tool_input?.url ?? '')
  const runtimeList = loadRuntimeAllowlist()
  if (isEgressBlocked(payload?.tool_name, payload?.tool_input, runtimeList)) {
    logBlocked(url, 'not on egress allowlist')
    deny(BLOCK_MESSAGE)
  }
  allow()
}
