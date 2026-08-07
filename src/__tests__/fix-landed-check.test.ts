// fix-landed-check.sh -- "committed" is not "landed" (card f507541b).
//
// On 2026-08-06 three separate cards were gate-passed while the code lived only on a feature branch:
// not in the integration branch, not in the live install's HEAD tree, in one case not even on disk.
// The worst of them was the rollback guard, so the protection against a recurring incident existed
// only on paper. Card status cannot see this; a green gate says nothing about which tree holds the code.
//
// The script answers four questions per commit -- merged, deployed, files present, build fresh -- and
// these tests prove each verdict against throwaway repos rather than against whatever state the real
// install happens to be in. Two properties get their own tests because they are the easy things to get
// wrong: the check must resolve the LIVE (main) worktree rather than the worktree it runs from, and it
// must not mutate anything.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(REPO, 'store', 'fix-landed-check.sh')

function run(args: string[], cwd = REPO): { status: number; out: string } {
  try {
    const out = execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf-8', stdio: 'pipe', cwd })
    return { status: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? -1, out: String(err.stdout ?? '') + String(err.stderr ?? '') }
  }
}

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', stdio: 'pipe' }).trim()

/** Repo with a `base` commit on branch `fake-integration`, plus a `feature` commit only on HEAD. */
function makeInstall(): { dir: string; base: string; feat: string } {
  const dir = mkdtempSync(join(tmpdir(), 'landed-check-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@local')
  git(dir, 'config', 'user.name', 'test')
  mkdirSync(join(dir, 'store'), { recursive: true })
  writeFileSync(join(dir, 'a'), 'one')
  git(dir, 'add', 'a')
  git(dir, 'commit', '-q', '-m', 'base')
  const base = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'branch', '-f', 'fake-integration')
  writeFileSync(join(dir, 'b'), 'two')
  git(dir, 'add', 'b')
  git(dir, 'commit', '-q', '-m', 'feature')
  return { dir, base, feat: git(dir, 'rev-parse', 'HEAD') }
}

const check = (dir: string, sha: string) =>
  run(['--commit', sha, '--install', dir, '--ref', 'fake-integration'])

describe('fix-landed-check.sh (card f507541b)', () => {
  it('passes its own selftest', () => {
    const r = run(['--selftest'])
    expect(r.out).toContain('selftest OK')
    expect(r.status).toBe(0)
  })

  it('reports LANDED, exit 0, for a merged and deployed commit', () => {
    const { dir, base } = makeInstall()
    try {
      git(dir, 'checkout', '-q', base)
      mkdirSync(join(dir, 'dist'), { recursive: true })
      writeFileSync(join(dir, 'dist', '.built-commit'), base)
      const r = check(dir, base)
      expect(r.out.split('\n')[0]).toMatch(/^LANDED /)
      expect(r.status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flags a feature-branch-only commit as not-merged, exit 1', () => {
    const { dir, feat } = makeInstall()
    try {
      const r = check(dir, feat)
      expect(r.out).toContain('not-merged')
      expect(r.status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flags a commit ahead of the live HEAD as not-deployed, with the distance', () => {
    const { dir, base, feat } = makeInstall()
    try {
      git(dir, 'checkout', '-q', base)
      const r = check(dir, feat)
      expect(r.out).toContain('not-deployed')
      expect(r.out).toContain('1 committal elotte')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The failure mode a plain ancestor check misses: the commit IS in HEAD, the file is not on disk.
  it('flags files-missing when a touched file is in HEAD but gone from disk', () => {
    const { dir, feat } = makeInstall()
    try {
      unlinkSync(join(dir, 'b'))
      const r = check(dir, feat)
      expect(r.out).toContain('files-missing')
      expect(r.out).toContain('a LEMEZEN nincs')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flags stale-build when dist was built from an older commit', () => {
    const { dir, base, feat } = makeInstall()
    try {
      mkdirSync(join(dir, 'dist'), { recursive: true })
      writeFileSync(join(dir, 'dist', '.built-commit'), base)
      const r = check(dir, feat)
      expect(r.out).toContain('stale-build')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not claim stale-build when dist was built from the same or a newer commit', () => {
    const { dir, base, feat } = makeInstall()
    try {
      mkdirSync(join(dir, 'dist'), { recursive: true })
      writeFileSync(join(dir, 'dist', '.built-commit'), feat)
      expect(check(dir, base).out).not.toContain('stale-build')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // QA2 FAIL on d4d8c56: an UNVERIFIED check was recorded as a detail line only, so a repo with no
  // origin/develop ref (fresh clone, never fetched) reported LANDED with exit 0 while merge status was
  // never looked at. A landed-checker that says LANDED by mistake is worse than none.
  it('reports UNKNOWN, exit 3, when the integration ref does not exist locally', () => {
    const { dir, base, feat } = makeInstall()
    try {
      mkdirSync(join(dir, 'dist'), { recursive: true })
      writeFileSync(join(dir, 'dist', '.built-commit'), feat)
      const r = run(['--commit', base, '--install', dir, '--ref', 'no-such-ref-anywhere'])
      expect(r.out.split('\n')[0]).toMatch(/^UNKNOWN .* merge-unverifiable$/)
      expect(r.status).toBe(3)
      expect(r.out).not.toContain('LANDED') // NOT-LANDED also contains "LANDED" as a substring
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports UNKNOWN, exit 3, when there is no build marker to check against', () => {
    const { dir, base } = makeInstall()
    try {
      const r = check(dir, base) // makeInstall creates no dist/
      expect(r.out.split('\n')[0]).toMatch(/^UNKNOWN .* build-unverifiable$/)
      expect(r.status).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // A definite failure is more informative than "cannot tell", so it must win.
  it('prefers NOT-LANDED over UNKNOWN when a check has definitely failed', () => {
    const { dir, base, feat } = makeInstall()
    try {
      git(dir, 'checkout', '-q', base) // feat is now definitely NOT deployed...
      // ...while the missing ref and missing build marker are merely unknown
      const r = run(['--commit', feat, '--install', dir, '--ref', 'no-such-ref-anywhere'])
      expect(r.out.split('\n')[0]).toMatch(/^NOT-LANDED .* not-deployed/)
      expect(r.status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports missing-commit rather than guessing, for an unknown sha', () => {
    const { dir } = makeInstall()
    try {
      const r = check(dir, '0'.repeat(40))
      expect(r.out).toContain('missing-commit')
      expect(r.status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exits 2 on a usage error, distinct from the not-landed exit 1', () => {
    expect(run(['--nonsense']).status).toBe(2)
    expect(run(['--commit']).status).toBe(2)
  })

  // The whole point is to inspect a live install, so it must be safe to run against one.
  it('mutates nothing in the install it inspects', () => {
    const { dir, feat } = makeInstall()
    try {
      const before = { head: git(dir, 'rev-parse', 'HEAD'), status: git(dir, 'status', '--porcelain') }
      check(dir, feat)
      run(['--commit', feat, '--install', dir])
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(before.head)
      expect(git(dir, 'status', '--porcelain')).toBe(before.status)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Checking a feature worktree against itself would always say "deployed" and hide the exact gap.
  it('resolves the MAIN worktree, not the worktree it is invoked from', () => {
    const { dir, base, feat } = makeInstall()
    const wt = `${dir}-wt`
    try {
      git(dir, 'checkout', '-q', base) // "live install" stays on base
      git(dir, 'worktree', 'add', '-q', '--detach', wt, feat)
      const r = run(['--commit', feat, '--ref', 'fake-integration'], wt)
      expect(r.out).toContain('not-deployed') // judged against the main checkout, not wt's own HEAD
    } finally {
      rmSync(wt, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('fix-landed-check.sh --sweep', () => {
  /** Minimal kanban DB: one card per commit, each with a REVIEW comment naming it. */
  function seedBoard(dir: string, rows: Array<{ card: string; sha: string; status: string }>) {
    const db = join(dir, 'store', 'claudeclaw.db')
    const sql = [
      'CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, status TEXT);',
      'CREATE TABLE kanban_comments (card_id TEXT, content TEXT, created_at INTEGER);',
      ...rows.flatMap((r, i) => [
        `INSERT INTO kanban_cards VALUES ('${r.card}', '${r.status}');`,
        // multi-line body on purpose: a raw newline used to split one comment across reads
        `INSERT INTO kanban_comments VALUES ('${r.card}', 'REVIEW: kesz, commit ${r.sha}.` +
          String.fromCharCode(10) +
          `masodik sor', ${1000 + i});`,
      ]),
    ].join('\n')
    execFileSync('sqlite3', [db], { input: sql, stdio: 'pipe' })
  }

  it('extracts the commit from a multi-line REVIEW comment and verdicts each card', () => {
    const { dir, base, feat } = makeInstall()
    try {
      git(dir, 'checkout', '-q', base)
      mkdirSync(join(dir, 'dist'), { recursive: true })
      writeFileSync(join(dir, 'dist', '.built-commit'), feat) // so the build check actually RUNS
      seedBoard(dir, [
        { card: 'aaaaaaaa', sha: base, status: 'done' },
        { card: 'bbbbbbbb', sha: feat, status: 'waiting' },
      ])
      const r = run(['--sweep', '--install', dir, '--ref', 'fake-integration'])
      expect(r.out).toMatch(/aaaaaaaa LANDED/)
      expect(r.out).toMatch(/bbbbbbbb NOT-LANDED/)
      expect(r.out).toContain('SUMMARY checked=2 not-landed=1 unknown=0')
      expect(r.status).toBe(1) // any not-landed card is a non-zero sweep
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('counts only the cards it actually checked when --limit truncates', () => {
    const { dir, base, feat } = makeInstall()
    try {
      git(dir, 'checkout', '-q', base)
      seedBoard(dir, [
        { card: 'aaaaaaaa', sha: base, status: 'done' },
        { card: 'bbbbbbbb', sha: feat, status: 'done' },
        { card: 'cccccccc', sha: base, status: 'done' },
      ])
      const r = run(['--sweep', '--limit', '2', '--install', dir, '--ref', 'fake-integration'])
      expect(r.out).toContain('checked=2') // not 3: an off-by-one here reports a card it never checked
      expect(r.out.split('\n').filter((l) => /^[a-z]{8} (LANDED|NOT-LANDED|UNKNOWN)/.test(l))).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Cybersec NO-GO F1 on d4d8c56: a mistyped parameter printed `checked=0 not-landed=0` and exited 0,
  // i.e. "everything landed". Zero coverage is not a clean bill of health -- the same overstated-
  // coverage class this tool exists to measure.
  it.each([
    ['--limit', 'abc'],
    ['--limit', '0'],
    ['--limit', '-1'],
    ['--status', 'nosuchstatus'],
    ['--status', "x') OR 1=1 --"], // F2 as reported: breaks the quoting
    // The space-free variant is the one that matters: it survives the word-split and, without the
    // allowlist, forms valid SQL (`IN ('waiting')OR('1'='1')`) that matches every row. The spaced
    // version above only produces a syntax error, so it would pass even with the allowlist removed.
    ['--status', "waiting')OR('1'='1"],
  ])('exits 2 instead of reporting a clean sweep for %s=%j', (flag, value) => {
    const { dir, base } = makeInstall()
    try {
      seedBoard(dir, [{ card: 'aaaaaaaa', sha: base, status: 'done' }])
      const r = run(['--sweep', '--install', dir, '--ref', 'fake-integration', flag, value])
      expect(r.status).toBe(2)
      expect(r.out).toMatch(/^ERROR:/m)
      expect(r.out).not.toContain('not-landed=0') // must never read as "all clear"
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Without this the validation could be "fixed" by rejecting everything.
  it('still sweeps normally with valid parameters', () => {
    const { dir, base, feat } = makeInstall()
    try {
      git(dir, 'checkout', '-q', base)
      mkdirSync(join(dir, 'dist'), { recursive: true })
      writeFileSync(join(dir, 'dist', '.built-commit'), base)
      seedBoard(dir, [
        { card: 'aaaaaaaa', sha: base, status: 'done' },
        { card: 'bbbbbbbb', sha: feat, status: 'done' },
      ])
      const r = run(['--sweep', '--install', dir, '--ref', 'fake-integration', '--limit', '40'])
      expect(r.status).toBe(1) // bbbbbbbb is genuinely not landed
      expect(r.out).toContain('checked=2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('errors clearly when the board database is absent', () => {
    const { dir } = makeInstall()
    try {
      const r = run(['--sweep', '--install', dir])
      expect(r.out).toContain('ERROR:no-kanban-db')
      expect(r.status).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
