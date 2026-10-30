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
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const execFileP = promisify(execFile)

// Card eedb2871 F-2 (QA FAIL 19034): a bare `.not.toBe('2026-10-09')` only proves the value
// changed, not that it changed to the RIGHT thing -- a mutation pin (write_back's date.today()
// swapped for a fixed-but-valid "2020-01-01") left two such assertions green. Matching today's
// actual date exactly is the tight check already used in pipx-version-check.selftest.sh.
function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WATCHER_SH = join(ROOT, 'store', 'git-repo-watcher.sh')
const PIPX_CHECK_SH = join(ROOT, 'store', 'pipx-version-check.sh')
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

// Card eedb2871: before this, a NOCHANGE/CHANGED:code result was only ever PRINTED, never
// persisted -- an enabled=true entry could be fetched and compared every single day and still
// show a last_checked_at from weeks ago, because nothing wrote it down. These pin that every
// genuine look (NOCHANGE, a "code" flag, a diverged ff-merge) now stamps last_checked_at in the
// state file, while the reviewed last_sha pin for a "code"/diverged entry stays untouched until a
// human reviews the drift via watched-repos-record-review.sh -- only an auto-applied "text"
// fast-forward is allowed to move last_sha on its own.
describe('git-repo-watcher.sh stamps last_checked_at on every genuine look (card eedb2871)', () => {
  it('NOCHANGE stamps last_checked_at with today, leaving last_sha exactly as it was', () => {
    const head = git(upstream, 'rev-parse', 'HEAD')
    writeRegistry([
      { name: 'demo', repo: upstream, branch: 'main', local: clone, type: 'text', enabled: true, note: 'x' },
    ])
    writeFileSync(statePath, JSON.stringify({ demo: { last_sha: head, last_checked_at: '2026-10-09' } }))
    const out = runWatcherAt(dir)
    expect(out).toContain('NOCHANGE:demo')
    const state = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(state.demo.last_checked_at).not.toBe('2026-10-09')
    expect(state.demo.last_checked_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(state.demo.last_sha).toBe(head) // untouched -- nothing changed
  })

  it('a "code" adoption flagged for review stamps last_checked_at but does NOT advance last_sha past the reviewed pin', () => {
    const before = git(upstream, 'rev-parse', 'HEAD')
    writeFileSync(join(upstream, 'b.txt'), 'two\n')
    gitOk(upstream, 'add', 'b.txt')
    gitOk(upstream, 'commit', '-q', '-m', 'second')
    writeRegistry([
      { name: 'demo', repo: upstream, branch: 'main', local: clone, type: 'code', enabled: true, note: 'x' },
    ])
    writeFileSync(statePath, JSON.stringify({ demo: { last_sha: before, last_checked_at: '2026-10-09' } }))
    const out = runWatcherAt(dir)
    expect(out).toContain('CHANGED:code:demo')
    expect(out).toContain('FLAGGED-review-before-update')
    const state = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(state.demo.last_checked_at).toBe(todayIso())
    // the reviewed pin must NOT silently advance past an unreviewed upstream commit
    expect(state.demo.last_sha).toBe(before)
  })

  it('a "text" auto-fast-forward stamps BOTH last_checked_at and the new last_sha', () => {
    const before = git(upstream, 'rev-parse', 'HEAD')
    writeFileSync(join(upstream, 'b.txt'), 'two\n')
    gitOk(upstream, 'add', 'b.txt')
    gitOk(upstream, 'commit', '-q', '-m', 'second')
    const after = git(upstream, 'rev-parse', 'HEAD')
    writeRegistry([
      { name: 'demo', repo: upstream, branch: 'main', local: clone, type: 'text', enabled: true, note: 'x' },
    ])
    writeFileSync(statePath, JSON.stringify({ demo: { last_sha: before, last_checked_at: '2026-10-09' } }))
    const out = runWatcherAt(dir)
    expect(out).toContain('CHANGED:text:demo')
    const state = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(state.demo.last_checked_at).toBe(todayIso())
    expect(state.demo.last_sha).toBe(after) // a text adoption IS allowed to advance its own pin
  })

  it('a disabled entry is never written to the state file at all -- no check happened', () => {
    const head = git(upstream, 'rev-parse', 'HEAD')
    writeRegistry([
      { name: 'demo', repo: upstream, branch: 'main', local: clone, type: 'text', enabled: false, note: 'x' },
    ])
    writeFileSync(statePath, JSON.stringify({ demo: { last_sha: head, last_checked_at: '2026-10-09' } }))
    const out = runWatcherAt(dir)
    expect(out).toContain('DISABLED:demo')
    const state = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(state.demo.last_checked_at).toBe('2026-10-09') // untouched -- a disabled entry is not a look
  })
})

// Card eedb2871 F-1/L3 (QA FAIL 19034, WhiteHat2 L3): store/pipx-version-check.sh existed and
// was correct (its own selftest was green), but NOTHING periodic ever called it -- the live
// store/watched-repos-state.json still showed the pipx entries stuck at a last_checked_at from
// 2026-08-26 even on the gated SHA. This proves the actual wiring, not just the standalone
// script: a real git-repo-watcher.sh run, with a pipx entry in the SAME registry it already
// reads, must reach pipx-version-check.sh and stamp that entry too.
describe('git-repo-watcher.sh invokes pipx-version-check.sh when present (card eedb2871 F-1/L3)', () => {
  function runWatcherWithPipxAt(cfgDir: string, extraEnv: Record<string, string> = {}): string {
    const watcherCopy = join(cfgDir, 'git-repo-watcher.sh')
    writeFileSync(watcherCopy, readFileSync(WATCHER_SH))
    const pipxCopy = join(cfgDir, 'pipx-version-check.sh')
    writeFileSync(pipxCopy, readFileSync(PIPX_CHECK_SH))
    chmodSync(pipxCopy, 0o755) // the watcher gates the call on `[[ -x "$PIPX_CHECK" ]]`
    return execFileSync('bash', [watcherCopy], {
      encoding: 'utf-8',
      env: { ...process.env, WATCHED_REPOS_STATE_JSON: statePath, ...extraEnv },
    })
  }

  it('a periodic git-repo-watcher.sh run also checks a pipx-adopted entry and stamps its last_checked_at -- before this fix nothing ever called pipx-version-check.sh at all', () => {
    const overrideDir = join(dir, 'pypi-override')
    mkdirSync(overrideDir, { recursive: true })
    writeFileSync(join(overrideDir, 'widget-pipx.json'), JSON.stringify({ info: { version: '1.2.3' } }))
    writeRegistry([{ name: 'widget-pipx', adoption: 'pipx', pinned_version: '1.2.3' }])
    writeFileSync(statePath, JSON.stringify({ 'widget-pipx': { last_checked_at: '2026-08-26' } }))
    const out = runWatcherWithPipxAt(dir, { PIPX_VERSION_CHECK_PYPI_OVERRIDE_DIR: overrideDir })
    expect(out).toContain('NOCHANGE:widget-pipx @ 1.2.3')
    const state = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(state['widget-pipx'].last_checked_at).toBe(todayIso())
  })

  it('without pipx-version-check.sh present (e.g. a harness copying only the watcher) the run still succeeds as a no-op -- a missing optional script never crashes the loop', () => {
    writeRegistry([
      { name: 'demo', repo: upstream, branch: 'main', local: clone, type: 'text', enabled: true, note: 'x' },
    ])
    const out = runWatcherAt(dir) // existing helper copies ONLY git-repo-watcher.sh
    expect(out).toContain('NOCHANGE:demo')
    expect(out).not.toContain('widget-pipx')
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
    execFileSync('bash', [RECORD_SH, 'demo', '--sha', 'abc1234', '--upstream-sha', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '--registry', registryPath, '--state', statePath])
    const state = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(state.demo.last_sha).toBe('abc1234')
    expect(state.demo.last_checked_upstream_sha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(typeof state.demo.last_checked_at).toBe('string')

    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'))
    const entry = registry.find((e: { name: string }) => e.name === 'demo')
    expect(entry.last_sha).toBeUndefined()
    expect(entry.last_checked_upstream_sha).toBeUndefined()
    expect(entry.note).toBe('existing note') // no --note-append given: untouched
  })

  it('appends to the note (not replacing it) only when --note-append is given, leaving other entries alone', () => {
    execFileSync('bash', [RECORD_SH, 'demo', '--sha', 'def4567', '--note-append', '2026-10-09: reviewed, no-op', '--registry', registryPath, '--state', statePath])
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

  // Card ffca678d (RedHat LOW): this is the actual write path into watched-repos-state.json --
  // src/web/routes/integrated-repos.ts later hands that same last_sha to git argv. An
  // unvalidated --sha here was the injection's true origin point, three hops upstream of the
  // git call that demonstrated it.
  it('rejects a git-option-shaped --sha instead of writing it to the state file', () => {
    let threw = false
    let stderr = ''
    try {
      execFileSync('bash', [RECORD_SH, 'demo', '--sha', '--output=/tmp/should-not-write', '--registry', registryPath, '--state', statePath], { stdio: 'pipe' })
    } catch (err) {
      threw = true
      stderr = String((err as { stderr?: Buffer }).stderr ?? '')
    }
    expect(threw).toBe(true)
    expect(stderr).toContain('invalid --sha')
    expect(() => readFileSync(statePath, 'utf-8')).toThrow() // never created
  })

  it('rejects a too-short --sha (below git\'s 7-char abbreviation floor)', () => {
    expect(() =>
      execFileSync('bash', [RECORD_SH, 'demo', '--sha', 'ab12', '--registry', registryPath, '--state', statePath], { stdio: 'pipe' }),
    ).toThrow()
  })

  it('rejects a git-option-shaped --upstream-sha, even with a valid --sha', () => {
    expect(() =>
      execFileSync(
        'bash',
        [RECORD_SH, 'demo', '--sha', 'abc1234', '--upstream-sha', '--output=/tmp/should-not-write', '--registry', registryPath, '--state', statePath],
        { stdio: 'pipe' },
      ),
    ).toThrow()
    expect(() => readFileSync(statePath, 'utf-8')).toThrow() // never created
  })

  // Card 9710bdfd (WhiteHat2 follow-up to eedb2871 L2): the state-file write here used to be
  // read-modify-write with no lock and no atomic rename -- the same bug class eedb2871 fixed
  // for git-repo-watcher.sh/pipx-version-check.sh's shared writer of this SAME file, measured
  // there at 15/25 rounds losing a pin under 8 concurrent writers. This runs 8 concurrent
  // watched-repos-record-review.sh invocations (different names, 3 rounds each), mirroring
  // store/pipx-version-check.selftest.sh Case 10's shape.
  // QA2 FAIL 19491 finding 1: an un-forced race only caught the flock's removal 3/5 runs (60%)
  // -- too flaky to trust as a regression guard. WATCHED_STATE_TEST_SLEEP_S (same test-only hook
  // as external-repos-sync.sh's write_back(), shared state file, same reasoning) forces every
  // one of the 8 round-0 callers to read the SAME pre-write state before any of them writes;
  // under the flock this still serializes correctly (one writer sleeps at a time, holding the
  // lock), so the assertion stays meaningful either way.
  it('8 concurrent watched-repos-record-review.sh invocations (different names, 3 rounds each, forced overlap) all keep their pin -- none lost under the flock', async () => {
    const names = Array.from({ length: 8 }, (_, i) => `concurrent-${i}`)
    writeRegistry(names.map((n) => ({ name: n, repo: upstream, branch: 'main', local: clone, type: 'text', enabled: true })))

    await Promise.all(
      names.map(async (name) => {
        for (let round = 0; round < 3; round++) {
          await execFileP(
            'bash',
            [RECORD_SH, name, '--sha', `deadbee${round}`, '--registry', registryPath, '--state', statePath],
            { env: { ...process.env, WATCHED_STATE_TEST_SLEEP_S: '0.3' } },
          )
        }
      }),
    )

    const state: Record<string, { last_sha?: string }> = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(Object.keys(state)).toHaveLength(8)
    for (const name of names) {
      expect(state[name]?.last_sha).toBe('deadbee2') // last round's value, no entry lost
    }
  }, 15000)

  // QA2 FAIL 19491 finding 2: the REVIEW's "FAIL CLOSED on a state file that fails to parse as
  // JSON" claim had zero test coverage here either -- reverting that branch to the old silent
  // reset-to-{} behaviour left this whole describe block fully green. Pins the actual CLI
  // contract (this script's top-level `exit "$state_rc"` already propagates correctly, unlike
  // write_back()'s bare function return which card 9710bdfd also had to fix).
  it('a CORRUPT state file makes the CLI fail closed -- non-zero exit, file left untouched, no silent reset to {}', () => {
    const corrupt = '{ not valid json !!'
    writeFileSync(statePath, corrupt)
    let threw = false
    let stderr = ''
    try {
      execFileSync('bash', [RECORD_SH, 'demo', '--sha', 'deadbee0', '--registry', registryPath, '--state', statePath], { stdio: 'pipe' })
    } catch (err) {
      threw = true
      stderr = String((err as { stderr?: Buffer }).stderr ?? '')
    }
    expect(threw).toBe(true)
    expect(stderr).toContain('corrupt state file')
    expect(readFileSync(statePath, 'utf-8')).toBe(corrupt) // untouched, not reset to {}
  })

  // WhiteHat (cybersec) F2 LOW on card 9710bdfd (gate comment 19504): the registry
  // (watched-repos.json) --note-append write had no lock and no atomic rename at all -- measured
  // losing 8/12 concurrent notes on a single entry. Same forced-overlap pattern as the state-file
  // concurrency test above (WATCHED_REGISTRY_TEST_SLEEP_S, see the matching comment in the script).
  it('12 concurrent --note-append calls on the SAME entry all keep their note -- none lost under the registry lock', async () => {
    const calls = Array.from({ length: 12 }, (_, i) =>
      execFileP(
        'bash',
        [RECORD_SH, 'demo', '--sha', 'deadbee0', '--note-append', `note-${i}`, '--registry', registryPath, '--state', statePath],
        { env: { ...process.env, WATCHED_REGISTRY_TEST_SLEEP_S: '0.2' } },
      ),
    )
    await Promise.all(calls)

    const registry: Array<{ name: string; note?: string }> = JSON.parse(readFileSync(registryPath, 'utf-8'))
    const demo = registry.find((e) => e.name === 'demo')
    for (let i = 0; i < 12; i++) {
      expect(demo?.note).toContain(`note-${i}`)
    }
  }, 15000)
})

// Card 9710bdfd GO follow-up (CYBERED comment 19618, Gate-SHA 79a0c9c45cb81fce290beda95d216d703fdd6be4):
// the GO verdict listed four non-blocking survivor mutants (R5, S4/R3, L1, a file-mode INFO),
// closed out here by card 8aed7984. Each gets either a mutation-resistant pin (MUTATION CHECK
// proves the exact survivor mutant makes the pin fail) or, for L1, the fix itself (reordering the
// writes) is what the regression test below exercises. S4 (external-repos-sync.sh's twin of R3)
// is the identical tmp+replace pattern in a sibling file and is not separately re-tested here.
describe('watched-repos-record-review.sh -- GO follow-up survivors (card 8aed7984)', () => {
  beforeEach(() => {
    writeRegistry([
      { name: 'demo', repo: upstream, branch: 'main', local: clone, type: 'text', enabled: true, note: 'existing note' },
    ])
  })

  // L1: the state write now runs BEFORE the registry note-append (see the comment above the
  // state-write block in the script). A corrupt state file must abort before the note is
  // touched at all -- reverting to the old order (registry first) would make this assertion
  // fail, because the note would land despite the state write never succeeding.
  it('L1: a corrupt state file aborts before the registry note is touched, so a fixed retry does not double-append', () => {
    const corrupt = '{ not valid json !!'
    writeFileSync(statePath, corrupt)
    expect(() =>
      execFileSync(
        'bash',
        [RECORD_SH, 'demo', '--sha', 'deadbee0', '--note-append', 'first attempt', '--registry', registryPath, '--state', statePath],
        { stdio: 'pipe' },
      ),
    ).toThrow()
    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'))
    expect(registry.find((e: { name: string }) => e.name === 'demo').note).toBe('existing note') // unchanged

    // Retry after fixing the state file: the note must land exactly once, not twice.
    writeFileSync(statePath, JSON.stringify({}))
    execFileSync('bash', [RECORD_SH, 'demo', '--sha', 'deadbee0', '--note-append', 'first attempt', '--registry', registryPath, '--state', statePath])
    const after = JSON.parse(readFileSync(registryPath, 'utf-8'))
    expect(after.find((e: { name: string }) => e.name === 'demo').note).toBe('existing note | first attempt')
  })

  // R5: every state-writer (git-repo-watcher.sh, pipx-version-check.sh, external-repos-sync.sh,
  // this script) must share the exact same $STATE.lock file, or the shared exclusion the whole
  // card family relies on silently stops applying between any two of them. Proven here between
  // this script and pipx-version-check.sh: a record-review.sh write holds the lock while
  // sleeping; a concurrent pipx-version-check.sh write to the SAME state file must block on the
  // SAME lock and therefore never lose either entry.
  it('R5: a concurrent pipx-version-check.sh write and a record-review.sh write to the SAME state file never lose either entry', async () => {
    const overrideDir = join(dir, 'pypi-override')
    mkdirSync(overrideDir, { recursive: true })
    writeFileSync(join(overrideDir, 'widget-pipx.json'), JSON.stringify({ info: { version: '1.2.3' } }))
    writeRegistry([
      { name: 'demo', repo: upstream, branch: 'main', local: clone, type: 'text', enabled: true, note: 'x' },
      { name: 'widget-pipx', adoption: 'pipx', pinned_version: '1.2.3' },
    ])

    const recordP = execFileP('bash', [RECORD_SH, 'demo', '--sha', 'deadbee0', '--registry', registryPath, '--state', statePath], {
      env: { ...process.env, WATCHED_STATE_TEST_SLEEP_S: '0.5' },
    })
    const pipxP = execFileP('bash', [PIPX_CHECK_SH], {
      env: {
        ...process.env,
        WATCHED_REPOS_STATE_JSON: statePath,
        PIPX_VERSION_CHECK_REGISTRY_JSON: registryPath,
        PIPX_VERSION_CHECK_PYPI_OVERRIDE_DIR: overrideDir,
      },
    })
    await Promise.all([recordP, pipxP])

    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, { last_sha?: string; pypi_latest_version?: string }>
    expect(state['demo']?.last_sha).toBe('deadbee0')
    expect(state['widget-pipx']?.pypi_latest_version).toBe('1.2.3')
  }, 10000)

  // MUTATION CHECK for R5: a record-review.sh copy whose state-lock suffix is renamed from
  // ".lock" to ".lock2" no longer shares the lock with pipx-version-check.sh -- proving the pin
  // above is non-vacuous (it would have caught exactly the survivor mutant RedHat found).
  it('MUTATION: a record-review.sh copy with a renamed state-lock genuinely loses one of the two entries', async () => {
    const overrideDir = join(dir, 'pypi-override-mutant')
    mkdirSync(overrideDir, { recursive: true })
    writeFileSync(join(overrideDir, 'widget-pipx.json'), JSON.stringify({ info: { version: '1.2.3' } }))
    writeRegistry([
      { name: 'demo', repo: upstream, branch: 'main', local: clone, type: 'text', enabled: true, note: 'x' },
      { name: 'widget-pipx', adoption: 'pipx', pinned_version: '1.2.3' },
    ])

    const mutantSh = join(dir, 'watched-repos-record-review-mutant.sh')
    const src = readFileSync(RECORD_SH, 'utf-8')
    const mutated = src.replace('200>"$STATE.lock" 2>&1 )"', '200>"$STATE.lock2" 2>&1 )"')
    expect(mutated).not.toBe(src) // the replace actually matched something
    writeFileSync(mutantSh, mutated)

    let lostAnEntry = false
    for (let attempt = 0; attempt < 5 && !lostAnEntry; attempt++) {
      writeFileSync(statePath, JSON.stringify({}))
      const recordP = execFileP('bash', [mutantSh, 'demo', '--sha', 'deadbee0', '--registry', registryPath, '--state', statePath], {
        env: { ...process.env, WATCHED_STATE_TEST_SLEEP_S: '0.5' },
      })
      const pipxP = execFileP('bash', [PIPX_CHECK_SH], {
        env: {
          ...process.env,
          WATCHED_REPOS_STATE_JSON: statePath,
          PIPX_VERSION_CHECK_REGISTRY_JSON: registryPath,
          PIPX_VERSION_CHECK_PYPI_OVERRIDE_DIR: overrideDir,
        },
      })
      await Promise.all([recordP, pipxP])
      const state = JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, unknown>
      lostAnEntry = !state['demo'] || !state['widget-pipx']
    }
    expect(lostAnEntry).toBe(true)
  }, 15000)

  // R3 (S4's twin in this script): a lock-free reader (the real-world case -- dashboard-settings.ts,
  // integrated-repos.ts both read this file without a lock) must never observe a torn/incomplete
  // file no matter how long the write takes. Proven by stretching the window between "tmp file
  // fully written" and the atomic rename via WATCHED_STATE_TEST_PRE_REPLACE_SLEEP_S, while a tight
  // reader loop samples the real target path throughout.
  it('R3: a lock-free reader never observes a torn state file during a slow write (atomic swap pin)', async () => {
    writeFileSync(statePath, JSON.stringify({ demo: { last_sha: 'old0000' } }))
    const writeP = execFileP('bash', [RECORD_SH, 'demo', '--sha', 'deadbee1', '--registry', registryPath, '--state', statePath], {
      env: { ...process.env, WATCHED_STATE_TEST_PRE_REPLACE_SLEEP_S: '0.4' },
    })
    let sawInvalid = false
    let samples = 0
    const readerTimer = setInterval(() => {
      samples++
      try {
        JSON.parse(readFileSync(statePath, 'utf-8')) // throws on torn/partial content
      } catch {
        sawInvalid = true
      }
    }, 2)
    await writeP
    clearInterval(readerTimer)
    expect(samples).toBeGreaterThan(5) // the reader actually sampled during the delay
    expect(sawInvalid).toBe(false)
  }, 10000)

  // MUTATION CHECK for R3: reproduces the PRE-FIX in-place truncating write directly (not via the
  // real script) to prove the pin above is non-vacuous -- without tmp+rename, the same slow-write
  // window genuinely produces a torn read.
  it('MUTATION: an in-place truncating write (the pre-fix shape) genuinely produces a torn read during the same window', async () => {
    writeFileSync(statePath, JSON.stringify({ demo: { last_sha: 'old0000' } }))
    const truncatingPy = join(dir, 'truncating-write.py')
    writeFileSync(
      truncatingPy,
      'import json, sys, time\n' +
        'path, delay = sys.argv[1], float(sys.argv[2])\n' +
        'f = open(path, "w")\n' + // truncates immediately -- the pre-fix shape
        'time.sleep(delay)\n' +
        'json.dump({"demo": {"last_sha": "newsha01"}}, f)\n' +
        'f.close()\n',
    )
    const truncatingWriteP = execFileP('python3', [truncatingPy, statePath, '0.4'])
    let sawInvalid = false
    const readerTimer = setInterval(() => {
      try {
        JSON.parse(readFileSync(statePath, 'utf-8'))
      } catch {
        sawInvalid = true
      }
    }, 2)
    await truncatingWriteP
    clearInterval(readerTimer)
    expect(sawInvalid).toBe(true)
  }, 10000)

  // File-mode finding (CYBERED comment 19618, INFO-weight): os.replace() used to carry the tmp
  // file's mode from the CALLER's umask, not the state file's prior mode -- measured turning a
  // 0600 state file into 0644 under umask 022. Pinned by running under an explicitly loose umask.
  it('preserves the state file\'s existing 0600 mode across a rewrite even under a loose umask', () => {
    writeFileSync(statePath, JSON.stringify({}))
    chmodSync(statePath, 0o600)
    execFileSync('bash', ['-c', 'umask 022 && exec "$0" "$@"', RECORD_SH, 'demo', '--sha', 'deadbee0', '--registry', registryPath, '--state', statePath])
    expect(statSync(statePath).mode & 0o777).toBe(0o600)
  })

  // MUTATION CHECK: without the os.chmod() preservation, the same loose umask genuinely loosens a
  // freshly-created tmp file to 0644 before the swap -- proves the pin above is non-vacuous.
  it('MUTATION: a bare tmp-file create+replace (no chmod) under umask 022 genuinely ends up 0644', () => {
    const target = join(dir, 'mutant-mode-target.json')
    writeFileSync(target, '{}')
    chmodSync(target, 0o600)
    const mutantModePy = join(dir, 'mutant-mode.py')
    writeFileSync(mutantModePy, 'import os, sys\np = sys.argv[1]\ntmp = p + ".tmp"\nopen(tmp, "w").write("{}")\nos.replace(tmp, p)\n')
    execFileSync('bash', ['-c', 'umask 022 && exec python3 "$0" "$@"', mutantModePy, target])
    expect(statSync(target).mode & 0o777).toBe(0o644)
  })
})

describe('git-repo-watcher.sh rejects a non-hex/too-short last_sha instead of using it for the prefix match (card ffca678d)', () => {
  it('a garbage state-file last_sha is reported as ERROR:badsha and does NOT mask a real upstream change', () => {
    const before = git(upstream, 'rev-parse', 'HEAD')
    writeFileSync(join(upstream, 'b.txt'), 'two\n')
    gitOk(upstream, 'add', 'b.txt')
    gitOk(upstream, 'commit', '-q', '-m', 'second')
    writeRegistry([
      { name: 'demo', repo: upstream, branch: 'main', local: clone, type: 'text', enabled: true, note: 'x' },
    ])
    // A 1-char prefix would glob-match almost anything -- exactly the false-NOCHANGE risk the
    // card flags. With validation, it is rejected and the watcher falls back to the clone's
    // real HEAD (= `before`), which correctly still differs from the new upstream tip.
    writeFileSync(statePath, JSON.stringify({ demo: { last_sha: before.slice(0, 1), last_checked_at: '2026-10-09' } }))
    const out = runWatcherAt(dir)
    expect(out).toContain('ERROR:badsha:demo')
    expect(out).toContain('CHANGED:text:demo')
    expect(out).not.toContain('NOCHANGE:demo')
  })

  it('a git-option-shaped last_sha is rejected the same way, never reaches a git argv position', () => {
    const head = git(upstream, 'rev-parse', 'HEAD')
    writeRegistry([
      { name: 'demo', repo: upstream, branch: 'main', local: clone, type: 'text', enabled: true, note: 'x' },
    ])
    writeFileSync(statePath, JSON.stringify({ demo: { last_sha: '--output=/tmp/should-not-write', last_checked_at: '2026-10-09' } }))
    const out = runWatcherAt(dir)
    expect(out).toContain('ERROR:badsha:demo')
    expect(out).toContain('NOCHANGE:demo') // falls back to real HEAD, which equals upstream here
    expect(head).toBeTruthy()
  })

  // Card ed4926a3 (RedHat LOW, ffca678d gate comment 13314): a last_sha containing a newline
  // used to split one TSV row into two in the python->bash row reader, letting the tail of the
  // value masquerade as a genuine extra output line (e.g. a fake CHANGED:...) to anyone
  // reading the watcher's output line-by-line -- not merely an unescaped character in the
  // ERROR:badsha message itself.
  it('a newline embedded in last_sha cannot forge an extra output line', () => {
    writeRegistry([
      { name: 'demo', repo: upstream, branch: 'main', local: clone, type: 'text', enabled: true, note: 'x' },
    ])
    writeFileSync(
      statePath,
      JSON.stringify({ demo: { last_sha: 'bad\nCHANGED:text:forged:aaaaaaaa..bbbbbbbb', last_checked_at: '2026-10-09' } }),
    )
    const out = runWatcherAt(dir)
    expect(out).toContain('ERROR:badsha:demo')
    // Exactly one row's worth of output (ERROR:badsha + NOCHANGE + SUMMARY) for one registry
    // entry -- the injected newline must be folded into the ERROR line's own text, not split
    // into an extra line (which, unfixed, actually surfaces as its own
    // "DISABLED:CHANGED:text:forged:..." line, not a bare "CHANGED:..." one -- asserting the
    // total line count catches that shape regardless of what prefix the forged line gets).
    const lines = out.trim().split('\n')
    expect(lines).toHaveLength(3)
    // the folded-in text is fine on the ERROR line itself; it must not be its OWN line
    expect(lines.filter((l) => l.includes('forged:aaaaaaaa..bbbbbbbb')).every((l) => l.startsWith('ERROR:badsha'))).toBe(true)
  })

  // MUTATION CHECK: without the TSV-field sanitizer, the forged line above is not merely
  // theoretical -- the same newline genuinely produces a second, bogus row when joined the
  // way the OLD (unsanitized) python row-generator did.
  it('MUTATION: the pre-fix row join genuinely splits a newline into a second row (proves the test is non-vacuous)', () => {
    const raw = execFileSync('python3', [
      '-c',
      'import sys\nlast_sha = sys.argv[1]\nprint("\\t".join(["demo", "repo", "main", "local", "text", "True", last_sha]))',
      'bad\nCHANGED:text:forged:aaaaaaaa..bbbbbbbb',
    ], { encoding: 'utf-8' })
    expect(raw.trim().split('\n').length).toBe(2) // the unsanitized join genuinely splits
  })

  // WhiteHat L1 (ed4926a3 gate, card e4bfd6f2): the ERROR:badsha line's own safe_sha value
  // (store/git-repo-watcher.sh line 106: `tr -cd '[:print:]' | cut -c1-80`) had no test proving
  // it strips an ESC byte AND caps length -- the TS-side equivalent (statusForRepo, card
  // ffca678d/ed4926a3) already has this exact test, this was the missing bash-side twin.
  it('an ESC byte and a value over 80 chars are both neutralised in the ERROR:badsha line', () => {
    const longGarbage = '\x1b[31m' + 'z'.repeat(200) + '\x1b[0m' // non-hex, >80 chars, carries ESC
    writeRegistry([
      { name: 'demo', repo: upstream, branch: 'main', local: clone, type: 'text', enabled: true, note: 'x' },
    ])
    writeFileSync(statePath, JSON.stringify({ demo: { last_sha: longGarbage, last_checked_at: '2026-10-09' } }))
    const out = runWatcherAt(dir)
    expect(out).toContain('ERROR:badsha:demo')
    // no raw control chars (incl. ESC) reached the output -- \n (0x0a) is the output's own
    // legitimate line separator between ERROR:badsha/NOCHANGE/SUMMARY, so it is excluded here.
    expect(out).not.toMatch(/[\x00-\x09\x0b-\x1f]/)
    const match = out.match(/last_sha '([^']*)'/)
    expect(match).not.toBeNull()
    expect(match![1]!.length).toBeLessThanOrEqual(80)
  })

  // MUTATION CHECK: without the `tr -cd '[:print:]' | cut -c1-80` sanitizer, the ERROR:badsha
  // line is not merely theoretically unsafe -- a direct, unsanitized echo of the same value
  // genuinely leaks the raw ESC byte and the full, uncapped length. Run against this
  // (deliberately old-shaped) echo to prove the real fix -- not just the assertions above --
  // is what makes the test above go red if the sanitizer is removed.
  it('MUTATION: the pre-fix (unsanitized) echo genuinely leaks the ESC byte and exceeds 80 chars (proves the test above is non-vacuous)', () => {
    const longGarbage = '\x1b[31m' + 'z'.repeat(200) + '\x1b[0m'
    const raw = execFileSync(
      'bash',
      ['-c', 'echo "ERROR:badsha:demo (last_sha \'$1\' is not a valid hex sha, ignoring recorded value)"', '--', longGarbage],
      { encoding: 'utf-8' },
    )
    expect(raw).toMatch(/[\x00-\x1f]/) // the raw ESC byte survives, unsanitized
    const match = raw.match(/last_sha '([^']*)'/)
    expect(match).not.toBeNull()
    expect(match![1]!.length).toBeGreaterThan(80)
  })
})

describe('git-repo-watcher.sh rejects an invalid branch instead of handing it to git (card ed4926a3, ffca678d INFO follow-up)', () => {
  it('an option-shaped branch is rejected as ERROR:badbranch and never reaches the fetch argv', () => {
    // A marker INSIDE `dir`, not a fixed /tmp path -- `dir` is wiped in afterEach, so a
    // leftover from an earlier (mutated) run of this exact test can never leak a false "safe"
    // result into a later run.
    const marker = join(dir, 'should-not-exist-ed4926a3-watcher')
    writeRegistry([
      { name: 'demo', repo: upstream, branch: `--upload-pack=touch ${marker}`, local: clone, type: 'text', enabled: true, note: 'x' },
    ])
    const out = runWatcherAt(dir)
    expect(out).toContain('ERROR:badbranch:demo')
    expect(existsSync(marker)).toBe(false)
  })

  it('a normal branch name is unaffected (no regression on the real feature)', () => {
    const head = git(upstream, 'rev-parse', 'HEAD')
    writeRegistry([
      { name: 'demo', repo: upstream, branch: 'main', local: clone, type: 'text', enabled: true, note: 'x' },
    ])
    writeFileSync(statePath, JSON.stringify({ demo: { last_sha: head, last_checked_at: '2026-10-09' } }))
    const out = runWatcherAt(dir)
    expect(out).toContain('NOCHANGE:demo')
  })

  // MUTATION CHECK: without --end-of-options + the allowlist, the option-shaped branch above
  // is not a hypothetical risk -- it genuinely runs the attacker's command via git fetch's own
  // --upload-pack option.
  it('MUTATION: the pre-fix fetch call shape genuinely runs the injected --upload-pack (proves the test is non-vacuous)', () => {
    const marker = join(dir, 'mutation-pwned-branch')
    execFileSync('rm', ['-f', marker])
    try {
      execFileSync('git', ['-C', clone, 'fetch', '-q', 'origin', `--upload-pack=touch ${marker}`], { stdio: 'pipe' })
    } catch {
      // git may still exit non-zero once the injected command runs and breaks the protocol --
      // what matters is whether the command executed, not the fetch's own exit code.
    }
    expect(existsSync(marker)).toBe(true)
  })
})
