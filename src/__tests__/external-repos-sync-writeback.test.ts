// Card 307abedd: store/external-repos-sync.sh's pull() used to leave watched-repos.json's
// last_sha/last_checked_at fields stale forever -- an agent had to remember to hand-edit the JSON
// after every run (see the many "2026-08-23: external-repos-sync.sh ff-only frissitve ...-ra"
// notes already in the file, all written by hand). The script now writes both fields itself, for
// every repo it actually pulls, right after computing the real post-pull HEAD.
//
// Every test runs against a THROWAWAY bare-origin + clone pair under a real temp dir and a
// throwaway watched-repos.json copy, never the live ~/.claude/external checkouts or the live
// store/watched-repos.json -- the script accepts EXTERNAL_REPOS_DIR / WATCHED_REPOS_JSON
// overrides for exactly this reason (mirrors the MARVEEN_MAIN/MARVEEN_WORKTREES override pattern
// already used by store/agent-worktree-marveen.sh's own tests).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SYNC_SH = join(ROOT, 'store', 'external-repos-sync.sh')
const execFileP = promisify(execFile)

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }).trim()
}
function gitOk(repo: string, ...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
}

let dir: string
let extDir: string
let jsonPath: string
let skillsDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'external-repos-sync-test-'))
  extDir = join(dir, 'external')
  mkdirSync(extDir, { recursive: true })
  jsonPath = join(dir, 'watched-repos.json')
  // Sandboxes step 2 (sp-* symlink relinking) and step 3 (skill-index.sh, which already respects
  // this same env var) so a test run never touches the real ~/.claude/skills or its live index.
  skillsDir = join(dir, 'skills')
  mkdirSync(skillsDir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeJson(entries: Array<Record<string, unknown>>): void {
  writeFileSync(jsonPath, JSON.stringify(entries, null, 2) + '\n')
}
function readJson(): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(jsonPath, 'utf-8')) as Array<Record<string, unknown>>
}

// Sets up upstream.git (bare) + a clone at $EXT/<name>, tracking it, with one initial commit.
function setupRepo(name: string): { upstream: string; clone: string } {
  const upstream = join(dir, `${name}-upstream.git`)
  const clone = join(extDir, name)
  execFileSync('git', ['init', '-q', '--bare', upstream])
  // Without this, the bare repo's own HEAD symref stays whatever init.defaultBranch produced
  // (often not "main"), so a LATER clone of `upstream` (the "other" clones below, made after the
  // first push) warns "remote HEAD refers to nonexistent ref" and checks out nothing -- silently
  // starting from an empty working tree instead of the pushed history.
  gitOk(upstream, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  execFileSync('git', ['clone', '-q', upstream, clone])
  gitOk(clone, 'config', 'user.email', 't@t.local')
  gitOk(clone, 'config', 'user.name', 't')
  writeFileSync(join(clone, 'f.txt'), 'v1\n')
  gitOk(clone, 'add', 'f.txt')
  gitOk(clone, 'commit', '-q', '-m', 'init')
  gitOk(clone, 'push', '-q', '-u', 'origin', 'HEAD:main')
  gitOk(clone, 'checkout', '-q', '-B', 'main')
  gitOk(clone, 'branch', '-q', '--set-upstream-to=origin/main', 'main')
  return { upstream, clone }
}

async function runSync(): Promise<string> {
  const { stdout, stderr } = await execFileP('bash', [SYNC_SH], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      EXTERNAL_REPOS_DIR: extDir,
      WATCHED_REPOS_JSON: jsonPath,
      SKILL_INDEX_GLOBAL_DIR: skillsDir,
    },
  })
  return stdout + stderr
}

describe('external-repos-sync.sh write-back (card 307abedd)', () => {
  it('a REPO WITH NO CHANGE still refreshes last_checked_at; last_sha stays the same value', async () => {
    const { clone } = setupRepo('awesome-claude-skills')
    const sha = git(clone, 'rev-parse', 'HEAD')
    writeJson([{ name: 'awesome-claude-skills', last_sha: sha, last_checked_at: '2020-01-01' }])

    const out = await runSync()
    expect(out).toContain('current: awesome-claude-skills')

    const [entry] = readJson()
    expect(entry.last_sha).toBe(sha)
    expect(entry.last_checked_at).not.toBe('2020-01-01')
    expect(entry.last_checked_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('a FAST-FORWARD update writes the NEW HEAD sha and refreshes last_checked_at', async () => {
    const { upstream, clone } = setupRepo('claude-agent-sdk')
    const oldSha = git(clone, 'rev-parse', 'HEAD')
    // Advance upstream past the clone (a normal, honest new commit).
    const other = join(dir, 'claude-agent-sdk-other')
    execFileSync('git', ['clone', '-q', upstream, other])
    gitOk(other, 'config', 'user.email', 't@t.local')
    gitOk(other, 'config', 'user.name', 't')
    writeFileSync(join(other, 'f.txt'), 'v2\n')
    gitOk(other, 'add', 'f.txt')
    gitOk(other, 'commit', '-q', '-m', 'second')
    gitOk(other, 'push', '-q', 'origin', 'HEAD:main')
    const newSha = git(other, 'rev-parse', 'HEAD')
    expect(newSha).not.toBe(oldSha)

    writeJson([{ name: 'claude-agent-sdk', last_sha: oldSha, last_checked_at: '2020-01-01' }])
    const out = await runSync()
    expect(out).toContain('updated: claude-agent-sdk')

    const [entry] = readJson()
    expect(entry.last_sha).toBe(newSha)
    expect(entry.last_checked_at).not.toBe('2020-01-01')
  })

  it('a NON-FF upstream rewrite (honest history rewrite, no local edit) resets and writes the ACTUAL new HEAD, not the intended target', async () => {
    const { upstream, clone } = setupRepo('superpowers')
    // Rewrite upstream's history from a separate clone (simulates a maintainer force-push /
    // squash) -- the ORIGINAL clone never touches its own working tree, matching this script's
    // own "vendored reference, never edited in place" invariant.
    const other = join(dir, 'superpowers-other')
    execFileSync('git', ['clone', '-q', upstream, other])
    gitOk(other, 'config', 'user.email', 't@t.local')
    gitOk(other, 'config', 'user.name', 't')
    // --amend, not a new commit on top: a plain new commit would still be a FAST-FORWARD from the
    // primary clone's HEAD (still an ancestor), which never exercises the non-ff path at all.
    // Amending REPLACES the tip with a different sha that the old HEAD is not an ancestor of --
    // the actual shape of a maintainer's rebase/squash.
    gitOk(other, 'commit', '--amend', '-q', '-m', 'rewritten root')
    gitOk(other, 'push', '-q', '--force', 'origin', 'HEAD:main')
    const rewrittenSha = git(other, 'rev-parse', 'HEAD')

    writeJson([{ name: 'superpowers', last_sha: git(clone, 'rev-parse', 'HEAD'), last_checked_at: '2020-01-01' }])
    const out = await runSync()
    expect(out).toContain('updated (non-ff, reset to')

    const [entry] = readJson()
    // Written from a REAL rev-parse of the post-reset clone, not the string the log line names.
    expect(entry.last_sha).toBe(rewrittenSha)
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(rewrittenSha)
    expect(entry.last_checked_at).not.toBe('2020-01-01')
  })

  it('a genuinely DIVERGED repo (local commit made to the "vendored" clone) refuses to reset and does NOT write back', async () => {
    const { upstream, clone } = setupRepo('Skill_Seekers')
    const localSha0 = git(clone, 'rev-parse', 'HEAD')
    // A local commit on the clone itself -- this script's own comment calls this "something
    // happened, a human decides". before will no longer equal old_upstream.
    writeFileSync(join(clone, 'local.txt'), 'local edit\n')
    gitOk(clone, 'add', 'local.txt')
    gitOk(clone, 'commit', '-q', '-m', 'local edit')
    const localSha = git(clone, 'rev-parse', 'HEAD')
    // Force upstream past the ORIGINAL point too, so --ff-only is refused and the DIVERGED branch
    // actually runs (otherwise the local commit alone would make --ff-only fail for a different,
    // uninteresting reason without ever reaching the safety check this test targets).
    const other = join(dir, 'Skill_Seekers-other')
    execFileSync('git', ['clone', '-q', upstream, other])
    gitOk(other, 'config', 'user.email', 't@t.local')
    gitOk(other, 'config', 'user.name', 't')
    gitOk(other, 'commit', '--allow-empty', '-q', '-m', 'unrelated upstream advance')
    gitOk(other, 'push', '-q', 'origin', 'HEAD:main')

    writeJson([{ name: 'Skill_Seekers', last_sha: localSha0, last_checked_at: '2020-01-01' }])
    const out = await runSync()
    expect(out).toContain('DIVERGED (HEAD is not where the last known upstream position was')

    const [entry] = readJson()
    expect(entry.last_sha).toBe(localSha0)
    expect(entry.last_checked_at).toBe('2020-01-01')
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(localSha)
  })

  it('a repo with no upstream tracking branch refuses and does NOT write back', async () => {
    const { clone } = setupRepo('loki-mode')
    gitOk(clone, 'branch', '--unset-upstream', 'main')
    const sha = git(clone, 'rev-parse', 'HEAD')

    writeJson([{ name: 'loki-mode', last_sha: sha, last_checked_at: '2020-01-01' }])
    const out = await runSync()
    expect(out).toContain('DIVERGED (no upstream tracking branch')

    const [entry] = readJson()
    expect(entry.last_checked_at).toBe('2020-01-01')
  })

  it('leaves every OTHER field and every OTHER repo entry untouched (surgical write)', async () => {
    const { clone } = setupRepo('anthropics-skills')
    const sha = git(clone, 'rev-parse', 'HEAD')
    writeJson([
      { name: 'anthropics-skills', last_sha: sha, last_checked_at: '2020-01-01', note: 'do not touch me', enabled: true },
      { name: 'unrelated-repo', last_sha: 'deadbeef', last_checked_at: '2020-01-01' },
    ])

    await runSync()

    const [a, b] = readJson()
    expect(a.note).toBe('do not touch me')
    expect(a.enabled).toBe(true)
    expect(b.last_sha).toBe('deadbeef')
    expect(b.last_checked_at).toBe('2020-01-01')
  })

  it('a repo absent from watched-repos.json is silently skipped (no crash, no entry added)', async () => {
    setupRepo('claude-code-best-practice')
    writeJson([{ name: 'some-other-repo', last_sha: 'x', last_checked_at: '2020-01-01' }])

    const out = await runSync()
    expect(out).toContain('current: claude-code-best-practice')
    expect(readJson()).toHaveLength(1)
  })
})
