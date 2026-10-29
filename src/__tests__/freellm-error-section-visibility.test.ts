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
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(ROOT, 'web', 'app-freellm.js'), 'utf8')
const HTML = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')
const EN = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')
const HU = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')

function extract(name: string): string {
  const start = SRC.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`missing function ${name}`)
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
  constructor(tag: string) { this.tag = tag }
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

/** Mimics the real t(): unknown key -> the key itself, with {param} interpolation. */
function fakeT(key: string, params: Record<string, unknown> = {}): string {
  return key.replace(/\{(\w+)\}/g, (_: string, k: string) => String(params[k] ?? `{${k}}`))
}

let renderStatus: (data: Record<string, unknown>) => void
let dom: ReturnType<typeof makeDom>

beforeAll(() => {
  const body =
    `${extract('freellmShowErrorSection')}\n${extract('freellmHideErrorSection')}\n${extract('freellmRenderStatus')}\n` +
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
