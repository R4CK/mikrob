import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { logger } from '../logger.js'
import {
  buildIntegratedRepos,
  isValidBranch,
  isValidSha,
  readRegistry,
  readState,
  redactRemote,
  repoKind,
  statusForRepo,
} from '../web/routes/integrated-repos.js'

// Card a5c13533. Non-vacuous: the behind-detection is exercised against REAL git repos
// created in a temp dir (an upstream + a clone pinned one commit back), not a mock -- a
// mocked `git` would prove nothing about the actual rev-list semantics this relies on.
// The security claims in the module header (credential redaction, no-fetch, code-vs-text
// review flag) each get a test that can fail.

let tmp: string
let upstream: string
let clone: string
let upstreamHead = ''
let firstSha = ''

const g = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'intrepo-'))
  upstream = join(tmp, 'upstream')
  clone = join(tmp, 'clone')
  mkdirSync(upstream, { recursive: true })

  execFileSync('git', ['init', '-q', '-b', 'main', upstream])
  g(upstream, ['config', 'user.email', 't@t.t'])
  g(upstream, ['config', 'user.name', 'T'])
  writeFileSync(join(upstream, 'a.txt'), 'one\n')
  g(upstream, ['add', 'a.txt'])
  g(upstream, ['commit', '-q', '-m', 'first commit'])
  firstSha = g(upstream, ['rev-parse', 'HEAD'])

  execFileSync('git', ['clone', '-q', upstream, clone])
  g(clone, ['config', 'user.email', 't@t.t'])
  g(clone, ['config', 'user.name', 'T'])

  // Upstream moves ahead by two commits; the clone FETCHES (as the watcher would) but stays put.
  writeFileSync(join(upstream, 'b.txt'), 'two\n')
  g(upstream, ['add', 'b.txt'])
  g(upstream, ['commit', '-q', '-m', 'second commit'])
  writeFileSync(join(upstream, 'c.txt'), 'three\n')
  g(upstream, ['add', 'c.txt'])
  g(upstream, ['commit', '-q', '-m', 'third commit'])
  upstreamHead = g(upstream, ['rev-parse', 'HEAD'])
  g(clone, ['fetch', '-q', 'origin', 'main'])
})

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

const cfg = (over: Record<string, unknown> = {}) => ({
  name: 'demo',
  repo: 'https://github.com/example/demo.git',
  branch: 'main',
  local: clone,
  type: 'code',
  enabled: true,
  ...over,
}) as never

describe('redactRemote', () => {
  it('strips embedded credentials from a remote URL', () => {
    expect(redactRemote('https://user:token@github.com/x/y.git')).toBe('https://github.com/x/y.git')
    expect(redactRemote('https://tok@github.com/x/y.git')).toBe('https://github.com/x/y.git')
  })
  it('leaves a clean URL untouched', () => {
    expect(redactRemote('https://github.com/x/y.git')).toBe('https://github.com/x/y.git')
    expect(redactRemote('git@github.com:x/y.git')).toBe('git@github.com:x/y.git')
  })
})

describe('repoKind', () => {
  it('maps a text adoption to skill and code to external by default', () => {
    expect(repoKind({ type: 'text' })).toBe('skill')
    expect(repoKind({ type: 'code' })).toBe('external')
  })
  it('honours an explicit kind (mcp cannot be derived from type alone)', () => {
    expect(repoKind({ type: 'code', kind: 'mcp' })).toBe('mcp')
    expect(repoKind({ type: 'code', kind: 'skill' })).toBe('skill')
  })
  it('ignores an unknown kind and falls back to the type mapping', () => {
    expect(repoKind({ type: 'text', kind: 'bogus' })).toBe('skill')
  })
})

describe('statusForRepo -- upstream-behind detection against a real repo', () => {
  it('reports behind=2 with the newest-first commit preview when upstream moved ahead', () => {
    const s = statusForRepo(cfg({ last_sha: firstSha }))
    expect(s.cloned).toBe(true)
    expect(s.vendoredSha).toBe(firstSha)
    expect(s.upstreamSha).toBe(upstreamHead)
    expect(s.behind).toBe(2)
    expect(s.commits.map((c) => c.message)).toEqual(['third commit', 'second commit'])
    expect(s.commits[0]?.short).toHaveLength(8)
    expect(s.vendoredDate).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('reports behind=0 and NO commits when the vendored sha IS the upstream tip', () => {
    const s = statusForRepo(cfg({ last_sha: upstreamHead }))
    expect(s.behind).toBe(0)
    expect(s.commits).toEqual([])
    expect(s.reviewRequired).toBe(false)
  })

  it('SUPPLY-CHAIN: a behind CODE adoption is flagged reviewRequired (never auto-updated)', () => {
    expect(statusForRepo(cfg({ last_sha: firstSha, type: 'code' })).reviewRequired).toBe(true)
  })

  it('a behind TEXT adoption is NOT review-gated (docs/skills carry no execution risk)', () => {
    expect(statusForRepo(cfg({ last_sha: firstSha, type: 'text' })).reviewRequired).toBe(false)
  })

  it('an adopted-but-not-cloned entry is reported, not crashed on', () => {
    const s = statusForRepo(cfg({ local: join(tmp, 'does-not-exist') }))
    expect(s.cloned).toBe(false)
    expect(s.behind).toBe(0)
    expect(s.error).toBeUndefined()
  })

  it('redacts credentials in the returned remote URL', () => {
    const s = statusForRepo(cfg({ repo: 'https://u:p@github.com/x/y.git' }))
    expect(s.repo).toBe('https://github.com/x/y.git')
    expect(s.repo).not.toContain('p@')
  })

  it('surfaces last_checked_at as lastCheckedAt (card be7a69c3)', () => {
    const s = statusForRepo(cfg({ last_sha: firstSha, last_checked_at: '2026-08-26' }))
    expect(s.lastCheckedAt).toBe('2026-08-26')
  })

  it('lastCheckedAt is null, not undefined or empty string, when the registry never recorded a check', () => {
    const s = statusForRepo(cfg({ last_sha: firstSha }))
    expect(s.lastCheckedAt).toBeNull()
  })

  it('NO-FETCH: the endpoint does not advance the local refs (read-only by design)', () => {
    const before = g(clone, ['rev-parse', 'refs/remotes/origin/main'])
    // Add a THIRD upstream commit that the clone has NOT fetched.
    writeFileSync(join(upstream, 'd.txt'), 'four\n')
    g(upstream, ['add', 'd.txt'])
    g(upstream, ['commit', '-q', '-m', 'fourth commit'])
    statusForRepo(cfg({ last_sha: firstSha }))
    const after = g(clone, ['rev-parse', 'refs/remotes/origin/main'])
    expect(after).toBe(before) // unchanged -> we never fetched
  })
})

describe('statusForRepo -- the note field (card e52b0131, Fron Ted contract 184dc8d7)', () => {
  // `description` folds the note in as a fallback (`cfg.description || cfg.note`), so a note only
  // ever escaped for an entry with NO description. Measured against the live registry: 36 of 38
  // entries carry both, and none carries a note alone -- so the fallback never fired for any of
  // them and the note was unreachable. The Updates page already renders a note column keyed on
  // `typeof r.note === 'string'` (web/fork-updates.js), so the column simply never appeared.
  it('carries the note out on its OWN field, not only through the description fallback', () => {
    const s = statusForRepo(cfg({ description: 'a one-liner', note: 'REVIEWED 2026-09-04: fine' }))
    expect(s.note).toBe('REVIEWED 2026-09-04: fine')
    // ...and the entry that has both still shows its own description, unchanged.
    expect(s.description).toBe('a one-liner')
  })

  it('leaves the description fallback alone for an entry with no description of its own', () => {
    // The two registry entries without a description borrow the note for one. Removing that
    // fallback would blank their UI text, so it stays -- the note field is additive, not a
    // replacement.
    const s = statusForRepo(cfg({ note: 'only a note here' }))
    expect(s.description).toBe('only a note here')
    expect(s.note).toBe('only a note here')
  })

  it('is an empty string, never undefined, when the entry has no note', () => {
    // The FE distinguishes "field absent" (unknown) from "empty" (no note). A missing key would
    // put it back in the unknown branch and hide the column again.
    const s = statusForRepo(cfg({ description: 'no note on this one' }))
    expect(s.note).toBe('')
    expect(typeof s.note).toBe('string')
  })
})

// A nonexistent state path throughout, so these tests never merge in the REAL, live
// store/watched-repos-state.json via readRegistry's default second argument.
const noState = () => join(tmp, `no-state-${Math.random().toString(36).slice(2)}.json`)

describe('readRegistry + buildIntegratedRepos', () => {
  it('returns [] for a missing or malformed registry rather than throwing', () => {
    expect(readRegistry(join(tmp, 'nope.json'), noState())).toEqual([])
    const bad = join(tmp, 'bad.json')
    writeFileSync(bad, '{not json')
    expect(readRegistry(bad, noState())).toEqual([])
    const notArray = join(tmp, 'obj.json')
    writeFileSync(notArray, '{"a":1}')
    expect(readRegistry(notArray, noState())).toEqual([])
  })

  it('aggregates totals and counts behind / review-required entries', () => {
    const reg = join(tmp, 'registry.json')
    writeFileSync(
      reg,
      JSON.stringify([
        { name: 'behind-code', repo: 'https://x/y.git', branch: 'main', local: clone, type: 'code', enabled: true, last_sha: firstSha },
        { name: 'uptodate', repo: 'https://x/z.git', branch: 'main', local: clone, type: 'text', enabled: true, last_sha: upstreamHead },
        { name: 'notcloned', repo: 'https://x/w.git', branch: 'main', local: join(tmp, 'gone'), type: 'text', enabled: false },
      ]),
    )
    const out = buildIntegratedRepos(reg)
    expect(out.total).toBe(3)
    expect(out.behind).toBe(1)
    expect(out.reviewRequired).toBe(1)
    expect(out.checkedAt).toBeGreaterThan(0)
    expect(out.repos.find((r) => r.name === 'notcloned')?.cloned).toBe(false)
    expect(out.repos.find((r) => r.name === 'uptodate')?.behind).toBe(0)
  })
})

// Card ffca678d (Cybersec INFO on 197947ae gate, comment 6544): last_sha reaches a git argv
// position unvalidated. A value shaped like a git option (e.g. "--output=<path>") gets parsed
// as a flag, not a revision -- measured upstream: `git log -1 --format=%cI --output=<file>`
// exits 0 and creates that file. These tests prove the fix closes it, with a real mutation
// check (point 7 below) rather than trusting the implementation by inspection.
describe('statusForRepo -- last_sha hex validation (card ffca678d, option-injection close)', () => {
  it('isValidSha accepts git\'s own 7-40 char hex abbreviation range', () => {
    expect(isValidSha(firstSha)).toBe(true) // full 40-char sha
    expect(isValidSha(firstSha.slice(0, 7))).toBe(true) // git's own abbreviation floor
    expect(isValidSha(firstSha.slice(0, 6))).toBe(false) // one below the floor
  })

  it('isValidSha rejects non-hex and git-option-shaped values', () => {
    expect(isValidSha('--output=/tmp/x')).toBe(false)
    expect(isValidSha('')).toBe(false)
    expect(isValidSha('not-hex-at-all')).toBe(false)
    expect(isValidSha('ABCDEF1')).toBe(false) // uppercase hex is not what git prints
  })

  it('an option-shaped last_sha never reaches git: no file is created, and vendoredSha falls back to HEAD', () => {
    const marker = join(tmp, `pwned-${Math.random().toString(36).slice(2)}`)
    const s = statusForRepo(cfg({ last_sha: `--output=${marker}` }))
    expect(existsSync(marker)).toBe(false) // the actual exploit this closes
    expect(s.vendoredSha).toBe(g(clone, ['rev-parse', 'HEAD'])) // fell back to the real HEAD
    expect(s.error).toBeUndefined() // not a crash -- a handled, logged fallback
  })

  it('a too-short last_sha (below the 7-char floor) is rejected the same way', () => {
    const s = statusForRepo(cfg({ last_sha: firstSha.slice(0, 3) }))
    expect(s.vendoredSha).toBe(g(clone, ['rev-parse', 'HEAD']))
  })

  it('a valid recorded last_sha is still honoured (no regression on the real feature)', () => {
    const s = statusForRepo(cfg({ last_sha: firstSha }))
    expect(s.vendoredSha).toBe(firstSha)
    expect(s.behind).toBe(2)
  })

  // MUTATION CHECK: without the fix, the option-injection test above would not merely pass
  // differently -- it would actually create the marker file. This re-runs the exact git
  // invocation the OLD (unvalidated) code used to make, to confirm the vulnerability this
  // guards against is real, not hypothetical.
  it('MUTATION: the pre-fix call shape genuinely creates the file (proves the test is non-vacuous)', () => {
    const marker = join(tmp, `mutation-pwned-${Math.random().toString(36).slice(2)}`)
    execFileSync('git', ['-C', clone, 'log', '-1', '--format=%cI', `--output=${marker}`], { encoding: 'utf8' })
    expect(existsSync(marker)).toBe(true)
  })

  // Card ed4926a3 (RedHat LOW, ffca678d gate comment 13314): an invalid last_sha used to be
  // quoted raw into the warn line -- a value containing control characters or a terminal
  // escape sequence would reach whoever reads the log unfiltered.
  it('an invalid last_sha reaches the warn log sanitized: no control chars, length-capped', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    statusForRepo(cfg({ last_sha: 'bad\x1b[31m\nsha' + 'x'.repeat(100) }))
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = String(warn.mock.calls[0]![0])
    expect(msg).not.toMatch(/[\x00-\x1f]/) // no raw control chars (incl. newline, ESC) reached it
    expect(msg.length).toBeLessThan(250) // the sha portion itself was capped to 80 chars
    warn.mockRestore()
  })
})

describe('statusForRepo -- branch ref-name validation (card ed4926a3, ffca678d follow-up)', () => {
  it('isValidBranch accepts ordinary branch names', () => {
    expect(isValidBranch('main')).toBe(true)
    expect(isValidBranch('release/2026-10')).toBe(true)
    expect(isValidBranch('feature.fix-123')).toBe(true)
  })

  it('isValidBranch rejects option-shaped, empty, and path-traversal-shaped values', () => {
    expect(isValidBranch('--upload-pack=x')).toBe(false)
    expect(isValidBranch('')).toBe(false)
    expect(isValidBranch('a..b')).toBe(false)
  })

  it('an option-shaped branch never reaches git: upstream stays null, no crash', () => {
    const s = statusForRepo(cfg({ branch: '--upload-pack=touch /tmp/should-not-exist-ed4926a3' }))
    expect(s.upstreamSha).toBeNull()
    expect(existsSync('/tmp/should-not-exist-ed4926a3')).toBe(false)
  })

  it('an invalid branch warns (sanitized) instead of silently reaching git', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    statusForRepo(cfg({ branch: '--bad\x1b[31mbranch' }))
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = String(warn.mock.calls[0]![0])
    expect(msg).toContain('is not a valid ref name')
    expect(msg).not.toMatch(/[\x00-\x1f]/)
    warn.mockRestore()
  })

  it('a valid branch is unaffected (no regression on the real feature)', () => {
    const s = statusForRepo(cfg({ branch: 'main' }))
    expect(s.upstreamSha).toBe(upstreamHead)
    expect(s.behind).toBe(2)
  })
})

describe('readRegistry -- merges the write-back state file (card 197947ae)', () => {
  const reg = () => {
    const p = join(tmp, `reg-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(
      p,
      JSON.stringify([
        { name: 'daily-synced', repo: 'https://x/y.git', branch: 'main', local: clone, type: 'text', enabled: true, last_sha: firstSha, last_checked_at: '2020-01-01' },
        { name: 'never-synced', repo: 'https://x/z.git', branch: 'main', local: clone, type: 'text', enabled: true, last_sha: firstSha, last_checked_at: '2020-01-01' },
      ]),
    )
    return p
  }

  it('readState returns {} for a missing or malformed state file rather than throwing', () => {
    expect(readState(join(tmp, 'nope-state.json'))).toEqual({})
    const bad = join(tmp, 'bad-state.json')
    writeFileSync(bad, '{not json')
    expect(readState(bad)).toEqual({})
    const arr = join(tmp, 'arr-state.json')
    writeFileSync(arr, '[]')
    expect(readState(arr)).toEqual({})
  })

  it('a state entry for a repo name OVERRIDES that entry\'s last_sha/last_checked_at, leaving other repos alone', () => {
    const state = join(tmp, 'state.json')
    writeFileSync(state, JSON.stringify({ 'daily-synced': { last_sha: upstreamHead, last_checked_at: '2026-09-25' } }))

    const entries = readRegistry(reg(), state)
    const synced = entries.find((e) => e.name === 'daily-synced')
    const never = entries.find((e) => e.name === 'never-synced')
    expect(synced?.last_sha).toBe(upstreamHead)
    expect(synced?.last_checked_at).toBe('2026-09-25')
    // Untouched by the state file -- keeps the registry's own (possibly stale) value.
    expect(never?.last_sha).toBe(firstSha)
    expect(never?.last_checked_at).toBe('2020-01-01')
  })

  it('a missing state file leaves every registry entry exactly as read', () => {
    const entries = readRegistry(reg(), noState())
    expect(entries.find((e) => e.name === 'daily-synced')?.last_sha).toBe(firstSha)
  })

  it('feeds through to behind-detection: a stale registry last_sha would show behind, the merged state sha does not', () => {
    const state = join(tmp, 'state2.json')
    writeFileSync(state, JSON.stringify({ 'daily-synced': { last_sha: upstreamHead, last_checked_at: '2026-09-25' } }))
    const entries = readRegistry(reg(), state)
    const synced = entries.find((e) => e.name === 'daily-synced')!
    expect(statusForRepo(synced).behind).toBe(0)
  })
})
