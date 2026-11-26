// Fork-overlay pilot, item 2 (card ee132dfc). hu.js/en.js were restored to the upstream merge-base
// text (minus the ~48 keys/language the fork no longer carries at all); every fork-only and
// fork-overridden key moved into fork-hu.js/fork-en.js, merged over the base dict at load time
// (web/index.html, Object.assign, loaded right after hu.js/en.js).
//
// This pins that the split is PURELY mechanical: merging the two files back together must
// reproduce the EXACT pre-split dictionary, snapshotted immediately before the split
// (src/__tests__/fixtures/lang-overlay-pilot-snapshot-{hu,en}.json). Any future edit that adds a
// key to the wrong file, misses updating the overlay, or duplicates a key between the two must
// fail here -- "zero rendering change" is a Kesz-ha criterion on the card, not a one-time claim.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LANG_DIR = join(ROOT, 'web', 'lang')

function mergedDict(lang: 'hu' | 'en'): Record<string, string> {
  const ctx: Record<string, unknown> = { window: {} }
  vm.createContext(ctx)
  vm.runInContext(readFileSync(join(LANG_DIR, `${lang}.js`), 'utf-8'), ctx)
  vm.runInContext(readFileSync(join(LANG_DIR, `fork-${lang}.js`), 'utf-8'), ctx)
  return (ctx.window as { _i18n: Record<string, Record<string, string>> })._i18n[lang]
}

function snapshot(lang: 'hu' | 'en'): Record<string, string> {
  return JSON.parse(
    readFileSync(join(ROOT, 'src/__tests__/fixtures', `lang-overlay-pilot-snapshot-${lang}.json`), 'utf-8')
  )
}

describe('fork-overlay pilot: base + overlay reproduces the pre-split dict exactly', () => {
  it.each(['hu', 'en'] as const)('%s: merged dict has the same keys as the snapshot', (lang) => {
    const merged = mergedDict(lang)
    const snap = snapshot(lang)
    expect(Object.keys(merged).sort()).toEqual(Object.keys(snap).sort())
  })

  it.each(['hu', 'en'] as const)('%s: every key has the EXACT same value as the snapshot', (lang) => {
    const merged = mergedDict(lang)
    const snap = snapshot(lang)
    const diffs = Object.keys(snap).filter((k) => merged[k] !== snap[k])
    expect(diffs, `keys with a value mismatch: ${diffs.slice(0, 5).join(', ')}`).toEqual([])
  })

  it('hu and en define exactly the same key set (parity, both ways)', () => {
    const hu = mergedDict('hu')
    const en = mergedDict('en')
    const huKeys = new Set(Object.keys(hu))
    const enKeys = new Set(Object.keys(en))
    const huOnly = [...huKeys].filter((k) => !enKeys.has(k))
    const enOnly = [...enKeys].filter((k) => !huKeys.has(k))
    expect(huOnly, `hu.js has these keys, en.js is missing them: ${huOnly.slice(0, 5).join(', ')}`).toEqual([])
    expect(enOnly, `en.js has these keys, hu.js is missing them: ${enOnly.slice(0, 5).join(', ')}`).toEqual([])
  })

  it('mutation control: deleting an overlay key is caught (the checks above are not vacuous)', () => {
    const overlaySrc = readFileSync(join(LANG_DIR, 'fork-hu.js'), 'utf-8')
    const withoutOneKey = overlaySrc.replace(/^\s*'overview\.quota\.strip_title'\s*:.*\n/m, '')
    expect(withoutOneKey, 'the mutation must actually remove a line for this control to mean anything').not.toBe(overlaySrc)
    const ctx: Record<string, unknown> = { window: {} }
    vm.createContext(ctx)
    vm.runInContext(readFileSync(join(LANG_DIR, 'hu.js'), 'utf-8'), ctx)
    vm.runInContext(withoutOneKey, ctx)
    const mutated = (ctx.window as { _i18n: Record<string, Record<string, string>> })._i18n.hu
    const snap = snapshot('hu')
    expect(mutated['overview.quota.strip_title']).not.toBe(snap['overview.quota.strip_title'])
  })
})
