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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

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
