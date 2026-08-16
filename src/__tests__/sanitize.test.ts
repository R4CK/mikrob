import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { findSymlinkTaintedEntries } from '../web/sanitize.js'

// Card bb0ae7fa: this walk used to exist twice, byte-identical, in
// routes/skills.ts and routes/agents-skills.ts. Consolidated to one helper so
// a future fix lands once, not in whichever copy someone remembers to touch.
describe('findSymlinkTaintedEntries', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'symlink-taint-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not flag a plain file entry', () => {
    writeFileSync(join(dir, 'clean.txt'), 'hi')
    expect(findSymlinkTaintedEntries(dir, ['clean.txt'])).toEqual([])
  })

  it('does not flag a plain directory with only regular files inside', () => {
    mkdirSync(join(dir, 'clean-dir'))
    writeFileSync(join(dir, 'clean-dir', 'SKILL.md'), '# ok')
    expect(findSymlinkTaintedEntries(dir, ['clean-dir'])).toEqual([])
  })

  it('flags an entry that is itself a symlink', () => {
    writeFileSync(join(dir, 'target.txt'), 'x')
    symlinkSync(join(dir, 'target.txt'), join(dir, 'link.txt'))
    expect(findSymlinkTaintedEntries(dir, ['link.txt'])).toEqual(['link.txt'])
  })

  it('flags a directory containing a symlink NESTED several levels deep', () => {
    mkdirSync(join(dir, 'archive', 'nested', 'deeper'), { recursive: true })
    writeFileSync(join(dir, 'outside-target.txt'), 'x')
    symlinkSync(join(dir, 'outside-target.txt'), join(dir, 'archive', 'nested', 'deeper', 'evil-link'))
    expect(findSymlinkTaintedEntries(dir, ['archive'])).toEqual(['archive'])
  })

  it('does not throw and silently skips an entry that no longer exists', () => {
    expect(findSymlinkTaintedEntries(dir, ['missing-entry'])).toEqual([])
  })

  it('only flags the tainted entry among several, not its clean siblings', () => {
    writeFileSync(join(dir, 'a.txt'), 'a')
    writeFileSync(join(dir, 'target.txt'), 'x')
    symlinkSync(join(dir, 'target.txt'), join(dir, 'b-link.txt'))
    mkdirSync(join(dir, 'c-dir'))
    writeFileSync(join(dir, 'c-dir', 'file.txt'), 'c')
    expect(findSymlinkTaintedEntries(dir, ['a.txt', 'b-link.txt', 'c-dir'])).toEqual(['b-link.txt'])
  })
})
