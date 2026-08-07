// Card 1bf4f8a4: GET /api/version reports what dist/.built-commit says is actually running (not
// live git HEAD, which can be ahead of an un-rebuilt dist). These test the pure reader against the
// real repo state, matching public-digest.test.ts's convention of not mocking the filesystem.
import { describe, it, expect } from 'vitest'
import { readVersionInfo } from '../web/routes/version.js'

describe('readVersionInfo', () => {
  it('returns the semver from package.json', () => {
    const v = readVersionInfo()
    expect(typeof v.version).toBe('string')
    expect(v.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('commitHash, when present, is a 7-char lowercase hex string', () => {
    const v = readVersionInfo()
    if (v.commitHash !== null) {
      expect(v.commitHash).toMatch(/^[0-9a-f]{7}$/)
    }
  })

  it('buildTime, when present, is a valid ISO timestamp', () => {
    const v = readVersionInfo()
    if (v.buildTime !== null) {
      expect(Number.isNaN(new Date(v.buildTime).getTime())).toBe(false)
    }
  })

  // The two are stamped together from the SAME marker file (its content -> commitHash, its
  // mtime -> buildTime) -- one present without the other would mean the read logic split them
  // incorrectly, not that the underlying data genuinely disagrees.
  it('commitHash and buildTime are both present or both null together', () => {
    const v = readVersionInfo()
    expect(v.commitHash === null).toBe(v.buildTime === null)
  })
})
