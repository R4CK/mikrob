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
import { getSettingDefinition, SETTINGS_REGISTRY } from '../config-registry.js'
import { langSource } from './helpers/lang-overlay-key.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(ROOT, 'web', 'app-device-keys.js'), 'utf8')
// Fork-overlay pilot item 2 (card ee132dfc) can move a key's settings.desc entry out of
// hu.js/en.js into fork-hu.js/fork-en.js -- langSource() checks base+overlay merged, same
// resolution rule the runtime uses (web/index.html).
const HU = langSource('hu')
const EN = langSource('en')

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

// Card 3163d61b (2026-11-15): KG_ENABLED and the other 39 keys named in the original d96f1418
// repro now have real lang entries in both hu.js and en.js (see the parity describe block
// below) -- the fallback path itself still needs covering, so it is exercised here against a
// SYNTHETIC key that is guaranteed to never collide with a real settings.desc.* entry, rather
// than against a real registry key whose "currently missing" state would silently stop being
// true the next time someone fixes a translation gap.
const SYNTHETIC_MISSING_KEY = '__NO_SUCH_SETTING_KEY_IN_ANY_LANG_FILE__'

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
  it('a key with no lang entry shows the registry description, not the raw key', () => {
    const def = { ...getSettingDefinition('KG_ENABLED')!, key: SYNTHETIC_MISSING_KEY }
    const row = buildSettingRow({ ...def, value: def.default })
    expect(descTextOf(row)).toBe(def.description)
    expect(descTextOf(row)).not.toMatch(/^settings\.desc\./)
  })

  it('no settings row shows a literal "settings.desc." string, for any key missing a lang entry', () => {
    const def = { ...getSettingDefinition('KG_ENABLED')!, key: SYNTHETIC_MISSING_KEY }
    const row = buildSettingRow({ ...def, value: def.default })
    expect(descTextOf(row)).not.toContain('settings.desc.')
  })

  it('a key WITH a real translation still uses the translation, not the registry description (sanity: the fix did not break the hit path)', () => {
    const def = { ...getSettingDefinition('KG_ENABLED')!, key: SYNTHETIC_MISSING_KEY }
    const translated = (key: string) =>
      (key === `settings.desc.${SYNTHETIC_MISSING_KEY}` ? 'EN DESC HIT' : key)
    const body = `${extract('buildSettingRow')}\nreturn { buildSettingRow }`
    const factory = new Function('document', 't', body) as (
      document: unknown, t: unknown,
    ) => { buildSettingRow: typeof buildSettingRow }
    const out = factory(makeDocument(), translated)
    const row = out.buildSettingRow({ ...def, value: def.default })
    expect(descTextOf(row)).toBe('EN DESC HIT')
  })
})

// Card 3163d61b (2026-11-15, Cybersec GO 28972 / QA2 addendum 28980 on d96f1418): 38 (now 40,
// the registry grew by 2 since) of the registry's keys had no settings.desc.<KEY> entry in
// either lang file, so the EN UI fell back to the registry's Hungarian-only description. This
// is the parity check the card's "Kesz, ha" asks for, run against the live SETTINGS_REGISTRY
// (not a hand-typed key list) so it fails the moment a NEW key ships without a lang entry in
// either file -- the actual regression this card exists to prevent.
describe('Settings registry <-> lang-file description parity (card 3163d61b)', () => {
  const missingHu = SETTINGS_REGISTRY.filter((d) => !HU.includes(`'settings.desc.${d.key}'`)).map((d) => d.key)
  const missingEn = SETTINGS_REGISTRY.filter((d) => !EN.includes(`'settings.desc.${d.key}'`)).map((d) => d.key)

  it('every registry key has a settings.desc entry in hu.js', () => {
    expect(missingHu).toEqual([])
  })

  it('every registry key has a settings.desc entry in en.js', () => {
    expect(missingEn).toEqual([])
  })
})
