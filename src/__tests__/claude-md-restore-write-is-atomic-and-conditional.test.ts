// Card e5c13c0e: a different store/*.selftest.sh was blamed by
// store-selftests-all-run.test.ts's dirty-tracked-tree guard on each of several 51c68eeb/8ca1f91d
// land attempts (offload-dispatch, then mopsion-suite-run) -- both confirmed green and
// tree-clean when run standalone, every time. The common factor was never the named selftest: it
// was claude-md-main-section-writers.test.ts, running concurrently in a sibling vitest worker,
// whose `finally` block used to restore the real git-tracked root CLAUDE.md with a plain
// `writeFileSync` on every one of its ~15+ it.each iterations -- even when the writer under test
// correctly made no change at all. `writeFileSync` truncates the target before writing the new
// bytes (open with O_TRUNC, then a separate write() syscall): not atomic, so a concurrent
// `git status --porcelain` (exactly what the dirty-tree guard runs around each selftest it
// invokes) can observe the file mid-truncate and report "M CLAUDE.md", blaming whichever
// selftest happened to be running at that microsecond in a DIFFERENT worker.
//
// REPRODUCED LIVE (quoted in the card's REVIEW, not re-run here -- a timing race is not suitable
// for an automated suite; card 9b224eec hit the identical tradeoff for a different mutation class
// and settled on a deterministic source-scan instead of a flaky repro, which is what this file
// does too): a tight loop of plain `writeFileSync` truncate-writes of IDENTICAL content to a
// tracked fixture file, polled concurrently with `git status --porcelain`, shows transient
// "M <file>" results; the same loop using atomicWriteFileSync (write-to-sibling-tmp + rename)
// never does, over an equal number of iterations.
//
// THE FIX, in claude-md-main-section-writers.test.ts: a `restoreTrackedFileIfChanged()` helper
// that (1) skips the write ENTIRELY when content already matches the original -- true on every
// passing run, since every writer under test is asserted to be a no-op for MAIN_AGENT_ID, so in
// the common case there is now ZERO write and ZERO race window; (2) when a write IS needed (a
// writer actually broke its no-op contract), goes through atomicWriteFileSync so the one
// unavoidable write is atomic.
import { describe, it, expect } from 'vitest'
import { readFileSync, statSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { restoreTrackedFileIfChanged } from './claude-md-main-section-writers.test.js'

const here = dirname(fileURLToPath(import.meta.url))
const writersTestSrc = readFileSync(join(here, 'claude-md-main-section-writers.test.ts'), 'utf-8')

describe('e5c13c0e: the root-CLAUDE.md restore in claude-md-main-section-writers.test.ts is atomic and conditional', () => {
  // SOURCE-SCAN, mutation-pinned: the one place this file used to call plain `writeFileSync` on
  // the real tracked ROOT_CLAUDE_MD_PATH must now go through restoreTrackedFileIfChanged instead.
  // Revert the fix (put the raw writeFileSync(ROOT_CLAUDE_MD_PATH, ...) line back in the finally
  // block) and this goes red.
  it('the finally block restores ROOT_CLAUDE_MD_PATH via restoreTrackedFileIfChanged, not a raw writeFileSync', () => {
    const financeIdx = writersTestSrc.indexOf('} finally {')
    expect(financeIdx, 'no finally block found -- source shape changed, re-check this scan').toBeGreaterThan(0)
    const financeBlock = writersTestSrc.slice(financeIdx, financeIdx + 400)
    expect(
      financeBlock,
      'the finally block must call restoreTrackedFileIfChanged(ROOT_CLAUDE_MD_PATH, ...), not a raw writeFileSync -- a raw writeFileSync truncates the real tracked file even when content is unchanged, racing every concurrent vitest worker that reads it',
    ).toMatch(/restoreTrackedFileIfChanged\(\s*ROOT_CLAUDE_MD_PATH\s*,/)
    expect(
      financeBlock,
      'a raw writeFileSync(ROOT_CLAUDE_MD_PATH, ...) reappeared in the finally block',
    ).not.toMatch(/\bwriteFileSync\(\s*ROOT_CLAUDE_MD_PATH\s*,/)
  })

  it('restoreTrackedFileIfChanged is exported and delegates to atomicWriteFileSync, not writeFileSync', () => {
    // Narrow, source-level check on the helper itself (behavioural coverage is below): the
    // function body must reference atomicWriteFileSync for its actual disk write.
    const fnStart = writersTestSrc.indexOf('export function restoreTrackedFileIfChanged')
    expect(fnStart, 'restoreTrackedFileIfChanged is no longer exported from this file').toBeGreaterThan(0)
    const fnBody = writersTestSrc.slice(fnStart, fnStart + 600)
    expect(fnBody).toMatch(/atomicWriteFileSync\(/)
  })

  it('BEHAVIOUR: when content is unchanged, zero writes happen (mtime and content untouched)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-md-restore-'))
    const path = join(dir, 'CLAUDE.md')
    try {
      const original = '# fixture root CLAUDE.md\n\nunchanged content\n'
      writeFileSync(path, original, 'utf-8')
      // bigint mode for nanosecond-resolution mtime: a millisecond-resolution check could miss a
      // write/rename that completes within the same millisecond, which is common for a fast
      // synchronous call like this one. Inode is checked too (a rename always changes it).
      const before = statSync(path, { bigint: true })

      restoreTrackedFileIfChanged(path, original)

      const after = statSync(path, { bigint: true })
      expect(readFileSync(path, 'utf-8'), 'content changed even though nothing should have written').toBe(original)
      expect(after.mtimeNs, 'mtime moved -- a write syscall happened for unchanged content').toBe(before.mtimeNs)
      expect(after.ino, 'inode changed -- a rename happened for unchanged content').toBe(before.ino)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('BEHAVIOUR: when content differs, it is restored correctly and atomically (inode changes via rename, no half-written content observable in the final read)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-md-restore-'))
    const path = join(dir, 'CLAUDE.md')
    try {
      const original = '# fixture root CLAUDE.md\n\noriginal content\n'
      const drifted = '# fixture root CLAUDE.md\n\nSOMETHING A BUGGY WRITER LEFT BEHIND\n'
      writeFileSync(path, drifted, 'utf-8')
      const inodeBefore = statSync(path).ino

      restoreTrackedFileIfChanged(path, original)

      expect(readFileSync(path, 'utf-8')).toBe(original)
      // atomicWriteFileSync renames a sibling tmp file over the target -- the inode must change.
      // A plain in-place writeFileSync would keep the same inode (the race this card closes).
      expect(statSync(path).ino, 'inode unchanged -- the restore did not go through a rename').not.toBe(inodeBefore)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('BEHAVIOUR: a missing file is created atomically rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-md-restore-'))
    const path = join(dir, 'CLAUDE.md')
    try {
      const original = '# fixture root CLAUDE.md\n\nshould be created\n'
      restoreTrackedFileIfChanged(path, original)
      expect(readFileSync(path, 'utf-8')).toBe(original)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
