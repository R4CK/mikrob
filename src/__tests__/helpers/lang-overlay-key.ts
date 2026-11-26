// Fork-overlay pilot, item 3 (card ee132dfc). Many widget tests assert that an i18n key is
// present by grepping hu.js/en.js SOURCE TEXT directly (`expect(HU).toContain("'key':")`). Item 2
// of the same card moves fork-only/fork-overridden keys out of hu.js/en.js into fork-hu.js/
// fork-en.js, merged over the base dict at load time (web/index.html) -- so a key that used to
// live in hu.js/en.js can now legitimately live in the overlay file instead. A literal-text check
// against the base file alone would go red for a key the app still serves correctly.
//
// This helper checks BOTH files, so a test written against this helper does not care which file
// actually holds the key -- exactly the resolution rule the runtime itself uses. Before item 2
// moves any key, fork-*.js does not exist yet and this is byte-for-byte equivalent to checking
// the base file alone (see the selftest), so converting a test file to use this helper is
// behavior-preserving on its own, independent of when item 2 lands.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LANG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web', 'lang')

function readIfExists(path: string): string {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return ''
  }
}

const CACHE = new Map<string, string>()

/**
 * Base + fork-overlay source text for one language, concatenated. Cached per process per
 * `dir` (the real web/lang dir by default; a test passes its own scratch dir to avoid touching
 * the real tree and to bypass the cache across cases).
 */
export function langSource(lang: 'hu' | 'en', dir: string = LANG_DIR): string {
  const key = `${dir}::${lang}`
  const cached = CACHE.get(key)
  if (cached !== undefined) return cached
  const base = readFileSync(join(dir, `${lang}.js`), 'utf-8')
  const overlay = readIfExists(join(dir, `fork-${lang}.js`))
  const merged = overlay ? `${base}\n${overlay}` : base
  CACHE.set(key, merged)
  return merged
}

/**
 * True when `key` is declared (as `'key':` or a bare `'key'` reference) in hu.js/en.js OR its
 * fork overlay file for `lang`. Replaces a direct `expect(HU).toContain(...)` style check so the
 * assertion survives item 2 moving the key between base and overlay.
 */
export function langHasKey(lang: 'hu' | 'en', key: string, dir: string = LANG_DIR): boolean {
  const src = langSource(lang, dir)
  return src.includes(`'${key}':`) || src.includes(`'${key}'`)
}
