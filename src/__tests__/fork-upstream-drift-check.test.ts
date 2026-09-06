// Card 99c2eb09 (parent 1f276349): the upstream-drift check as a runnable thing, exercised
// HERMETICALLY.
//
// The whole point of the card is that this check must stop depending on a live upstream fetch from
// inside the landing gate. So its own tests must not reintroduce that: every case here drives
// runDriftCheck through the injected GitRunner seam, with no remote, no fetch and no real merge.
// The one thing a seam cannot prove -- that the real invocation still produces the same verdict the
// suite used to assert -- was measured once, by hand, against the live upstream, and recorded in
// DECISIONS.md rather than turned into a networked test.
import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import {
  runDriftCheck,
  formatDriftReport,
  isClean,
  UPSTREAM_REMOTE,
  UPSTREAM_BRANCH,
  type GitRunner,
} from '../fork-upstream/drift-check.js'
import { ACKNOWLEDGED_UPSTREAM_BLOBS } from '../fork-upstream/acknowledged-conflicts.js'

const ACK_FILE = Object.keys(ACKNOWLEDGED_UPSTREAM_BLOBS)[0]!
const ACK_BLOB = (ACKNOWLEDGED_UPSTREAM_BLOBS as Readonly<Record<string, string>>)[ACK_FILE]!

interface FakeOpts {
  reachable?: boolean
  /** Files the merge should report as conflicted. Empty = clean merge. */
  conflicts?: string[]
  /** Upstream blob per file; absent = `git rev-parse` fails, i.e. deleted upstream. */
  blobs?: Record<string, string>
  /** Text written into the worktree for a conflicted file, so hunk capture has something to read. */
  contents?: Record<string, string>
}

/** Records every git invocation so the cleanup path can be asserted, not assumed. */
function fakeGit(opts: FakeOpts): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = []
  const conflicts = opts.conflicts ?? []
  const git: GitRunner = (args, cwd) => {
    calls.push([...args])
    const [verb] = args
    if (verb === 'remote' || verb === 'ls-remote') {
      if (opts.reachable === false) throw new Error('no upstream')
      return ''
    }
    if (verb === 'merge' && args[1] !== '--abort') {
      if (conflicts.length === 0) return ''
      for (const f of conflicts) {
        const body = opts.contents?.[f]
        if (body !== undefined) {
          // The throwaway worktree is a bare temp dir here, so a nested path needs its parent.
          mkdirSync(dirname(join(cwd, f)), { recursive: true })
          writeFileSync(join(cwd, f), body)
        }
      }
      throw new Error('merge conflict')
    }
    if (verb === 'diff') return conflicts.join('\n')
    if (verb === 'rev-parse') {
      const file = String(args[1]).split(':').slice(1).join(':')
      const blob = opts.blobs?.[file]
      if (blob === undefined) throw new Error('no such path upstream')
      return blob + '\n'
    }
    return ''
  }
  return { git, calls }
}

describe('runDriftCheck (card 99c2eb09)', () => {
  it('an unreachable upstream is a SKIP, not a drift -- a watcher must not open a card for it', () => {
    // Same discipline the old test had: an environment fact is not a defect. Reporting drift here
    // would have the scheduled watcher file a card every time the network hiccups.
    const { git } = fakeGit({ reachable: false })
    const r = runDriftCheck('/tmp', git)
    expect(r.reachable).toBe(false)
    expect(isClean(r)).toBe(true)
    expect(formatDriftReport(r)).toContain('SKIPPED')
  })

  it('a clean merge is clean', () => {
    const { git } = fakeGit({ conflicts: [] })
    const r = runDriftCheck('/tmp', git)
    expect(r.reachable).toBe(true)
    expect(isClean(r)).toBe(true)
  })

  it('a conflict nobody decided about lands in `unwatched`, with a ready-to-paste entry', () => {
    const { git } = fakeGit({
      conflicts: ['src/brand-new-file.ts'],
      blobs: { 'src/brand-new-file.ts': 'abc123' },
      contents: { 'src/brand-new-file.ts': '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> upstream\n' },
    })
    const r = runDriftCheck('/tmp', git)
    expect(r.unwatched).toEqual(['src/brand-new-file.ts'])
    const report = formatDriftReport(r)
    expect(report).toContain('NOBODY HAS DECIDED HOW TO RESOLVE')
    // The hunk must survive the merge --abort: it is captured while the tree still has it.
    expect(r.hunks['src/brand-new-file.ts']).toContain('theirs')
    expect(report).toContain('theirs')
  })

  it('an acknowledged conflict whose upstream blob still matches is CLEAN', () => {
    const { git } = fakeGit({ conflicts: [ACK_FILE], blobs: { [ACK_FILE]: ACK_BLOB } })
    const r = runDriftCheck('/tmp', git)
    expect(isClean(r)).toBe(true)
  })

  it('an acknowledged conflict whose upstream blob MOVED is stale, and the report carries the OLD rule', () => {
    // Carrying the previous rule is the difference between a re-decision and a rubber stamp: the
    // reader is being asked to judge whether a decision still describes what is there, which is not
    // answerable from the file name and a new sha.
    const { git } = fakeGit({ conflicts: [ACK_FILE], blobs: { [ACK_FILE]: 'f'.repeat(40) } })
    const r = runDriftCheck('/tmp', git)
    expect(r.stale.map((s) => s.file)).toEqual([ACK_FILE])
    const report = formatDriftReport(r)
    expect(report).toContain('THE ACKNOWLEDGEMENT NO LONGER DESCRIBES WHAT IS THERE')
    expect(report).toContain(r.stale[0]!.rule.slice(0, 40))
  })

  it('a file DELETED upstream is stale, not silently acknowledged', () => {
    // rev-parse fails -> blobOf returns null -> the recorded blob cannot match. A delete/modify
    // conflict is precisely the case where the old decision cannot still apply.
    const { git } = fakeGit({ conflicts: [ACK_FILE], blobs: {} })
    const r = runDriftCheck('/tmp', git)
    expect(r.stale.map((s) => s.file)).toEqual([ACK_FILE])
    expect(r.stale[0]!.actual).toBe('(absent upstream)')
  })

  it('always aborts the merge and removes the throwaway worktree, even on the conflict path', () => {
    // The check runs unattended on a schedule. A leaked worktree registration would accumulate
    // silently and eventually confuse every later `git worktree` operation in the repo.
    const { git, calls } = fakeGit({ conflicts: ['x.ts'], blobs: { 'x.ts': 'aa' } })
    runDriftCheck('/tmp', git)
    expect(calls.some((c) => c[0] === 'merge' && c[1] === '--abort')).toBe(true)
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(true)
  })

  it('never merges into the real checkout: the merge cwd is the throwaway worktree, not the repo', () => {
    const seen: string[] = []
    const { git } = fakeGit({ conflicts: [] })
    const spy: GitRunner = (args, cwd) => {
      if (args[0] === 'merge') seen.push(cwd)
      return git(args, cwd)
    }
    runDriftCheck('/tmp/the-real-repo', spy)
    expect(seen).not.toHaveLength(0)
    for (const cwd of seen) expect(cwd).not.toBe('/tmp/the-real-repo')
  })

  it('fetches the branch it later merges -- one name, not two that can drift apart', () => {
    const { git, calls } = fakeGit({ conflicts: [] })
    runDriftCheck('/tmp', git)
    const fetch = calls.find((c) => c[0] === 'fetch')!
    const merge = calls.find((c) => c[0] === 'merge' && c[1] !== '--abort')!
    expect(fetch).toContain(UPSTREAM_REMOTE)
    expect(fetch).toContain(UPSTREAM_BRANCH)
    expect(merge).toContain(`${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`)
  })
})
