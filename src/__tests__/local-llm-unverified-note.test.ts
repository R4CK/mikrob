// String-contract guard for card 3ff05447 (Cybered-derived follow-up to a34effcb): the catalogue
// sort already puts trusted publishers first WITHIN a size tier (llm-catalog.py), so an untrusted
// GROUP appearing in the recommendation list means nothing reviewed was left at that tier -- but
// that was only visible as an absence (the per-group badge), never explained. Follows the house
// idiom (see local-llm-catalog-ui-wiring.test.ts): app.js read as a string, asserted against
// short, formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_CORE = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const LLM_MODULE = readFileSync(join(__dirname, '../../web/app-local-llm.js'), 'utf-8')
const APP = APP_CORE + '\n' + LLM_MODULE
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

describe('unverified-publisher summary line (card 3ff05447)', () => {
  it('counts ACTUALLY RENDERED groups, not an assumed top-N -- this view has never sliced the list', () => {
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toContain('_llmRecGroups.filter(variants => !variants[0].trusted).length')
    // The count source is _llmRecGroups itself (already the full, un-sliced set the list
    // renders from), not a separate/derived list that could drift from what's on screen.
  })

  it('VACUUM CONTROL: the note is omitted entirely when there are zero unverified groups', () => {
    // A summary line that always renders (even reading "0 unverified") is decoration with no
    // information value -- the card's own closing acceptance criterion.
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toContain('unverifiedCount > 0')
    expect(body).toMatch(/const unverifiedNoteHtml = unverifiedCount > 0\s*\n\s*\?/)
  })

  it('the note text comes from i18n with a {count} interpolation, never hardcoded (rule 12)', () => {
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toContain("t('localLlm.rec.unverified_note', { count: unverifiedCount })")
  })

  it('the note is escaped before insertion (it wraps a translated, not raw-HTML, string)', () => {
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toMatch(/escapeHtml\(t\('localLlm\.rec\.unverified_note'/)
  })
})

describe('missing digest is an explicit statement, not silent absence (card 3ff05447, item 2)', () => {
  it('renders a distinct "no digest published" label instead of omitting the span entirely', () => {
    const body = fnBody(APP, 'function llmRecVariantBodyHtml(m)')
    expect(body).toContain("t('localLlm.rec.digest_missing')")
    expect(body).toContain('llm-rec-digest-missing')
  })

  it('SECURITY: still only the 8-char prefix when a digest DOES exist -- the missing-label path does not touch that', () => {
    const body = fnBody(APP, 'function llmRecVariantBodyHtml(m)')
    expect(body).toContain('m.parts[0].sha256).slice(0, 8)')
  })
})

describe('i18n parity (rule 12)', () => {
  const KEYS = ['localLlm.rec.unverified_note', 'localLlm.rec.digest_missing']
  it.each(KEYS)('%s exists in hu.js', (key) => {
    expect(HU).toContain(`'${key}':`)
  })
  it.each(KEYS)('%s exists in en.js', (key) => {
    expect(EN).toContain(`'${key}':`)
  })
  it('the Hungarian note explains WHY the entries appear, not just that they exist', () => {
    const idx = HU.indexOf("'localLlm.rec.unverified_note':")
    const line = HU.slice(idx, HU.indexOf('\n', idx))
    expect(line).toContain('{count}')
    // "miért látszanak" / "nem maradt ellenőrzött" -- the reason, not just a bare count.
    expect(line).toMatch(/mi[eé]rt|nem maradt/i)
  })
})

describe('CSS: informational tone, not just color (rule 13)', () => {
  it('defines the unverified-note banner and the missing-digest label', () => {
    expect(CSS).toContain('.llm-rec-unverified-note {')
    expect(CSS).toContain('.llm-rec-digest-missing {')
  })
})
