import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  migrate, upsertNode, upsertAnchor, getAnchorsForPath, setNodeStatus, getNode,
} from '../kg/store.js'
import { checkLandingAnchors, sha256Hex, extractAnchorRange, type GitShowFn } from '../kg/anchor-staleness.js'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  migrate(db)
  return db
}

function seedSolution(db: Database.Database, id: string): void {
  upsertNode(db, {
    id, type: 'solution', project: 'marveen', title: 'fix', source_ref: 'kanban_comments:1',
    extractor: 'manual', gate_sha: 'abc1234',
  })
}

describe('extractAnchorRange', () => {
  it('returns the whole file when no line range is given', () => {
    expect(extractAnchorRange('a\nb\nc')).toBe('a\nb\nc')
  })

  it('returns the 1-indexed inclusive line range', () => {
    expect(extractAnchorRange('l1\nl2\nl3\nl4', 2, 3)).toBe('l2\nl3')
  })
})

describe('checkLandingAnchors (MT-09, EK-MT-8)', () => {
  it('an anchor whose range is byte-identical at the new sha stays fresh', () => {
    const db = makeDb()
    seedSolution(db, 'sol:1')
    const body = 'function f() {\n  return 1\n}'
    upsertAnchor(db, {
      node_id: 'sol:1', repo: 'marveen', path: 'src/f.ts', line_start: 1, line_end: 3,
      sha: 'a1a1234', content_hash: sha256Hex(body),
    })
    const gitShow: GitShowFn = () => body
    const report = checkLandingAnchors(db, {
      repo: 'marveen', changedPaths: ['src/f.ts'], sha: 'b2b5678', gitShow, actor: 'test',
    })
    expect(report).toEqual({ checked: 1, unchanged: 1, drifted: 0, gone: 0, nodesMarkedStale: 0 })
    const [anchor] = getAnchorsForPath(db, 'marveen', 'src/f.ts')
    expect(anchor.state).toBe('fresh')
    expect(getNode(db, 'sol:1')?.status).toBe('active')
  })

  it('a landing that changes the anchored body marks it drifted and the node stale', () => {
    const db = makeDb()
    seedSolution(db, 'sol:1')
    const oldBody = 'function f() {\n  return 1\n}'
    const newBody = 'function f() {\n  return 2\n}'
    upsertAnchor(db, {
      node_id: 'sol:1', repo: 'marveen', path: 'src/f.ts', line_start: 1, line_end: 3,
      sha: 'a1a1234', content_hash: sha256Hex(oldBody),
    })
    const gitShow: GitShowFn = () => newBody
    const report = checkLandingAnchors(db, {
      repo: 'marveen', changedPaths: ['src/f.ts'], sha: 'b2b5678', gitShow, actor: 'test',
    })
    expect(report).toEqual({ checked: 1, unchanged: 0, drifted: 1, gone: 0, nodesMarkedStale: 1 })
    const [anchor] = getAnchorsForPath(db, 'marveen', 'src/f.ts')
    expect(anchor.state).toBe('drifted')
    expect(anchor.content_hash).toBe(sha256Hex(newBody))
    expect(getNode(db, 'sol:1')?.status).toBe('stale')
  })

  it('a landing that deletes the anchored file marks the anchor gone and the node stale', () => {
    const db = makeDb()
    seedSolution(db, 'sol:1')
    upsertAnchor(db, {
      node_id: 'sol:1', repo: 'marveen', path: 'src/f.ts', sha: 'a1a1234',
      content_hash: sha256Hex('whatever'),
    })
    const gitShow: GitShowFn = () => null
    const report = checkLandingAnchors(db, {
      repo: 'marveen', changedPaths: ['src/f.ts'], sha: 'b2b5678', gitShow, actor: 'test',
    })
    expect(report).toEqual({ checked: 1, unchanged: 0, drifted: 0, gone: 1, nodesMarkedStale: 1 })
    const [anchor] = getAnchorsForPath(db, 'marveen', 'src/f.ts')
    expect(anchor.state).toBe('gone')
    expect(getNode(db, 'sol:1')?.status).toBe('stale')
  })

  it('an anchor with no stored hash yet establishes a baseline instead of claiming drift', () => {
    const db = makeDb()
    seedSolution(db, 'sol:1')
    upsertAnchor(db, { node_id: 'sol:1', repo: 'marveen', path: 'src/f.ts', sha: 'a1a1234' })
    const gitShow: GitShowFn = () => 'some body'
    const report = checkLandingAnchors(db, {
      repo: 'marveen', changedPaths: ['src/f.ts'], sha: 'b2b5678', gitShow, actor: 'test',
    })
    expect(report.drifted).toBe(0)
    expect(report.unchanged).toBe(1)
    const [anchor] = getAnchorsForPath(db, 'marveen', 'src/f.ts')
    expect(anchor.content_hash).toBe(sha256Hex('some body'))
  })

  it('a drifted anchor on an archived node does not flip the node back out of archived', () => {
    const db = makeDb()
    seedSolution(db, 'sol:1')
    setNodeStatus(db, 'sol:1', 'archived', 'mikrob')
    const oldBody = 'v1'
    const newBody = 'v2'
    upsertAnchor(db, {
      node_id: 'sol:1', repo: 'marveen', path: 'src/f.ts', sha: 'a1a1234',
      content_hash: sha256Hex(oldBody),
    })
    const gitShow: GitShowFn = () => newBody
    const report = checkLandingAnchors(db, {
      repo: 'marveen', changedPaths: ['src/f.ts'], sha: 'b2b5678', gitShow, actor: 'test',
    })
    expect(report.drifted).toBe(1)
    expect(report.nodesMarkedStale).toBe(0)
    expect(getNode(db, 'sol:1')?.status).toBe('archived')
  })

  it('only re-checks anchors on paths the landing actually touched', () => {
    const db = makeDb()
    seedSolution(db, 'sol:1')
    seedSolution(db, 'sol:2')
    upsertAnchor(db, {
      node_id: 'sol:1', repo: 'marveen', path: 'src/touched.ts', sha: 'a1a1234',
      content_hash: sha256Hex('old'),
    })
    upsertAnchor(db, {
      node_id: 'sol:2', repo: 'marveen', path: 'src/untouched.ts', sha: 'a1a1234',
      content_hash: sha256Hex('old'),
    })
    const gitShow: GitShowFn = (_sha, path) => (path === 'src/touched.ts' ? 'new' : 'old')
    const report = checkLandingAnchors(db, {
      repo: 'marveen', changedPaths: ['src/touched.ts'], sha: 'b2b5678', gitShow, actor: 'test',
    })
    expect(report.checked).toBe(1)
    expect(getNode(db, 'sol:2')?.status).toBe('active')
  })

  it('mutation: without the drift comparison (always "fresh"), the drifted-body test above would pass unchanged', () => {
    // Documents the discriminating assertion directly rather than literally reverting source, since
    // the function under test is a handful of lines with one branch that matters here: newState
    // depends on content_hash equality. If that comparison were replaced with a constant 'fresh',
    // this very assertion (state === 'drifted') is exactly what would go red.
    const db = makeDb()
    seedSolution(db, 'sol:1')
    upsertAnchor(db, {
      node_id: 'sol:1', repo: 'marveen', path: 'src/f.ts', sha: 'a1a1234',
      content_hash: sha256Hex('old'),
    })
    const gitShow: GitShowFn = () => 'new'
    checkLandingAnchors(db, { repo: 'marveen', changedPaths: ['src/f.ts'], sha: 'b2b5678', gitShow, actor: 'test' })
    const [anchor] = getAnchorsForPath(db, 'marveen', 'src/f.ts')
    expect(anchor.state).not.toBe('fresh')
    expect(anchor.state).toBe('drifted')
  })
})
