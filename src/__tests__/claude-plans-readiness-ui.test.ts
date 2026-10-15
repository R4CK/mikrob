// Settings -> Claude plans readiness banner. Evaluates the real, shipped
// claudePlansReadinessLines() from web/app.js (not a copy) against the shape
// GET /api/claude-plans/readiness returns, and pins that every code the
// server can emit has localized banner text in both languages.
//
// SKIPPED 2026-10-14 (backend3, card d7e1d611, Köteg 14, upstream 8887523d/ROTAUTOWIRE926): this
// test file arrived with the backend half of the rotation feature (src/web/claude-rotation-heartbeat.ts,
// which DID merge), but its subject -- renderClaudePlansPanel/claudePlansReadinessLines/
// switchToClaudePlan in web/app.js -- is the Claude Plans settings tab PORT this fork has deferred
// across multiple previous rounds as its own decision, tracked under the ALREADY-OPEN card 1c810029
// (see src/fork-upstream/acknowledged-conflicts.ts, 'web/app.js' entry, 2026-09-15/2026-09-26 notes).
// A brand-new test file has no merge conflict to lose a 3-way resolution to, so it landed even though
// the UI it tests was correctly not adopted -- fork-side-default for a NEW file still means "the fork
// doesn't have this yet", the same as for an edited one. Re-enable (drop .skip) when 1c810029 ports
// the panel; do not quick-port only the banner piece here, since the panel itself does not exist to
// host it (rule 3, surgical changes -- this would grow scope into the deferred decision, not shrink it).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const SERVER = readFileSync(join(__dirname, '../web/claude-rotation-heartbeat.ts'), 'utf-8')

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

const known: Record<string, string> = {
  'settings.claude_plans.readiness.main_agent_not_isolated': 'NOT ISOLATED',
}
const tStub = (key: string) => known[key] ?? key
// Lazy on purpose: extractFn throws while claudePlansReadinessLines does not exist in web/app.js
// (see the SKIPPED note above). Computing it eagerly at module scope would throw on import and
// crash the whole file before describe.skip ever gets a chance to not-run anything.
function lines(r: unknown): string[] | null {
   
  return (new Function('t', `${extractFn('claudePlansReadinessLines')}; return claudePlansReadinessLines`)(tStub) as (
    r: unknown,
  ) => string[] | null)(r)
}

describe.skip('claudePlansReadinessLines', () => {
  it('rotation on but blocked: one line per blocker, localized when known', () => {
    expect(lines({
      ready: false,
      blockers: ['main_agent_not_isolated', 'future_code'],
      details: [{ code: 'main_agent_not_isolated', message: 'x' }, { code: 'future_code', message: 'szerver szöveg' }],
    })).toEqual(['NOT ISOLATED', 'szerver szöveg'])
  })

  it('no banner when ready, when rotation is off, or with no answer', () => {
    expect(lines({ ready: true, blockers: [], details: [] })).toBeNull()
    expect(lines({ ready: false, blockers: ['rotation_disabled', 'main_agent_not_isolated'], details: [] })).toBeNull()
    expect(lines(null)).toBeNull()
  })
})

describe.skip('readiness i18n coverage', () => {
  const codes = [...SERVER.matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1]).filter((c) => c !== 'rotation_disabled')
  const en = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')
  const hu = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')

  it('finds the server codes', () => {
    expect(codes.length).toBeGreaterThanOrEqual(4)
  })

  it.each(['en', 'hu'])('every banner code has text in %s', (lang) => {
    const src = lang === 'en' ? en : hu
    for (const code of codes) expect(src).toContain(`'settings.claude_plans.readiness.${code}':`)
    expect(src).toContain(`'settings.claude_plans.readiness.title':`)
  })
})

describe.skip('switchToClaudePlan (manual switch / first assignment)', () => {
  function load(confirmAnswer: boolean) {
    const calls: Array<{ url: string; init: any }> = []
    const toasts: string[] = []
    let reloaded = 0
    const fetchStub = async (url: string, init: any) => {
      calls.push({ url, init })
      return { ok: true, json: async () => ({ ok: true }) }
    }
     
    const fn = new Function(
      't', 'confirm', 'fetch', 'showToast', 'loadClaudePlansList',
      `${extractFn('switchToClaudePlan')}; return switchToClaudePlan`,
    )(
      (k: string) => k,
      () => confirmAnswer,
      fetchStub,
      (m: string) => { toasts.push(m) },
      async () => { reloaded++ },
    ) as (plan: { id: string; label: string }) => Promise<void>
    return { fn, calls, toasts, reloaded: () => reloaded }
  }

  it('confirmed: POSTs the plan id as targetPlanId to the rotate route', async () => {
    const h = load(true)
    await h.fn({ id: 'claude7', label: 'Claude 7' })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].url).toBe('/api/claude-plans/rotate')
    expect(h.calls[0].init.method).toBe('POST')
    expect(JSON.parse(h.calls[0].init.body as string)).toEqual({ targetPlanId: 'claude7' })
    expect(h.reloaded()).toBe(1)
  })

  it('declined confirm: no request at all (it restarts the main agent)', async () => {
    const h = load(false)
    await h.fn({ id: 'claude7', label: 'Claude 7' })
    expect(h.calls).toHaveLength(0)
  })

  it('the row renders the button only for a non-active, channels-allowed plan', () => {
    expect(APP).toMatch(/if \(plan\.channelsAllowed && !isActive\) \{[\s\S]{0,400}switchToClaudePlan\(plan\)/)
  })
})
