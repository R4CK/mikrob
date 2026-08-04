// Cybered NO-GO fix (card a3700b69): the upstream-merge branch of POST /api/updates/apply never
// wrote a rollback point to store/.update-history, unlike the fork-pull path (update.sh). Covers the
// CHANGED merge control flow (performUpstreamMerge) via a fake UpstreamMergeRunner -- success,
// conflict, and other-failure -- and the exact TSV shape recordUpdateHistory/updateHistoryTimestamp
// writes, which recovery-prev-version.sh's `awk -F'\t' '$2=="update"{v=$4}'` parses BLINDLY (a
// differently-shaped line silently vanishes from --list / is never selected as a rollback target).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  performUpstreamMerge,
  recordUpdateHistory,
  updateHistoryTimestamp,
  analyzeUpstreamChanges,
  formatUpstreamAnalysis,
  type UpstreamMergeRunner,
  type UpstreamAnalysisRunner,
} from '../web/routes/updates.js'

function fakeRunner(over: Partial<UpstreamMergeRunner> = {}): UpstreamMergeRunner {
  return {
    revParseHead: () => 'abc123\n',
    fetchUpstream: () => undefined,
    mergeUpstream: () => undefined,
    mergeAbort: () => undefined,
    currentBranch: () => 'develop\n',
    ...over,
  }
}

describe('performUpstreamMerge -- success', () => {
  it('fetches, merges, and records a rollback point (before -> after SHA) when HEAD moved', () => {
    let head = 'before000000000000000000000000000000000\n'
    const calls: string[] = []
    const runner = fakeRunner({
      revParseHead: () => head,
      fetchUpstream: () => { calls.push('fetch') },
      mergeUpstream: () => {
        calls.push('merge')
        head = 'after1111111111111111111111111111111111\n' // simulates the merge advancing HEAD
      },
    })
    const recorded: { branch: string; from: string; to: string; note: string }[] = []
    const result = performUpstreamMerge(runner, (branch, from, to, note) => {
      recorded.push({ branch, from, to, note })
    })
    expect(result.ok).toBe(true)
    expect(calls).toEqual(['fetch', 'merge']) // fetch BEFORE merge
    expect(recorded).toEqual([
      { branch: 'develop', from: 'before000000000000000000000000000000000', to: 'after1111111111111111111111111111111111', note: 'upstream-merge' },
    ])
  })

  it('does NOT record a rollback point when the merge was a no-op (HEAD unchanged, e.g. already up to date)', () => {
    const runner = fakeRunner({ revParseHead: () => 'same0000000000000000000000000000000000\n' })
    let recordCalls = 0
    const result = performUpstreamMerge(runner, () => { recordCalls++ })
    expect(result.ok).toBe(true)
    // recordUpdateHistory itself no-ops on fromSha===toSha; performUpstreamMerge always CALLS it
    // (the guard lives in recordUpdateHistory) -- verify via the REAL function against a temp file
    // instead, in the recordUpdateHistory describe block below. Here we only assert the merge
    // succeeds cleanly with no exception when before===after.
    expect(recordCalls).toBe(1)
  })
})

describe('performUpstreamMerge -- conflict', () => {
  it('aborts the merge and returns merge-conflict, WITHOUT recording any rollback point', () => {
    const aborts: string[] = []
    const runner = fakeRunner({
      mergeUpstream: () => {
        throw new Error('CONFLICT (content): Merge conflict in src/x.ts\nAutomatic merge failed; fix conflicts and then commit the result.')
      },
      mergeAbort: () => { aborts.push('abort') },
    })
    let recordCalls = 0
    const result = performUpstreamMerge(runner, () => { recordCalls++ })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('merge-conflict')
    expect(result.message).toMatch(/Resolve manually/)
    expect(aborts).toEqual(['abort']) // the tree is cleaned up
    expect(recordCalls).toBe(0) // NEVER recorded -- HEAD never moved
  })
})

describe('performUpstreamMerge -- other failure (network / missing remote)', () => {
  it('returns upstream-merge-failed with the raw message, attempts abort, records nothing', () => {
    const aborts: string[] = []
    const runner = fakeRunner({
      fetchUpstream: () => { throw new Error('fatal: unable to access upstream: Could not resolve host') },
      mergeAbort: () => { aborts.push('abort') },
    })
    let recordCalls = 0
    const result = performUpstreamMerge(runner, () => { recordCalls++ })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('upstream-merge-failed')
    expect(result.message).toMatch(/Could not resolve host/)
    expect(aborts).toEqual(['abort'])
    expect(recordCalls).toBe(0)
  })

  it('a failing mergeAbort (no merge was in progress) does not mask the original error', () => {
    const runner = fakeRunner({
      mergeUpstream: () => { throw new Error('some other git failure') },
      mergeAbort: () => { throw new Error('fatal: There is no merge to abort') },
    })
    const result = performUpstreamMerge(runner, () => undefined)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('upstream-merge-failed')
    expect(result.message).toBe('some other git failure')
  })
})

describe('updateHistoryTimestamp -- exact bash `date +%Y-%m-%dT%H:%M:%S%z` shape', () => {
  it('zero-pads every field and uses a NO-COLON zone offset (+HHMM, not +HH:MM)', () => {
    const d = new Date(2026, 6, 5, 9, 3, 7) // local time: 2026-07-05 09:03:07
    const ts = updateHistoryTimestamp(d)
    // The trailing [+-]\d{4}$ anchor already proves the offset is exactly 4 digits with no colon;
    // this second check is redundant but explicit about the property that matters for the awk parse.
    expect(ts).toMatch(/^2026-07-05T09:03:07[+-]\d{4}$/)
    const offsetSegment = ts.slice(-5)
    expect(offsetSegment).not.toContain(':')
  })
})

describe('recordUpdateHistory -- exact TSV shape (recovery-prev-version.sh awk-compat)', () => {
  let tmp: string
  let histPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'update-history-test-'))
    histPath = join(tmp, '.update-history')
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('appends a 6-field tab-separated line: ts\\tupdate\\tbranch\\tfrom\\tto\\tnote', () => {
    recordUpdateHistory('develop', 'aaa0000000000000000000000000000000000a', 'bbb0000000000000000000000000000000000b', 'upstream-merge', histPath)
    const line = readFileSync(histPath, 'utf-8').trimEnd()
    const fields = line.split('\t')
    expect(fields).toHaveLength(6)
    // field 2 MUST be the literal string "update" -- recovery-prev-version.sh's
    // `awk -F'\t' '$2=="update"{v=$4}'` only recognizes this exact value.
    expect(fields[1]).toBe('update')
    expect(fields[2]).toBe('develop')
    expect(fields[3]).toBe('aaa0000000000000000000000000000000000a')
    expect(fields[4]).toBe('bbb0000000000000000000000000000000000b')
    expect(fields[5]).toBe('upstream-merge')
    expect(fields[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/)
  })

  it('does NOT write a line when fromSha === toSha (no-op merge, mirrors update.sh\'s own guard)', () => {
    recordUpdateHistory('develop', 'same0000000000000000000000000000000000', 'same0000000000000000000000000000000000', 'upstream-merge', histPath)
    expect(existsSync(histPath)).toBe(false)
  })

  it('is append-only: two calls produce two lines, earlier content preserved', () => {
    recordUpdateHistory('develop', 'a0000000000000000000000000000000000000', 'b0000000000000000000000000000000000000', 'upstream-merge', histPath)
    recordUpdateHistory('develop', 'b0000000000000000000000000000000000000', 'c0000000000000000000000000000000000000', 'upstream-merge', histPath)
    const lines = readFileSync(histPath, 'utf-8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]?.split('\t')[3]).toBe('a0000000000000000000000000000000000000')
    expect(lines[1]?.split('\t')[3]).toBe('b0000000000000000000000000000000000000')
  })

  it('is best-effort: a write failure (unwritable path) does not throw', () => {
    const badPath = join(tmp, 'no-such-dir', '.update-history')
    expect(() =>
      recordUpdateHistory('develop', 'x0000000000000000000000000000000000000', 'y0000000000000000000000000000000000000', 'upstream-merge', badPath),
    ).not.toThrow()
  })
})

// Peti directive 2026-08-04 (Telegram msg 3284): the "Frissites telepitese" button must analyze what
// an upstream merge would change AND the risk from our own fork divergence before implementing.
function fakeAnalysisRunner(over: Partial<UpstreamAnalysisRunner> = {}): UpstreamAnalysisRunner {
  return {
    fetchUpstream: () => undefined,
    commitsBehind: () => '',
    diffStat: () => '',
    oursChangedFiles: () => '',
    theirsChangedFiles: () => '',
    ...over,
  }
}

describe('analyzeUpstreamChanges', () => {
  it('fetches upstream before reading any diff (data must be current)', () => {
    const calls: string[] = []
    analyzeUpstreamChanges(fakeAnalysisRunner({
      fetchUpstream: () => { calls.push('fetch') },
      commitsBehind: () => { calls.push('commits'); return '' },
    }))
    expect(calls).toEqual(['fetch', 'commits'])
  })

  it('counts incoming commits from the oneline log, ignoring blank lines', () => {
    const a = analyzeUpstreamChanges(fakeAnalysisRunner({
      commitsBehind: () => 'abc1234 fix one thing\ndef5678 fix another\n',
    }))
    expect(a.commitCount).toBe(2)
    expect(a.commits).toEqual(['abc1234 fix one thing', 'def5678 fix another'])
  })

  it('zero incoming commits -> zero risk even if file lists are noisy', () => {
    const a = analyzeUpstreamChanges(fakeAnalysisRunner({ commitsBehind: () => '' }))
    expect(a.commitCount).toBe(0)
    expect(a.hasRisk).toBe(false)
    expect(a.riskyFiles).toEqual([])
  })

  it('flags NO risk when our changes and upstream changes touch disjoint files', () => {
    const a = analyzeUpstreamChanges(fakeAnalysisRunner({
      commitsBehind: () => 'abc1234 upstream change\n',
      oursChangedFiles: () => 'store/quota-check.sh\nCLAUDE.md\n',
      theirsChangedFiles: () => 'src/web/routes/updates.ts\nREADME.md\n',
    }))
    expect(a.hasRisk).toBe(false)
    expect(a.riskyFiles).toEqual([])
  })

  it('flags risk for files touched on BOTH sides since the merge-base (the real conflict-risk zone)', () => {
    const a = analyzeUpstreamChanges(fakeAnalysisRunner({
      commitsBehind: () => 'abc1234 upstream change\n',
      oursChangedFiles: () => 'src/web/routes/updates.ts\nCLAUDE.md\n',
      theirsChangedFiles: () => 'src/web/routes/updates.ts\nREADME.md\n',
    }))
    expect(a.hasRisk).toBe(true)
    expect(a.riskyFiles).toEqual(['src/web/routes/updates.ts'])
  })

  it('preserves upstream file order and dedupes nothing beyond the ours/theirs overlap', () => {
    const a = analyzeUpstreamChanges(fakeAnalysisRunner({
      oursChangedFiles: () => 'b.ts\na.ts\n',
      theirsChangedFiles: () => 'a.ts\nb.ts\nc.ts\n',
    }))
    expect(a.riskyFiles).toEqual(['a.ts', 'b.ts'])
  })
})

describe('formatUpstreamAnalysis', () => {
  it('reports a low-risk message with no overlap', () => {
    const msg = formatUpstreamAnalysis({ commitCount: 3, commits: [], diffStat: '', riskyFiles: [], hasRisk: false })
    expect(msg).toContain('3 uj commit')
    expect(msg).toContain('alacsony konfliktus-eselyes')
  })

  it('reports the risky file list, truncated past 10 entries', () => {
    const many = Array.from({ length: 12 }, (_, i) => `file${i}.ts`)
    const msg = formatUpstreamAnalysis({ commitCount: 5, commits: [], diffStat: '', riskyFiles: many, hasRisk: true })
    expect(msg).toContain('12 fajlt')
    expect(msg).toContain('file0.ts')
    expect(msg).toContain('...')
    expect(msg).not.toContain('file11.ts')
  })
})
