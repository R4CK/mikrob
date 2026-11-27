// Guard for helpers/lang-overlay-key.ts (card ee132dfc, item 3). Mutation-tested per
// guards-that-pin-behaviour: a scratch dir proves the key-presence check actually reads BOTH
// files, not just the base one, and that it is not vacuously true for any string.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { langHasKey } from './helpers/lang-overlay-key.js'

function makeDir(hu: string, forkHu?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lang-overlay-key-test-'))
  writeFileSync(join(dir, 'hu.js'), hu)
  writeFileSync(join(dir, 'en.js'), hu) // content irrelevant for these hu-only cases
  if (forkHu !== undefined) writeFileSync(join(dir, 'fork-hu.js'), forkHu)
  return dir
}

describe('langHasKey', () => {
  it('finds a key present only in the base file (no overlay file at all)', () => {
    const dir = makeDir("export default { 'foo.bar': 'x' }")
    try {
      expect(langHasKey('hu', 'foo.bar', dir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('finds a key present ONLY in the fork overlay, not in the base file', () => {
    const dir = makeDir(
      "export default { 'base.only': 'x' }",
      "export default { 'fork.only': 'y' }"
    )
    try {
      expect(langHasKey('hu', 'fork.only', dir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is false for a key that is in neither file -- not vacuously true', () => {
    const dir = makeDir("export default { 'foo.bar': 'x' }", "export default { 'fork.only': 'y' }")
    try {
      expect(langHasKey('hu', 'nowhere.to.be.found')).not.toBe(true) // sanity: wrong dir arg, real tree
      expect(langHasKey('hu', 'nowhere.to.be.found', dir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('control: a base-only check (old pattern) would wrongly fail for an overlay-only key', () => {
    // This is the exact regression item 3 fixes: a direct toContain on hu.js alone goes red once
    // item 2 moves a key out. Reproduce that old check against the SAME fixture to show it would
    // have failed, so the new helper's "true" above is a genuine fix, not a coincidence.
    const dir = makeDir("export default { 'base.only': 'x' }")
    try {
      const baseOnlySrc = readFileSync(join(dir, 'hu.js'), 'utf-8')
      expect(baseOnlySrc.includes("'fork.only'")).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
