// Card 1f1e3ae4 (Fazis fe3eff9f): Gate-SHA -> touched files.
//
// The merge tests build a REAL git repository with a REAL merge commit. That is not thoroughness
// for its own sake: the dispatching card suggested `git show --name-only`, which on a merge prints
// a COMBINED diff and therefore NOTHING, and marveen's Gate-SHAs are predominantly merge commits.
// A fixture-string test would have "passed" against the broken command just as happily.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AMBIGUOUS,
  GIT_SOURCE,
  UNRESOLVED,
  filesForCommits,
  gitSweepEdges,
  parseNameOnlyBatch,
  qualifyPath,
  resolveShaRepos,
} from '../kanban-relations-git.js'
import {
  initDatabase,
  getDb,
  createKanbanCard,
  addKanbanComment,
  gateShaTargets,
  reconcileRelationSource,
} from '../db.js'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim()

/** A repo with: a base commit, a branch commit, a MERGE of that branch, and a plain commit after. */
function buildRepo(dir: string, marker: string): Record<string, string> {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'user.name', 'test')
  git(dir, 'config', 'commit.gpgsign', 'false')

  writeFileSync(join(dir, 'README.md'), `base ${marker}\n`)
  git(dir, 'add', 'README.md')
  git(dir, 'commit', '-qm', 'base')
  const base = git(dir, 'rev-parse', 'HEAD')

  git(dir, 'checkout', '-q', '-b', 'feature')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 2\n')
  git(dir, 'add', 'src')
  git(dir, 'commit', '-qm', 'feature work')
  const branch = git(dir, 'rev-parse', 'HEAD')

  git(dir, 'checkout', '-q', 'main')
  git(dir, 'merge', '-q', '--no-ff', 'feature', '-m', 'merge: feature into main')
  const merge = git(dir, 'rev-parse', 'HEAD')

  writeFileSync(join(dir, 'CHANGELOG.md'), 'later\n')
  git(dir, 'add', 'CHANGELOG.md')
  git(dir, 'commit', '-qm', 'later')
  const later = git(dir, 'rev-parse', 'HEAD')

  return { base, branch, merge, later }
}

let dir: string
let repoA: string
let repoB: string
let A: Record<string, string>
let B: Record<string, string>
let repos: { name: string; path: string }[]

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kanban-relations-git-'))
  repoA = join(dir, 'marveen')
  repoB = join(dir, 'cleancore')
  A = buildRepo(repoA, 'A')
  B = buildRepo(repoB, 'B')
  repos = [
    { name: 'marveen', path: repoA },
    { name: 'cleancore', path: repoB },
  ]
})

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('the merge trap -- the reason this card exists', () => {
  it('plain `git show --name-only` on the merge prints NOTHING (the bug being avoided)', () => {
    // The negative control. If this ever starts returning files, the flag combination below stops
    // being load-bearing and the comment explaining it should go -- but until then, this is the
    // measurement the whole function is built around.
    const naive = execFileSync('git', ['-C', repoA, 'show', '--name-only', '--format=', A.merge!], {
      encoding: 'utf-8',
    })
    expect(naive.trim()).toBe('')
  })

  it('`-m --first-parent` returns the branch side of the merge', () => {
    const files = filesForCommits(repoA, [A.merge!])
    expect(files.get(A.merge!)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('and still works for an ordinary, single-parent commit', () => {
    const files = filesForCommits(repoA, [A.later!])
    expect(files.get(A.later!)).toEqual(['CHANGELOG.md'])
  })

  it('batches merge and non-merge commits in one call without mixing them up', () => {
    const files = filesForCommits(repoA, [A.merge!, A.later!, A.branch!])
    expect(files.get(A.merge!)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(files.get(A.later!)).toEqual(['CHANGELOG.md'])
    expect(files.get(A.branch!)).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('parseNameOnlyBatch', () => {
  it('shares one listing when a commit is printed once for two requests', () => {
    // `git show X X` prints the commit ONCE. Two abbreviations of the same commit are a real case:
    // 569 marveen abbreviations collapse to 542 distinct commits.
    const out = parseNameOnlyBatch('__KRC__ aaa\nsrc/a.ts\n\n__KRC__ aaa\n')
    expect(out.get('aaa')).toEqual(['src/a.ts'])
  })

  it('ignores blank lines and text before the first commit marker', () => {
    expect(parseNameOnlyBatch('stray\n\n__KRC__ bbb\n\nsrc/x.ts\n\n').get('bbb')).toEqual(['src/x.ts'])
  })

  it('records a commit with no files as an empty listing, not a missing one', () => {
    const out = parseNameOnlyBatch('__KRC__ ccc\n')
    expect(out.has('ccc')).toBe(true)
    expect(out.get('ccc')).toEqual([])
  })
})

describe('resolveShaRepos', () => {
  it('partitions shas across the repos and names where each landed', () => {
    const r = resolveShaRepos([A.merge!, B.later!], repos)
    expect(r.get(A.merge!)!.location).toBe('marveen')
    expect(r.get(B.later!)!.location).toBe('cleancore')
  })

  it('resolves an ABBREVIATED sha and keeps the stated form as the key', () => {
    const short = A.merge!.slice(0, 8)
    const r = resolveShaRepos([short], repos)
    expect(r.get(short)!.location).toBe('marveen')
    expect(r.get(short)!.full).toBe(A.merge)
    // The key is the abbreviation, because that is what the gate-sha edges carry.
    expect(r.has(A.merge!)).toBe(false)
  })

  it('marks a sha found in NEITHER repo, explicitly', () => {
    const r = resolveShaRepos(['deadbee'], repos)
    expect(r.get('deadbee')!.location).toBe(UNRESOLVED)
    expect(r.get('deadbee')!.full).toBeUndefined()
  })

  it('marks a sha found in BOTH repos ambiguous rather than picking one', () => {
    // Constructed rather than waited for: zero of the 1069 real shas collide today, and the design
    // must still refuse to guess, because a card was gated on ONE of the two commits.
    // A CLONE, not a rebuild: identical content still produces different commit ids because the
    // timestamps differ, so rebuilding proves nothing. A clone carries the same object names --
    // which is also the realistic shape (a fork, a mirror, a repo split).
    const shared = join(dir, 'shared')
    execFileSync('git', ['clone', '-q', '--no-hardlinks', repoA, shared], { encoding: 'utf-8' })
    expect(git(shared, 'rev-parse', 'HEAD~1')).toBe(A.merge)
    const r = resolveShaRepos([A.merge!], [...repos, { name: 'third', path: shared }])
    expect(r.get(A.merge!)!.location).toBe(AMBIGUOUS)
    rmSync(shared, { recursive: true, force: true })
  })

  it('survives an unreadable repo instead of failing the whole sweep', () => {
    const r = resolveShaRepos([A.merge!], [...repos, { name: 'gone', path: join(dir, 'nope') }])
    expect(r.get(A.merge!)!.location).toBe('marveen')
  })
})

describe('gitSweepEdges', () => {
  it('qualifies every file path with its repo', () => {
    // Both repos have a README.md. An unqualified path would fuse them on the one query this layer
    // exists to answer.
    const { edges } = gitSweepEdges([A.base!, B.base!], repos)
    const files = edges.filter((e) => e.relation_type === 'touches-file').map((e) => e.to_id).sort()
    expect(files).toEqual(['cleancore:README.md', 'marveen:README.md'])
    expect(qualifyPath('marveen', 'README.md')).toBe('marveen:README.md')
  })

  it('emits a resolved-in edge for EVERY sha, including the unresolvable ones', () => {
    const { edges, byLocation } = gitSweepEdges([A.merge!, 'deadbee'], repos)
    const marks = edges.filter((e) => e.relation_type === 'resolved-in')
    expect(marks).toEqual([
      { from_type: 'sha', from_id: A.merge!, to_type: 'repo', to_id: 'marveen', relation_type: 'resolved-in' },
      { from_type: 'sha', from_id: 'deadbee', to_type: 'repo', to_id: UNRESOLVED, relation_type: 'resolved-in' },
    ])
    expect(byLocation).toEqual({ marveen: 1, [UNRESOLVED]: 1 })
  })

  it('gives an unresolvable sha a mark but NO file edges', () => {
    const { edges } = gitSweepEdges(['deadbee'], repos)
    expect(edges.filter((e) => e.relation_type === 'touches-file')).toEqual([])
  })

  it('keys the file edges on the sha AS STATED, so the card -> sha -> file join holds', () => {
    const short = A.merge!.slice(0, 8)
    const { edges } = gitSweepEdges([short], repos)
    const files = edges.filter((e) => e.relation_type === 'touches-file')
    expect(files.map((e) => e.from_id)).toEqual([short, short])
    expect(files.every((e) => e.from_id !== A.merge)).toBe(true)
  })

  it('gives two abbreviations of ONE commit their own edges', () => {
    const s7 = A.merge!.slice(0, 7)
    const s10 = A.merge!.slice(0, 10)
    const { edges } = gitSweepEdges([s7, s10], repos)
    const byFrom = new Set(edges.filter((e) => e.relation_type === 'touches-file').map((e) => e.from_id))
    expect(byFrom).toEqual(new Set([s7, s10]))
  })
})

describe('end to end, against the real reconcile', () => {
  beforeEach(() => {
    initDatabase(':memory:')
  })

  const gitRows = (): { from_id: string; to_id: string; relation_type: string }[] =>
    getDb()
      .prepare(
        `SELECT from_id, to_id, relation_type FROM kanban_relations
          WHERE source = ? ORDER BY relation_type, to_id`,
      )
      .all(GIT_SOURCE) as { from_id: string; to_id: string; relation_type: string }[]

  it('takes the shas the marker layer wrote and lands file edges under its own source', () => {
    const short = A.merge!.slice(0, 8)
    createKanbanCard({ id: 'e2e01', title: 'c' })
    addKanbanComment('e2e01', 'backend', `REVIEW\nGate-SHA: ${short}`)
    expect(gateShaTargets()).toEqual([short])

    const { edges } = gitSweepEdges(gateShaTargets(), repos)
    const report = reconcileRelationSource(GIT_SOURCE, edges, { apply: true })
    expect(report.missing).toBe(3) // one resolved-in + two touches-file
    expect(gitRows()).toEqual([
      { from_id: short, to_id: 'marveen', relation_type: 'resolved-in' },
      { from_id: short, to_id: 'marveen:src/a.ts', relation_type: 'touches-file' },
      { from_id: short, to_id: 'marveen:src/b.ts', relation_type: 'touches-file' },
    ])

    // The two-hop join the phase asks for: which cards touched this file?
    const cards = getDb()
      .prepare(
        `SELECT DISTINCT g.from_id AS card FROM kanban_relations f
           JOIN kanban_relations g ON g.to_id = f.from_id AND g.relation_type = 'gate-sha'
          WHERE f.relation_type = 'touches-file' AND f.to_id = ?`,
      )
      .all('marveen:src/a.ts') as { card: string }[]
    expect(cards.map((c) => c.card)).toEqual(['e2e01'])
  })

  it('is idempotent, and does not touch the marker layer', () => {
    createKanbanCard({ id: 'e2e02', title: 'c' })
    addKanbanComment('e2e02', 'backend', `REVIEW\nGate-SHA: ${A.later!.slice(0, 8)}`)
    const markerBefore = (
      getDb().prepare("SELECT COUNT(*) AS n FROM kanban_relations WHERE source = 'marker-v1'").get() as { n: number }
    ).n

    const run = () => reconcileRelationSource(GIT_SOURCE, gitSweepEdges(gateShaTargets(), repos).edges, { apply: true })
    run()
    const second = run()
    expect(second.missing).toBe(0)
    expect(second.stale).toBe(0)
    expect(
      (getDb().prepare("SELECT COUNT(*) AS n FROM kanban_relations WHERE source = 'marker-v1'").get() as { n: number }).n,
    ).toBe(markerBefore)
  })

  it('DELETES file edges whose gate-sha disappeared', () => {
    const short = A.merge!.slice(0, 8)
    createKanbanCard({ id: 'e2e03', title: 'c' })
    addKanbanComment('e2e03', 'backend', `REVIEW\nGate-SHA: ${short}`)
    reconcileRelationSource(GIT_SOURCE, gitSweepEdges(gateShaTargets(), repos).edges, { apply: true })
    expect(gitRows().length).toBe(3)

    // The card's gate-sha edge goes away (comment corrected, card deleted, marker reconcile).
    getDb().prepare("DELETE FROM kanban_relations WHERE relation_type = 'gate-sha'").run()
    const report = reconcileRelationSource(GIT_SOURCE, gitSweepEdges(gateShaTargets(), repos).edges, { apply: true })
    expect(report.stale).toBe(3)
    expect(gitRows()).toEqual([])
  })

  it('a dry run reports the counts and writes nothing', () => {
    createKanbanCard({ id: 'e2e04', title: 'c' })
    addKanbanComment('e2e04', 'backend', `REVIEW\nGate-SHA: ${A.later!.slice(0, 8)}`)
    const report = reconcileRelationSource(GIT_SOURCE, gitSweepEdges(gateShaTargets(), repos).edges)
    expect(report.missing).toBe(2)
    expect(report.applied).toBe(false)
    expect(gitRows()).toEqual([])
  })
})
