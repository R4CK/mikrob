// Card 7d2ebd24: ~/.claude/skills/sp-* were symlinks into a vendored third-party checkout, so the
// fork's own additions to three of those skills (70 lines, card 4a3c75a5) existed on the read path
// only as UNCOMMITTED modifications to somebody else's git repo. A plain `git checkout` there would
// have stripped them from what all 15 agents read, until the next update.sh merged them back.
//
// This runs the converter's selftest. The selftest is hermetic -- it builds fake skills and fake
// vendor trees under a temp dir -- which is deliberate for something that REPLACES directories:
// a test for this must never be able to touch a real ~/.claude.
//
// Wiring it here is not a formality. Measured on this repo the same day: 8 of 11 store/*.selftest.sh
// are referenced by nothing at all and therefore never run, so an unwired selftest is the normal
// outcome, not the unlucky one.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const STORE = join(REPO_ROOT, 'store')
const SCRIPT = join(STORE, 'skills-symlink-to-realdir.sh')

describe('skills symlink -> real directory converter (card 7d2ebd24)', () => {
  it('ships the script and its selftest', () => {
    expect(existsSync(SCRIPT), 'skills-symlink-to-realdir.sh missing').toBe(true)
    expect(existsSync(join(STORE, 'skills-symlink-to-realdir.selftest.sh')), 'selftest missing').toBe(true)
  })

  it('its selftest passes, and reports a COUNTED number of cases', () => {
    const out = execFileSync('bash', [join(STORE, 'skills-symlink-to-realdir.selftest.sh')], {
      encoding: 'utf-8',
      timeout: 120_000,
    })
    expect(out).toMatch(/selftest: [1-9]\d* case\(s\), PASS/)
  })

  // The failure this script exists to avoid is not "the conversion didn't happen" -- it is
  // "the conversion happened INTO the vendored repo". `mv newdir link` moves the directory inside
  // the link's target rather than replacing the link; reproduced in a sandbox before writing it.
  // So the order is pinned here in the source, where a later tidy-up would otherwise undo it.
  it('removes the link BEFORE moving the staged copy, and never with -r', () => {
    const src = readFileSync(SCRIPT, 'utf-8')
    const rmAt = src.indexOf('rm "$link"')
    const mvAt = src.indexOf('mv "$staging" "$link"')
    expect(rmAt, 'the plain `rm "$link"` step is gone -- the staged copy would land in the vendored repo').toBeGreaterThan(-1)
    expect(mvAt).toBeGreaterThan(-1)
    expect(rmAt, 'the link must be removed BEFORE the move, or mv follows it into the vendor tree').toBeLessThan(mvAt)
    // `rm -rf "$link"` (or a trailing slash) would follow the link and delete the vendored files.
    expect(src).not.toMatch(/rm\s+-[a-z]*r[a-z]*\s+"\$link"/)
    expect(src).not.toMatch(/rm\s+.*"\$link\/"/)
  })

  it('verifies the staged copy against the source BEFORE touching the link', () => {
    const src = readFileSync(SCRIPT, 'utf-8')
    const verifyAt = src.indexOf('hash_tree "$target"')
    const rmAt = src.indexOf('rm "$link"')
    expect(verifyAt, 'the pre-swap hash verification is gone').toBeGreaterThan(-1)
    expect(verifyAt, 'the copy must be verified before the link is removed, not after').toBeLessThan(rmAt)
  })
})
