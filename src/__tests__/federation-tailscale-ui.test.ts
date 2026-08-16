// String-contract guard for the Tailscale login + self connection-info panel on the Föderáció
// page (card 9bf6a1e0, contract drafted by backend on card b68ddae8). Follows the house idiom
// (see federation-ui-contract.test.ts / local-llm-catalog-ui-wiring.test.ts): app.js is a single
// global script with no module boundary, so the frontend files are read as strings and asserted
// against short, formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const CSS = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')
const HU = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const EN = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')

function fnBody(source: string, startMarker: string): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`marker not found: ${startMarker}`)
  const nextFn = source.indexOf('\nfunction ', start + startMarker.length)
  const nextAsyncFn = source.indexOf('\nasync function ', start + startMarker.length)
  const candidates = [nextFn, nextAsyncFn].filter((i) => i > start)
  const end = candidates.length ? Math.min(...candidates) : start + 5000
  return source.slice(start, end)
}

describe('markup: panel placement', () => {
  it('lives between federationMaster and the peers heading, inside the Föderáció page', () => {
    const pageIdx = HTML.indexOf('id="federationPage"')
    const masterIdx = HTML.indexOf('id="federationMaster"', pageIdx)
    const panelIdx = HTML.indexOf('id="federationTailscale"', pageIdx)
    const peersHeadingIdx = HTML.indexOf('federation.peers_title', pageIdx)
    expect(masterIdx).toBeGreaterThan(pageIdx)
    expect(panelIdx).toBeGreaterThan(masterIdx)
    expect(peersHeadingIdx).toBeGreaterThan(panelIdx)
  })

  it('is rendered by JS, not static markup -- the div itself carries no hardcoded content', () => {
    const idx = HTML.indexOf('id="federationTailscale"')
    const tag = HTML.slice(idx - 40, idx + 120)
    expect(tag).toMatch(/<div[^>]*id="federationTailscale"[^>]*><\/div>/)
  })
})

describe('fedTailscaleLogin: POST /login and branch on pollToken presence', () => {
  it('POSTs to the contracted endpoint', () => {
    const body = fnBody(APP, 'async function fedTailscaleLogin()')
    expect(body).toContain("fetch('/api/federation/tailscale/login'")
    expect(body).toContain("method: 'POST'")
  })

  it('branches on data.pollToken, NOT on data.status alone -- the idempotent "connected" branch may lack it', () => {
    // Contract gap noted in the code: POST /login's already-connected response is documented as
    // { status: 'connected' } with no pollToken, so there is nothing to poll GET /status with on
    // that path. Branching on status alone would wrongly try to poll with an undefined token.
    const body = fnBody(APP, 'async function fedTailscaleLogin()')
    expect(body).toContain('if (data.pollToken) {')
    expect(body).toContain("} else if (data.status === 'connected') {")
    expect(body).toContain("status: 'connected-no-data'")
  })

  it('SECURITY (Cybered NO-GO, gate-sha 1c3b95a2, HIGH): the loginUrl is validated BEFORE the automatic window.open', () => {
    // A login-intent flow (the button literally says "sign in") that navigates to an unvalidated
    // URL is a first-party phishing vector -- backend's promise to only ever send a validated
    // https+tailscale.com URL lives in a still-DRAFT contract with no shipped code behind it yet.
    // The validation call must appear, and the window.open for the automatic pop-up must be
    // reached only through the branch that already passed it.
    const body = fnBody(APP, 'async function fedTailscaleLogin()')
    const validateIdx = body.indexOf('fedTailscaleValidLoginUrl(loginUrl)')
    const openIdx = body.indexOf("window.open(loginUrl, '_blank', 'noopener')")
    expect(validateIdx).toBeGreaterThan(-1)
    expect(openIdx).toBeGreaterThan(validateIdx)
    // An invalid URL must refuse to open it (not fall through to opening it anyway).
    expect(body).toContain('if (loginUrl && !fedTailscaleValidLoginUrl(loginUrl)) {')
    const rejectBranch = body.slice(body.indexOf('if (loginUrl && !fedTailscaleValidLoginUrl(loginUrl)) {'), openIdx)
    expect(rejectBranch).toContain('_fedTailscaleLoginUrl = null')
    expect(rejectBranch).toContain('return')
  })

  it('detects a blocked pop-up (window.open returning falsy) only on the validated path', () => {
    const body = fnBody(APP, 'async function fedTailscaleLogin()')
    expect(body).toContain('if (!win) popupBlocked = true')
  })

  it('a failed POST shows ONLY the localized generic message -- data.error never reaches state (Cybered MEDIUM)', () => {
    // The contract's promise that `error` is always a curated, non-leaking string is not yet
    // backed by shipped backend code (b68ddae8 is still DRAFT) -- a `data.error || t(...)`
    // fallback would display whatever backend sends the moment it sends anything, trusting a
    // control that does not exist yet. Assert the OPPOSITE of "the key exists somewhere":
    // data.error must not reach _fedTailscaleState.error at all in this function.
    const body = fnBody(APP, 'async function fedTailscaleLogin()')
    expect(body).toContain("t('federation.tailscale.error_generic')")
    expect(body).not.toMatch(/err\.message/)
    expect(body).not.toMatch(/error:\s*data\.error/)
  })
})

describe('fedTailscaleValidLoginUrl (Cybered NO-GO, HIGH, gate-sha 1c3b95a2)', () => {
  it('requires https and a tailscale.com host', () => {
    const body = fnBody(APP, 'function fedTailscaleValidLoginUrl(url)')
    expect(body).toContain("u.protocol === 'https:'")
    expect(body).toMatch(/u\.hostname === 'login\.tailscale\.com' \|\| u\.hostname\.endsWith\('\.tailscale\.com'\)/)
  })

  it('a malformed URL is caught, not thrown -- new URL() throws on garbage input', () => {
    const body = fnBody(APP, 'function fedTailscaleValidLoginUrl(url)')
    expect(body).toMatch(/try\s*\{\s*u = new URL\(url\)\s*\}\s*catch\s*\{\s*return false\s*\}/)
  })

  it('the fallback "open login link" button re-validates independently -- a second call site, not a shared trust assumption', () => {
    // NOT the first occurrence (indexOf would land on the HTML template's id="..." attribute) --
    // the actual event-listener wiring, further down in the same function.
    const body = fnBody(APP, 'function fedTailscaleRender()')
    const btnIdx = body.indexOf("getElementById('fedTailscaleOpenLoginBtn')")
    expect(btnIdx).toBeGreaterThan(-1)
    const slice = body.slice(btnIdx, btnIdx + 200)
    expect(slice).toContain('fedTailscaleValidLoginUrl(_fedTailscaleLoginUrl)')
  })
})

describe('fedTailscalePoll: GET /status polling', () => {
  it('GETs the contracted endpoint with the pollToken as a query param', () => {
    const body = fnBody(APP, 'function fedTailscalePoll(pollToken)')
    expect(body).toContain('fetch(`/api/federation/tailscale/status?pollToken=${encodeURIComponent(pollToken)}`)')
  })

  it('stops on both terminal states (connected, failed) -- pending alone keeps polling', () => {
    const body = fnBody(APP, 'function fedTailscalePoll(pollToken)')
    expect(body).toContain("if (data.status === 'connected') {")
    expect(body).toContain("} else if (data.status === 'failed') {")
    // Both terminal branches call the stop helper.
    const connectedBranch = body.slice(body.indexOf("data.status === 'connected'"), body.indexOf("data.status === 'failed'"))
    expect(connectedBranch).toContain('fedTailscaleStopPoll()')
  })

  it('has a bounded attempt ceiling -- does not poll forever on a stuck pending', () => {
    expect(APP).toMatch(/FED_TAILSCALE_POLL_MAX_ATTEMPTS\s*=\s*20/)
    const body = fnBody(APP, 'function fedTailscalePoll(pollToken)')
    expect(body).toContain('_fedTailscalePollAttempts > FED_TAILSCALE_POLL_MAX_ATTEMPTS')
  })

  it('stops polling once the user leaves the Föderáció page (no leaked interval)', () => {
    const body = fnBody(APP, 'function fedTailscalePoll(pollToken)')
    expect(body).toMatch(/if \(!page \|\| page\.hidden\) \{ fedTailscaleStopPoll\(\); return \}/)
  })

  it('a network failure or a failed/error status shows ONLY the localized message -- data.error never reaches state (Cybered MEDIUM)', () => {
    const body = fnBody(APP, 'function fedTailscalePoll(pollToken)')
    expect(body).toContain("t('federation.tailscale.error_generic')")
    expect(body).not.toMatch(/error:\s*data\.error/)
  })
})

describe('loadFederationPage: stale-pending recovery', () => {
  it('resets a pending state with no active poller back to idle (navigated away mid-login)', () => {
    const body = fnBody(APP, 'async function loadFederationPage()')
    expect(body).toMatch(/_fedTailscaleState\.status === 'pending' && !_fedTailscalePollTimer/)
    expect(body).toContain("_fedTailscaleState = { status: 'idle' }")
  })
})

describe('fedTailscaleRender: all states + copy-to-clipboard', () => {
  it('covers connected, connected-no-data, pending, error, and idle', () => {
    const body = fnBody(APP, 'function fedTailscaleRender()')
    expect(body).toContain("s.status === 'connected'")
    expect(body).toContain("s.status === 'connected-no-data'")
    expect(body).toContain("s.status === 'pending'")
    expect(body).toContain("s.status === 'error'")
  })

  it('the connected state shows systemId AND baseUrl with a copy button each -- never a truncated value', () => {
    const body = fnBody(APP, 'function fedTailscaleRender()')
    expect(body).toContain('data-copy="systemId"')
    expect(body).toContain('data-copy="baseUrl"')
    expect(body).toContain('escapeHtml(s.systemId')
    expect(body).toContain('escapeHtml(s.baseUrl')
    expect(body).not.toMatch(/s\.systemId\)\.slice\(/)
    expect(body).not.toMatch(/s\.baseUrl\)\.slice\(/)
  })

  it('copy buttons use the clipboard API and show a localized confirmation toast', () => {
    const body = fnBody(APP, 'function fedTailscaleRender()')
    expect(body).toContain('navigator.clipboard?.writeText(val || \'\')')
    expect(body).toContain("t('federation.tailscale.copied')")
  })

  it('pending state offers a manual "open login link" fallback when the pop-up was blocked', () => {
    const body = fnBody(APP, 'function fedTailscaleRender()')
    expect(body).toContain('s.popupBlocked')
    expect(body).toContain("t('federation.tailscale.popup_blocked')")
    expect(body).toContain('id="fedTailscaleOpenLoginBtn"')
  })

  it('error state offers a retry and points at the manual fallback docs', () => {
    const body = fnBody(APP, 'function fedTailscaleRender()')
    const errorBranch = body.slice(body.indexOf("s.status === 'error'"))
    expect(errorBranch).toContain("t('federation.tailscale.retry_btn')")
    expect(errorBranch).toContain("t('federation.tailscale.manual_hint')")
  })
})

describe('i18n parity (rule 12)', () => {
  const KEYS = [
    'federation.tailscale.title', 'federation.tailscale.hint', 'federation.tailscale.login_btn',
    'federation.tailscale.retry_btn', 'federation.tailscale.pending', 'federation.tailscale.open_login_btn',
    'federation.tailscale.popup_blocked', 'federation.tailscale.system_id_label', 'federation.tailscale.base_url_label',
    'federation.tailscale.copy_btn', 'federation.tailscale.copied', 'federation.tailscale.manual_hint',
    'federation.tailscale.error_generic',
  ]
  it.each(KEYS)('%s exists in hu.js', (key) => {
    expect(HU).toContain(`'${key}':`)
  })
  it.each(KEYS)('%s exists in en.js', (key) => {
    expect(EN).toContain(`'${key}':`)
  })
})

describe('rule 13: touch targets for the new controls', () => {
  it('scopes a 44px min-height rule to #federationTailscale, matching the #localLlmPage convention', () => {
    expect(CSS).toMatch(/#federationTailscale \.btn-compact,\s*\n#federationTailscale \.btn-primary,\s*\n#federationTailscale \.btn-secondary \{ min-height: 44px; \}/)
  })
})
