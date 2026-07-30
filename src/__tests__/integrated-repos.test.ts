import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildIntegratedRepos,
  readRegistry,
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

describe('readRegistry + buildIntegratedRepos', () => {
  it('returns [] for a missing or malformed registry rather than throwing', () => {
    expect(readRegistry(join(tmp, 'nope.json'))).toEqual([])
    const bad = join(tmp, 'bad.json')
    writeFileSync(bad, '{not json')
    expect(readRegistry(bad)).toEqual([])
    const notArray = join(tmp, 'obj.json')
    writeFileSync(notArray, '{"a":1}')
    expect(readRegistry(notArray)).toEqual([])
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
