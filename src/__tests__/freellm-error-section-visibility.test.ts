// Card fd5fcc2c, MikroB decision (comment 25258) on RedHat N1 + QA F3 (25256/25239): the
// #freellmErrorSection WRAPPER shipped with the `hidden` attribute in index.html and nothing ever
// cleared it -- only the inner #freellmLastError text node was being touched by the old
// freellmRenderStatus, so a stopped freellmapi server's lastError rendered into an invisible
// parent. This is a rule-12 failure: the done-criterion 2 text ("descriptive error state, not an
// empty panel") was not met even though the inner text was set correctly.
//
// House idiom (see overview-quota-strip.test.ts): the real functions are extracted from the
// shipped web/app-freellm.js and executed against a minimal hand-rolled DOM stub -- not jsdom,
// just the handful of methods/properties the functions actually touch (getElementById +
// hidden/className/textContent/value).
//
// This test is a PIN: reverting the fix (removing the `section.hidden = false` line, or routing
// freellmRenderStatus back to only touch #freellmLastError) must turn it red.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(ROOT, 'web', 'app-freellm.js'), 'utf8')
const HTML = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')
const CSS = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8')
const EN = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')
const HU = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')

function extract(name: string): string {
  let start = SRC.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`missing function ${name}`)
  // Preserve a leading `async` -- otherwise an extracted async function's `await` throws a
  // SyntaxError when re-embedded as a plain (non-async) declaration.
  if (SRC.slice(Math.max(0, start - 6), start) === 'async ') start -= 6
  let depth = 0
  let i = SRC.indexOf('{', start)
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') { depth--; if (depth === 0) break }
  }
  return SRC.slice(start, i + 1)
}

class FakeEl {
  tag: string
  className = ''
  hidden = false
  textContent = ''
  value = ''
  checked = false
  disabled = false
  private listeners: Record<string, Array<() => void>> = {}
  constructor(tag: string) { this.tag = tag }
  addEventListener(event: string, cb: () => void) {
    ;(this.listeners[event] ||= []).push(cb)
  }
  /** Test helper, not a real DOM method: fires every listener registered for `event`. */
  dispatch(event: string) {
    (this.listeners[event] || []).forEach((cb) => cb())
  }
}

function makeDom(ids: string[], initiallyHidden: string[] = []) {
  const registry = new Map<string, FakeEl>()
  for (const id of ids) {
    const el = new FakeEl('div')
    if (initiallyHidden.includes(id)) el.hidden = true
    registry.set(id, el)
  }
  const document = { getElementById: (id: string) => registry.get(id) ?? null }
  return { document, els: registry }
}

// Real template text for the one key whose interpolated VALUE matters to a test below (D3b: the
// masked value must actually show up, or not, in the rendered text -- a stub that just echoed the
// key name back would never notice a guard bypass, since the raw value would be silently dropped).
// Sourced from web/lang/en.js 'freellm.keys.status_set'. Every other key the tests touch only
// needs the key name itself (no test asserts on their interpolated text), so the fallback stays
// the key verbatim, same as before.
const T_TEMPLATES: Record<string, string> = {
  'freellm.keys.status_set': 'Set, {masked}',
}
/** Mimics the real t(): known key -> its real template with {param} interpolation, else the key itself. */
function fakeT(key: string, params: Record<string, unknown> = {}): string {
  const template = T_TEMPLATES[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_: string, k: string) => String(params[k] ?? `{${k}}`))
}

let renderStatus: (data: Record<string, unknown>) => void
let dom: ReturnType<typeof makeDom>

beforeAll(() => {
  const body =
    `${extract('freellmShowErrorSection')}\n${extract('freellmHideErrorSection')}\n` +
    `${extract('freellmResetStatusDisplay')}\n${extract('freellmRenderStatus')}\n` +
    'return { freellmRenderStatus }'
  const factory = new Function('document', 't', body) as (
    document: unknown, t: unknown,
  ) => { freellmRenderStatus: typeof renderStatus }
  dom = makeDom(
    ['freellmToggle', 'freellmLabel', 'freellmCallsCount', 'freellmDraftsCount', 'freellmErrorSection', 'freellmLastError'],
    ['freellmErrorSection'], // matches the real index.html: ships with the hidden attribute
  )
  const out = factory(dom.document, fakeT)
  renderStatus = out.freellmRenderStatus
})

describe('freellm error section visibility (card fd5fcc2c, RedHat N1 / QA F3 pin)', () => {
  it('starts hidden, matching the shipped HTML', () => {
    expect(dom.els.get('freellmErrorSection')!.hidden).toBe(true)
  })

  it('a status response carrying lastError unhides the WRAPPER section, not just the inner text', () => {
    renderStatus({ enabled: true, calls: 1, drafts: 0, lastError: 'connect ECONNREFUSED 127.0.0.1:3001' })
    expect(dom.els.get('freellmErrorSection')!.hidden).toBe(false)
    expect(dom.els.get('freellmLastError')!.textContent).toBe('connect ECONNREFUSED 127.0.0.1:3001')
  })

  it('a subsequent clean status response hides the section again', () => {
    renderStatus({ enabled: true, calls: 1, drafts: 0, lastError: 'boom' })
    expect(dom.els.get('freellmErrorSection')!.hidden).toBe(false)
    renderStatus({ enabled: true, calls: 1, drafts: 0 })
    expect(dom.els.get('freellmErrorSection')!.hidden).toBe(true)
    expect(dom.els.get('freellmLastError')!.textContent).toBe('')
  })

  it('an error payload resets the stale calls/drafts/label instead of leaving the last good values (card 5ae7e8be pt.4 / WhiteHat2 R3)', () => {
    renderStatus({ enabled: true, calls: 7, drafts: 3 }) // a healthy load first, so there IS stale state to clear
    expect(dom.els.get('freellmCallsCount')!.textContent).toBe('7')
    renderStatus({ enabled: true, calls: 7, drafts: 3, lastError: 'connect ECONNREFUSED' })
    expect(dom.els.get('freellmCallsCount')!.textContent).toBe('—')
    expect(dom.els.get('freellmDraftsCount')!.textContent).toBe('—')
    expect(dom.els.get('freellmLabel')!.textContent).toBe('—')
    expect(dom.els.get('freellmToggle')!.disabled).toBe(true)
    // A subsequent healthy response re-enables the toggle and restores real numbers.
    renderStatus({ enabled: true, calls: 8, drafts: 3 })
    expect(dom.els.get('freellmCallsCount')!.textContent).toBe('8')
    expect(dom.els.get('freellmToggle')!.disabled).toBe(false)
  })

  it('does not double-escape the error text (RedHat N2 / WhiteHat2 F1 cosmetic fix)', () => {
    renderStatus({ enabled: true, calls: 0, drafts: 0, lastError: 'bad <token> & "quote"' })
    // textContent is assigned the raw string; the DOM itself (not this stub) is what would render
    // it safely on a real page. The old code pre-escaped before assigning to textContent, which
    // would have shown literal "&lt;" here instead of "<".
    expect(dom.els.get('freellmLastError')!.textContent).toBe('bad <token> & "quote"')
  })
})

describe('freellm error section: static wiring in the shipped page', () => {
  it('the retry button exists inside the error section and has an i18n label', () => {
    const section = HTML.slice(HTML.indexOf('id="freellmErrorSection"'), HTML.indexOf('id="freellmErrorSection"') + 500)
    expect(section).toContain('id="freellmErrorRetryBtn"')
    expect(section).toContain('data-i18n="freellm.error.retry"')
  })

  it('freellm.error.retry exists in both hu.js and en.js', () => {
    expect(HU).toContain("'freellm.error.retry':")
    expect(EN).toContain("'freellm.error.retry':")
  })
})

describe('freellm key inputs use autocomplete=new-password (RedHat KC5)', () => {
  it('all 5 provider key inputs use new-password, not off (Chromium ignores off on password fields)', () => {
    for (const provider of ['groq', 'cerebras', 'google_ai_studio', 'openrouter', 'mistral']) {
      const marker = `id="freellmKeyInput_${provider}"`
      const idx = HTML.indexOf(marker)
      expect(idx).toBeGreaterThan(-1)
      const tag = HTML.slice(idx, idx + 250)
      expect(tag).toContain('autocomplete="new-password"')
      expect(tag).not.toContain('autocomplete="off"')
    }
  })
})

describe('freellm masked-value shape guard (WhiteHat2 F1)', () => {
  function extractLooksMasked(): (m: unknown) => boolean {
    const src = extract('freellmLooksMasked')
    const factory = new Function(src + '\nreturn freellmLooksMasked')
    return factory()
  }

  it('accepts the backend\'s own short masked shapes', () => {
    const looksMasked = extractLooksMasked()
    expect(looksMasked('***ABCD')).toBe(true)
    expect(looksMasked('***...1234')).toBe(true)
  })

  it('rejects a value that is not actually masked (e.g. a full key leaking through a buggy backend)', () => {
    const looksMasked = extractLooksMasked()
    expect(looksMasked('this-is-definitely-not-a-masked-value-at-all')).toBe(false)
    expect(looksMasked('')).toBe(false)
    expect(looksMasked(undefined)).toBe(false)
    expect(looksMasked(null)).toBe(false)
  })

  // WhiteHat2 R1 (25351, card 5ae7e8be pt.3): the OLD guard (`^\*{2,}` + 20-char cap) accepted
  // this exact value, showing 16 real characters against the UI's "last 4 only" promise. The
  // specific case WhiteHat2 asked be added to the pin test.
  it('rejects four asterisks followed by 16 letters (R1: more than the last 4 chars must never show)', () => {
    const looksMasked = extractLooksMasked()
    expect(looksMasked('****' + 'A'.repeat(16))).toBe(false)
  })

  it('still accepts the real upstream short-mask shapes after the R1 tightening', () => {
    const looksMasked = extractLooksMasked()
    expect(looksMasked('****')).toBe(true) // shorter-than-8 keys: four asterisks alone
    expect(looksMasked('****AB')).toBe(true) // 5-8 char keys: four asterisks + 2
    expect(looksMasked('***...abcd')).toBe(true) // 9+ char keys: the dotted first4...last4 TAIL shape, masked prefix + 4
  })
})

describe('freellm key field clearing on page-leave (WhiteHat2 F2)', () => {
  it('freellmClearKeyFields empties every provider input', () => {
    const providers = ['groq', 'cerebras', 'google_ai_studio', 'openrouter', 'mistral']
    const ids = providers.map((p) => `freellmKeyInput_${p}`)
    const stub = makeDom(ids)
    for (const id of ids) stub.els.get(id)!.value = 'typed-but-unsaved-secret'

    const body = `const FREELLM_PROVIDERS = ${JSON.stringify(providers)}\n${extract('freellmClearKeyFields')}\nreturn { freellmClearKeyFields }`
    const factory = new Function('document', body) as (document: unknown) => { freellmClearKeyFields: () => void }
    const out = factory(stub.document)
    out.freellmClearKeyFields()

    for (const id of ids) expect(stub.els.get(id)!.value).toBe('')
  })
})

// --- D3 (RedHat 25333): the existing pin above exercises the FIXES, but a 12-case mutation batch
// found four wiring paths with zero coverage -- a regression in any of them would ship silently.
// Each test below was verified red against a one-line-reverted scratch copy before this file was
// committed (not re-run automatically here; see the REVIEW for the mutation log).

describe('D3a: a rejecting status fetch still shows the error section (the catch branch itself)', () => {
  it('freellmLoadStatus shows the wrapper + the load_error message when the GET throws', async () => {
    const dom2 = makeDom(
      ['freellmToggle', 'freellmLabel', 'freellmCallsCount', 'freellmDraftsCount', 'freellmErrorSection', 'freellmLastError', 'freellmMsg'],
      ['freellmErrorSection'],
    )
    const body =
      `${extract('freellmMsg')}\n${extract('freellmShowErrorSection')}\n${extract('freellmHideErrorSection')}\n` +
      `${extract('freellmResetStatusDisplay')}\n${extract('freellmRenderStatus')}\n${extract('freellmLoadStatus')}\n` +
      'return { freellmLoadStatus }'
    const factory = new Function('document', 't', 'fetch', body) as (
      document: unknown, t: unknown, fetch: unknown,
    ) => { freellmLoadStatus: () => Promise<void> }
    const rejectingFetch = vi.fn().mockRejectedValue(new Error('network down'))
    const { freellmLoadStatus } = factory(dom2.document, fakeT, rejectingFetch)

    dom2.els.get('freellmCallsCount')!.textContent = '7' // stale value from a prior good load
    expect(dom2.els.get('freellmErrorSection')!.hidden).toBe(true) // sanity: starts hidden
    await freellmLoadStatus()

    expect(dom2.els.get('freellmErrorSection')!.hidden).toBe(false)
    expect(dom2.els.get('freellmLastError')!.textContent).toBe('freellm.load_error')
    expect(dom2.els.get('freellmMsg')!.textContent).toBe('freellm.load_error')
    // card 5ae7e8be pt.4: a fully failed fetch is the strongest "no fresh data" case, so the
    // stale calls counter must not keep reading "7" underneath the error.
    expect(dom2.els.get('freellmCallsCount')!.textContent).toBe('—')
  })
})

describe('D3b: the key row never renders a raw/unmasked backend value, even if called directly', () => {
  it('freellmRenderKeyRow substitutes the generic marker for a value that fails the mask-shape guard', () => {
    const ids = ['freellmKeyInput_groq', 'freellmKeyStatus_groq', 'freellmKeyDeleteBtn_groq']
    const stub = makeDom(ids)
    const rawUnmasked = 'totally-raw-unmasked-value-that-should-never-render-verbatim'
    const body =
      `let _freellmKeysByProvider = { groq: { provider: 'groq', masked: ${JSON.stringify(rawUnmasked)} } }\n` +
      `${extract('freellmLooksMasked')}\n${extract('freellmRenderKeyRow')}\nreturn { freellmRenderKeyRow }`
    const factory = new Function('document', 't', body) as (
      document: unknown, t: unknown,
    ) => { freellmRenderKeyRow: (provider: string) => void }
    const { freellmRenderKeyRow } = factory(stub.document, fakeT)

    freellmRenderKeyRow('groq')

    const status = stub.els.get('freellmKeyStatus_groq')!.textContent
    expect(status).not.toContain(rawUnmasked)
    expect(status).toBe('Set, ***')
  })
})

describe('D3c: stopFreellmPoll actually calls freellmClearKeyFields, not just a standalone helper', () => {
  it('calling stopFreellmPoll (the real page-leave hook) empties the key inputs', () => {
    const providers = ['groq', 'cerebras', 'google_ai_studio', 'openrouter', 'mistral']
    const ids = providers.map((p) => `freellmKeyInput_${p}`)
    const stub = makeDom(ids)
    for (const id of ids) stub.els.get(id)!.value = 'typed-but-unsaved-secret'

    const body =
      `const FREELLM_PROVIDERS = ${JSON.stringify(providers)}\n` +
      `let _freellmStatusPollTimer = null\n${extract('freellmClearKeyFields')}\n${extract('stopFreellmPoll')}\n` +
      'return { stopFreellmPoll }'
    const factory = new Function('document', 'clearInterval', body) as (
      document: unknown, clearInterval: unknown,
    ) => { stopFreellmPoll: () => void }
    const { stopFreellmPoll } = factory(stub.document, vi.fn())

    stopFreellmPoll()

    for (const id of ids) expect(stub.els.get(id)!.value).toBe('')
  })
})

describe('D3d: the Retry button is actually bound to re-run the status load', () => {
  it('freellmSetup wires #freellmErrorRetryBtn to call freellmLoadStatus on click', () => {
    const dom3 = makeDom(['freellmToggle', 'freellmErrorRetryBtn'])
    const loadStatusSpy = vi.fn()
    const postStatusSpy = vi.fn()
    const body =
      'let _freellmToggleBound = false\nlet _freellmRetryBound = false\n' +
      `${extract('freellmSetup')}\nreturn { freellmSetup }`
    const factory = new Function('document', 'freellmLoadStatus', 'freellmPostStatus', body) as (
      document: unknown, freellmLoadStatus: unknown, freellmPostStatus: unknown,
    ) => { freellmSetup: () => void }
    const { freellmSetup } = factory(dom3.document, loadStatusSpy, postStatusSpy)

    freellmSetup() // also calls freellmLoadStatus() once on its own, by design
    expect(loadStatusSpy).toHaveBeenCalledTimes(1)

    dom3.els.get('freellmErrorRetryBtn')!.dispatch('click')
    expect(loadStatusSpy).toHaveBeenCalledTimes(2)
  })
})

describe('D3e: the mask-shape guard rejects an implausibly long value even if its length cap is loosened', () => {
  it('a masked-looking but very long value is rejected (closes the "cap raised 20->2000" mutation gap)', () => {
    const src = extract('freellmLooksMasked')
    const factory = new Function(src + '\nreturn freellmLooksMasked') as () => (m: unknown) => boolean
    const looksMasked = factory()
    expect(looksMasked('***' + 'x'.repeat(40))).toBe(false)
  })
})

// --- D4 (RedHat 25333): the Retry button was 68x38px at 375px width, under the 44px touch target
// (rule 13). Fixed by extending the existing #localLlmPage min-height convention to #freellmPage.
describe('D4: freellm buttons meet the 44px touch-target minimum (rule 13)', () => {
  it('scopes a 44px min-height rule to #freellmPage, matching the #localLlmPage convention', () => {
    expect(CSS).toMatch(/#freellmPage \.btn-compact,\s*\n#freellmPage \.btn-primary,\s*\n#freellmPage \.btn-secondary \{ min-height: 44px; \}/)
  })
})
