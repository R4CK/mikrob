// Card 726dca6b: store/watched-repos.json is TRACKED, but the manual review close-out
// workflow used to hand-write last_sha + last_checked_upstream_sha + last_checked_at into it
// alongside the note on every review -- a routine tracked-file diff nobody committed, blocking
// the shared main clone's fast-forward (the same bug class card 197947ae already fixed for the
// automated daily sync, here for the manual path). The fix: those three fields now live in the
// gitignored store/watched-repos-state.json; the registry only ever carries `note` (plus the
// stable config fields) once a repo has been migrated.
//
// Every test runs against throwaway temp files -- never the live store/watched-repos*.json.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WATCHER_SH = join(ROOT, 'store', 'git-repo-watcher.sh')
const RECORD_SH = join(ROOT, 'store', 'watched-repos-record-review.sh')

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }).trim()
}
function gitOk(repo: string, ...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
}

let dir: string
let upstream: string
let clone: string
let registryPath: string
let statePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watched-repos-moving-state-'))
  upstream = join(dir, 'upstream')
  clone = join(dir, 'clone')
  mkdirSync(upstream, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', upstream])
  gitOk(upstream, 'config', 'user.email', 't@t.t')
  gitOk(upstream, 'config', 'user.name', 'T')
  writeFileSync(join(upstream, 'a.txt'), 'one\n')
  gitOk(upstream, 'add', 'a.txt')
  gitOk(upstream, 'commit', '-q', '-m', 'first')
  execFileSync('git', ['clone', '-q', upstream, clone])
  gitOk(clone, 'config', 'user.email', 't@t.t')
  gitOk(clone, 'config', 'user.name', 'T')

  registryPath = join(dir, 'watched-repos.json')
  statePath = join(dir, 'watched-repos-state.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeRegistry(entries: Array<Record<string, unknown>>): void {
  writeFileSync(registryPath, JSON.stringify(entries, null, 2) + '\n')
}

// git-repo-watcher.sh resolves its config relative to its own script dir ($HERE/watched-repos.json),
// not an env override -- mirror that by copying it next to a throwaway copy of the script.
function runWatcherAt(cfgDir: string): string {
  const scriptCopy = join(cfgDir, 'git-repo-watcher.sh')
  writeFileSync(scriptCopy, readFileSync(WATCHER_SH))
  return execFileSync('bash', [scriptCopy], {
    encoding: 'utf-8',
    env: { ...process.env, WATCHED_REPOS_STATE_JSON: statePath },
  })
}

describe('git-repo-watcher.sh reads last_sha from the state file, not the tracked registry', () => {
  it('a state-file last_sha matching upstream reports NOCHANGE even when the registry has no last_sha at all', () => {
    const head = git(upstream, 'rev-parse', 'HEAD')
    writeRegistry([
      { name: 'demo', repo: upstream, branch: 'main', local: clone, type: 'text', enabled: true, note: 'x' },
    ])
    writeFileSync(statePath, JSON.stringify({ demo: { last_sha: head, last_checked_at: '2026-10-09' } }))
    const out = runWatcherAt(dir)
    expect(out).toContain('NOCHANGE:demo')
  })

  it('upstream moving ahead of the state-file last_sha reports CHANGED', () => {
    const before = git(upstream, 'rev-parse', 'HEAD')
    writeFileSync(join(upstream, 'b.txt'), 'two\n')
    gitOk(upstream, 'add', 'b.txt')
    gitOk(upstream, 'commit', '-q', '-m', 'second')
    writeRegistry([
      { name: 'demo', repo: upstream, branch: 'main', local: clone, type: 'text', enabled: true, note: 'x' },
    ])
    writeFileSync(statePath, JSON.stringify({ demo: { last_sha: before, last_checked_at: '2026-10-09' } }))
    const out = runWatcherAt(dir)
    expect(out).toContain('CHANGED:text:demo')
  })

  it('falls back to the registry\'s own last_sha when no state entry exists for that name (pre-migration compat)', () => {
    const head = git(upstream, 'rev-parse', 'HEAD')
    writeRegistry([
      { name: 'demo', repo: upstream, branch: 'main', local: clone, type: 'text', enabled: true, last_sha: head, note: 'x' },
    ])
    // no state file at all
    const out = runWatcherAt(dir)
    expect(out).toContain('NOCHANGE:demo')
  })

  it('a watcher run never writes to the tracked registry file -- it is byte-identical before and after', () => {
    const head = git(upstream, 'rev-parse', 'HEAD')
    writeRegistry([
      { name: 'demo', repo: upstream, branch: 'main', local: clone, type: 'code', enabled: true, note: 'x' },
    ])
    writeFileSync(statePath, JSON.stringify({ demo: { last_sha: head, last_checked_at: '2026-10-09' } }))
    const before = readFileSync(registryPath, 'utf-8')
    runWatcherAt(dir)
    const after = readFileSync(registryPath, 'utf-8')
    expect(after).toBe(before)
  })
})

describe('watched-repos-record-review.sh', () => {
  beforeEach(() => {
    writeRegistry([
      { name: 'demo', repo: upstream, branch: 'main', local: clone, type: 'text', enabled: true, note: 'existing note' },
      { name: 'other', repo: upstream, branch: 'main', local: clone, type: 'text', enabled: true, note: 'untouched' },
    ])
  })

  it('writes last_sha/last_checked_upstream_sha/last_checked_at into the state file, not the registry', () => {
    execFileSync('bash', [RECORD_SH, 'demo', '--sha', 'abc123', '--upstream-sha', 'abc123full', '--registry', registryPath, '--state', statePath])
    const state = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(state.demo.last_sha).toBe('abc123')
    expect(state.demo.last_checked_upstream_sha).toBe('abc123full')
    expect(typeof state.demo.last_checked_at).toBe('string')

    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'))
    const entry = registry.find((e: { name: string }) => e.name === 'demo')
    expect(entry.last_sha).toBeUndefined()
    expect(entry.last_checked_upstream_sha).toBeUndefined()
    expect(entry.note).toBe('existing note') // no --note-append given: untouched
  })

  it('appends to the note (not replacing it) only when --note-append is given, leaving other entries alone', () => {
    execFileSync('bash', [RECORD_SH, 'demo', '--sha', 'def456', '--note-append', '2026-10-09: reviewed, no-op', '--registry', registryPath, '--state', statePath])
    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'))
    const demo = registry.find((e: { name: string }) => e.name === 'demo')
    const other = registry.find((e: { name: string }) => e.name === 'other')
    expect(demo.note).toBe('existing note | 2026-10-09: reviewed, no-op')
    expect(other.note).toBe('untouched')
  })

  it('fails loudly for an unknown repo name rather than silently creating a phantom state row', () => {
    expect(() =>
      execFileSync('bash', [RECORD_SH, 'nonexistent', '--sha', 'x', '--registry', registryPath, '--state', statePath], { stdio: 'pipe' }),
    ).toThrow()
    expect(() => readFileSync(statePath, 'utf-8')).toThrow() // never created
  })
})
