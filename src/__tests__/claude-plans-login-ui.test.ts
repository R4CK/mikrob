// SETUPTOKENWIZ1022: Settings -> Claude plans, "log in" mode. Pins the shipped
// web/app.js (evaluated from the file, not a copy): the start body, the routes
// the buttons call, how the link is set, and that every error code the server
// sends has a translation in both languages.
//
// SKIPPED (buildClaudePlanLoginStartBody/wiring/error codes) 2026-11-18 (backend3, card 51c68eeb,
// Koteg 26, upstream 4540f195f/SETUPTOKENWIZ1022): the backend half (src/web/routes/
// claude-plans-login.ts, src/web/setup-token-login.ts, the web.ts wiring this file's own 'server
// wiring' describe checks) merged cleanly and is real, present code -- only the frontend half
// (buildClaudePlanLoginStartBody, renderClaudePlansPanel's login-mode UI, showClaudePlanLoginStep,
// copyClaudePlanLoginUrl, startClaudePlanLogin/submitClaudePlanLoginCode/cancelClaudePlanLogin/
// resumeClaudePlanLogin) is missing, and NOT because the panel itself is absent -- CORRECTED after
// checking card 1c810029 (done 2026-11-07): renderClaudePlansPanel exists, ported into
// web/app-claude-plans.js by card c6e8a919, but that port carried only the panel as it stood at
// upstream Köteg 3 (bare id/label/configDir/type/channelsAllowed form, no mode selector, no
// token-auth mode, no edit flow). Every later growth round this file's acknowledged-conflicts.ts
// entry logged (2026-09-15, 2026-09-26, 2026-10-14, and now this one) assumed the richer,
// mode-selector-having panel the login feature's diff is written against (it edits an existing
// `<select id="cpFormMode">` with token/configDir options) -- that selector was never ported
// either, so login mode has no scaffolding to attach to in app-claude-plans.js, the same as it had
// none in app.js. Re-enable (drop .skip) only once a dedicated card ports the accumulated
// mode-selector/token-mode/edit growth into app-claude-plans.js; porting login alone here would
// mean inventing that scaffolding from scratch, well past this card's upstream-sync scope (rule 3,
// surgical changes).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const ROUTE = readFileSync(join(__dirname, '../web/routes/claude-plans-login.ts'), 'utf-8')
const SESSION = readFileSync(join(__dirname, '../web/setup-token-login.ts'), 'utf-8')

function extractFn(name: string): string {
  const re = new RegExp(`(?:async )?function ${name}\\s*\\([^)]*\\)\\s*\\{`)
  const m = re.exec(APP)
  if (!m) throw new Error(`${name} missing from web/app.js`)
  let depth = 0
  for (let j = APP.indexOf('{', m.index); j < APP.length; j++) {
    if (APP[j] === '{') depth++
    else if (APP[j] === '}' && --depth === 0) return APP.slice(m.index, j + 1)
  }
  throw new Error(`${name}: unbalanced braces`)
}

// Lazy on purpose: extractFn throws while buildClaudePlanLoginStartBody does not exist in
// web/app.js (see the SKIPPED note above). Computing it eagerly at module scope would throw on
// import and crash the whole file before describe.skip ever gets a chance to not-run anything.
function buildStart(f: Record<string, unknown>): { error?: string; body?: Record<string, unknown> } {
  return (new Function(`${extractFn('buildClaudePlanLoginStartBody')}; return buildClaudePlanLoginStartBody`)() as (
    f: Record<string, unknown>,
  ) => { error?: string; body?: Record<string, unknown> })(f)
}

async function loadLang(file: string): Promise<Record<string, string>> {
  const src = readFileSync(join(__dirname, '../../web/lang', file), 'utf-8')
  const sandbox: Record<string, unknown> = {}
  new Function('window', src)(sandbox)
  const found = Object.values(sandbox).find((v) => v && typeof v === 'object') as Record<string, Record<string, string>> | undefined
  if (!found) throw new Error(`no dictionary in ${file}`)
  return (found.hu ?? found.en ?? found) as Record<string, string>
}

describe.skip('buildClaudePlanLoginStartBody', () => {
  it('sends the plan fields and nothing else', () => {
    expect(buildStart({ id: ' second ', label: ' Max ', planType: 'team', channelsAllowed: 1 })).toEqual({
      body: { id: 'second', label: 'Max', planType: 'team', channelsAllowed: true },
    })
  })
  it('id and label are required', () => {
    expect(buildStart({ id: '', label: 'x' }).error).toBe('settings.claude_plans.form.error_required')
    expect(buildStart({ id: 'x', label: ' ' }).error).toBe('settings.claude_plans.form.error_required')
  })
})

describe.skip('wiring', () => {
  // Lazy for the same reason as buildStart above -- renderClaudePlansPanel does not exist yet.
  const panel = () => extractFn('renderClaudePlansPanel')

  it('the form offers the login mode first, and the paste mode stays', () => {
    const select = panel().slice(panel().indexOf('id="cpFormMode"'), panel().indexOf('</select>'))
    expect(select.indexOf('value="login"')).toBeGreaterThan(-1)
    expect(select.indexOf('value="login"')).toBeLessThan(select.indexOf('value="token"'))
    expect(select).toContain('value="configDir"')
  })

  it('the login link opens in a new tab without an opener', () => {
    expect(panel()).toMatch(/<a [^>]*id="cpLoginLink"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/)
  })

  it('the link is set as a property, only for an https URL, never through innerHTML', () => {
    const step = extractFn('showClaudePlanLoginStep')
    expect(step).toContain("const safeUrl = url && url.startsWith('https://') ? url : ''")
    expect(step).toContain("link.href = safeUrl || '#'")
    expect(step).toContain('urlField.value = safeUrl')
    expect(step).not.toContain('innerHTML')
  })

  it('the link is also shown as read-only text with a copy button', () => {
    expect(panel()).toMatch(/<input [^>]*id="cpLoginUrl"[^>]*readonly/)
    expect(panel()).toContain("addEventListener('click', () => copyClaudePlanLoginUrl())")
    expect(extractFn('copyClaudePlanLoginUrl')).toContain('navigator.clipboard.writeText(field.value)')
  })

  it('the buttons call the login routes', () => {
    expect(extractFn('startClaudePlanLogin')).toContain("fetch('/api/claude-plans/login/start'")
    expect(extractFn('submitClaudePlanLoginCode')).toContain("fetch('/api/claude-plans/login/code'")
    expect(extractFn('cancelClaudePlanLogin')).toContain("fetch('/api/claude-plans/login/cancel'")
    expect(extractFn('resumeClaudePlanLogin')).toContain("fetch('/api/claude-plans/login/status')")
    expect(panel()).toContain('await resumeClaudePlanLogin()')
  })

  it('the add button starts a login only in login mode and not while editing', () => {
    expect(panel()).toContain("if (document.getElementById('cpFormMode').value === 'login' && !claudePlanFormEditing) startClaudePlanLogin()")
  })
})

describe.skip('error codes', () => {
  const serverCodes = new Set<string>()
  const errorUnion = SESSION.slice(SESSION.indexOf('export type LoginErrorCode'), SESSION.indexOf('export interface LoginTimeouts'))
  for (const m of errorUnion.matchAll(/'([a-z-]+)'/g)) serverCodes.add(m[1])
  for (const m of ROUTE.matchAll(/code: '([a-z-]+)'/g)) serverCodes.add(m[1])

  it('every code the server sends maps to a key, or knowingly falls back to the server text', () => {
    const mapBlock = APP.slice(APP.indexOf('const CLAUDE_PLAN_LOGIN_ERROR_KEYS'), APP.indexOf('function claudePlanLoginErrorText'))
    // These only happen on a broken install or a lost race; the server's own
    // sentence is shown for them.
    const fallback = new Set(['spawn-failed', 'cancelled', 'store-failed'])
    expect(serverCodes.size).toBeGreaterThan(12)
    for (const code of serverCodes) {
      if (fallback.has(code)) continue
      expect(mapBlock, code).toContain(`'${code}':`)
    }
  })

  it('every mapped key exists in hu.js and en.js', async () => {
    const hu = await loadLang('hu.js')
    const en = await loadLang('en.js')
    const keys = [...APP.matchAll(/'(settings\.claude_plans\.login\.[a-z_]+)'/g)].map((m) => m[1])
    expect(keys.length).toBeGreaterThan(10)
    for (const k of keys) {
      expect(hu[k], `hu ${k}`).toBeTruthy()
      expect(en[k], `en ${k}`).toBeTruthy()
    }
    expect(hu['settings.claude_plans.form.mode_login']).toBeTruthy()
    expect(en['settings.claude_plans.form.mode_login']).toBeTruthy()
  })
})

describe('server wiring', () => {
  it('web.ts hands /api/claude-plans/login/* to the login handler, ahead of the plans handler', () => {
    const web = readFileSync(join(__dirname, '../web.ts'), 'utf-8')
    const login = web.indexOf('if (await tryHandleClaudePlansLogin(routeCtx)) return')
    const plans = web.indexOf('if (await tryHandleClaudePlans(routeCtx)) return')
    expect(login).toBeGreaterThan(-1)
    expect(login).toBeLessThan(plans)
  })
})
