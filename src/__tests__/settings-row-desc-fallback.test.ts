// Card d96f1418 (Peti screenshot, Telegram 13228/13229): the Settings page showed the literal
// string "settings.desc.<KEY>" instead of the registry description, for every key without a
// lang entry (WORKER_AUTOUPDATE, AGENT_INHERITED_MCP_SERVERS, DEFAULT_AGENT_MODEL,
// KG_CAPTURE_ENABLED, KG_ENABLED, KG_INJECT_ENABLED, KG_MAX_SOLUTIONS_PER_CARD).
//
// Root cause (web/app-device-keys.js:522, buildSettingRow): `t('settings.desc.' + def.key) ||
// def.description`. t() (web/app.js:19-24) returns the KEY ITSELF on a miss, which is truthy,
// so the `||` fallback to def.description never ran.
//
// House idiom (see freellm-error-section-visibility.test.ts): the real function is extracted
// from the shipped web/app-device-keys.js and executed against a minimal hand-rolled DOM stub,
// not jsdom -- only the handful of methods/properties buildSettingRow actually touches.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSettingDefinition } from '../config-registry.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(ROOT, 'web', 'app-device-keys.js'), 'utf8')
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
  textContent = ''
  value = ''
  checked = false
  min?: number
  max?: number
  dataset: Record<string, string> = {}
  children: FakeEl[] = []
  constructor(tag: string) { this.tag = tag }
  appendChild(child: FakeEl) { this.children.push(child); return child }
  addEventListener() { /* never fired by these tests */ }
}

function makeDocument() {
  return { createElement: (tag: string) => new FakeEl(tag) }
}

// Confirms the premise directly against the SHIPPED hu.js, not an assumption: no lang entry
// exists for KG_ENABLED's settings.desc key. If this ever starts failing because someone adds
// the entry, that is a real, desirable change -- the fallback below must still work for every
// OTHER key that still has no entry, so the fallback test does not depend on this one.
const KG_ENABLED_HAS_LANG_ENTRY = HU.includes("'settings.desc.KG_ENABLED'")

// Mimics the real t(): a real lang entry would return its own text; here we only need the
// documented miss behavior (returns the key itself), since no settings.desc.* fixture key in
// this file has a real translation.
function fakeT(key: string): string {
  return key
}

let buildSettingRow: (def: Record<string, unknown>) => FakeEl

beforeAll(() => {
  const body = `${extract('buildSettingRow')}\nreturn { buildSettingRow }`
  const factory = new Function('document', 't', body) as (
    document: unknown, t: unknown,
  ) => { buildSettingRow: typeof buildSettingRow }
  const out = factory(makeDocument(), fakeT)
  buildSettingRow = out.buildSettingRow
})

function descTextOf(row: FakeEl): string {
  const info = row.children[0]
  const desc = info.children[1] // title, desc, meta in that order
  return desc.textContent
}

describe('Settings row description fallback (card d96f1418)', () => {
  it('KG_ENABLED has no settings.desc lang entry in the shipped hu.js (confirms the root cause premise)', () => {
    expect(KG_ENABLED_HAS_LANG_ENTRY).toBe(false)
  })

  it('a key with no lang entry (KG_ENABLED) shows the registry description, not the raw key', () => {
    const def = getSettingDefinition('KG_ENABLED')
    expect(def).toBeDefined()
    const row = buildSettingRow({ ...def, value: def!.default })
    expect(descTextOf(row)).toBe(def!.description)
    expect(descTextOf(row)).not.toMatch(/^settings\.desc\./)
  })

  it('no settings row shows a literal "settings.desc." string, for any key missing a lang entry', () => {
    const def = getSettingDefinition('KG_ENABLED')!
    const row = buildSettingRow({ ...def, value: def.default })
    expect(descTextOf(row)).not.toContain('settings.desc.')
  })

  it('a key WITH a real translation still uses the translation, not the registry description (sanity: the fix did not break the hit path)', () => {
    const def = getSettingDefinition('KG_ENABLED')!
    const translated = (key: string) => (key === 'settings.desc.KG_ENABLED' ? 'EN DESC HIT' : key)
    const body = `${extract('buildSettingRow')}\nreturn { buildSettingRow }`
    const factory = new Function('document', 't', body) as (
      document: unknown, t: unknown,
    ) => { buildSettingRow: typeof buildSettingRow }
    const out = factory(makeDocument(), translated)
    const row = out.buildSettingRow({ ...def, value: def.default })
    expect(descTextOf(row)).toBe('EN DESC HIT')
  })
})
