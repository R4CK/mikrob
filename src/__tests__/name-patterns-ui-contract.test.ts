import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Card 98dbbcc9 -- the FRONTEND half. These are source-contract checks, not DOM tests: the
// panel is plain DOM built by a classic script, and the failure modes worth pinning are
// structural (a key that renders as "names.title", a pattern interpolated unescaped, a
// section that exists but is never called, a slice never loaded by index.html).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const JS = readFileSync(join(ROOT, 'web', 'app-settings-auth.js'), 'utf8')
const HU = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const EN = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')
const INDEX = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')

function definedKeys(src: string): Set<string> {
  return new Set([...src.matchAll(/^ {2}'([^']+)':/gm)].map((m) => m[1]))
}

describe('name-patterns panel i18n', () => {
  const used = [...JS.matchAll(/\bt\('(names\.[^']+)'/g)].map((m) => m[1])
  const hu = definedKeys(HU)
  const en = definedKeys(EN)

  it('uses at least the keys this panel needs', () => {
    expect(used.length).toBeGreaterThanOrEqual(15)
  })

  it('every key the panel renders is defined in BOTH locales', () => {
    // Rule 12: a user-facing error must come from an i18n key in every configured language.
    // A key present in one locale only renders as the raw key string in the other.
    const missingHu = used.filter((k) => !hu.has(k))
    const missingEn = used.filter((k) => !en.has(k))
    expect({ missingHu, missingEn }).toEqual({ missingHu: [], missingEn: [] })
  })

  it('the two locales define the SAME names.* key set', () => {
    const onlyHu = [...hu].filter((k) => k.startsWith('names.') && !en.has(k))
    const onlyEn = [...en].filter((k) => k.startsWith('names.') && !hu.has(k))
    expect({ onlyHu, onlyEn }).toEqual({ onlyHu: [], onlyEn: [] })
  })

  it('has a distinct message for each of the gate\'s three states', () => {
    for (const k of ['names.state.active', 'names.state.empty', 'names.state.broken']) {
      expect(hu.has(k), `hu missing ${k}`).toBe(true)
      expect(en.has(k), `en missing ${k}`).toBe(true)
    }
  })
})

describe('name-patterns panel wiring', () => {
  it('is actually called from renderAuthCard, not merely defined', () => {
    // A rendered-but-never-mounted section is the failure this fleet has shipped before.
    expect(JS).toMatch(/renderNamePatternsSection\(body\)/)
    const defAt = JS.indexOf('async function renderNamePatternsSection')
    const callAt = JS.indexOf('void renderNamePatternsSection(body)')
    expect(defAt).toBeGreaterThan(-1)
    expect(callAt).toBeGreaterThan(-1)
    expect(callAt).not.toBe(defAt)
  })

  it('is loaded by index.html', () => {
    expect(INDEX).toContain('/app-settings-auth.js')
  })

  it('talks to the real endpoint with all three methods', () => {
    expect(JS).toContain("fetch('/api/security/name-patterns')")
    expect(JS).toMatch(/method: 'POST'[\s\S]{0,200}JSON\.stringify\(\{ value, mode \}\)/)
    expect(JS).toMatch(/method: 'DELETE'[\s\S]{0,200}JSON\.stringify\(\{ pattern \}\)/)
  })

  it('surfaces the server\'s specific reason rather than swallowing it', () => {
    // The server explains WHICH regex construct failed, or that the pattern backtracks.
    // Replacing that with a generic string would throw away the only actionable part.
    expect((JS.match(/data\.error \|\| t\('names\.err_generic'\)/g) || []).length).toBeGreaterThanOrEqual(2)
  })

  it('escapes every stored pattern before putting it in innerHTML', () => {
    // Patterns are operator input rendered into innerHTML on the page that manages a
    // security control; an unescaped one is self-inflicted XSS.
    const row = JS.slice(JS.indexOf('listEl.innerHTML = pats.map'), JS.indexOf(".join('')"))
    expect(row).toContain('escapeHtml(p)')
    expect(row).not.toMatch(/\$\{p\}/)
  })

  it('confirms before a destructive removal', () => {
    expect(JS).toMatch(/confirm\(t\('names\.confirm_remove'\)\)/)
  })

  it('disables editing when the server reports a worktree-hosted dashboard', () => {
    expect(JS).toContain('data.read_only === true')
    expect(JS).toMatch(/addBtn\.disabled = readOnly/)
  })
})
