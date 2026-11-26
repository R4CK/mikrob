// Card 5ecf6133: drives the REAL runAnchorPathBackfillCli with a real in-memory kg DB (migrate())
// and mocked file IO/filesForSha -- no real git call, no real file written.
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migrate, upsertNode, upsertAnchor, type KgAnchorRow } from '../kg/store.js'
import { runAnchorPathBackfillCli, type AnchorBackfillCliDeps } from '../kg/anchor-path-backfill-cli.js'
import type { AnchorBackfillBackup } from '../kg/anchor-path-backfill.js'

function freshKgDb(): Database.Database {
  const db = new Database(':memory:')
  migrate(db)
  return db
}

function seedSolutionWithPlaceholder(db: Database.Database, nodeId: string, sha: string, reviewId: number): void {
  upsertNode(db, {
    id: nodeId,
    type: 'solution',
    project: 'mikrob',
    title: 'a fix',
    source_ref: `kanban_comments:${reviewId}`,
    gate_sha: sha,
    extractor: 'local-llm:kg-capture@v1',
  })
  upsertAnchor(db, { node_id: nodeId, repo: 'marveen', path: `kanban_comments:${reviewId}`, sha, state: 'fresh' })
}

function makeDeps(kgDb: Database.Database, overrides: Partial<AnchorBackfillCliDeps> = {}): {
  deps: AnchorBackfillCliDeps
  logs: string[]
  warns: string[]
  files: Map<string, string>
} {
  const logs: string[] = []
  const warns: string[] = []
  const files = new Map<string, string>()
  const deps: AnchorBackfillCliDeps = {
    openKgDb: () => kgDb,
    kgDbPath: () => ':memory:',
    filesForSha: () => ['src/a.ts'],
    readFile: (path) => files.get(path) ?? (() => { throw new Error(`no fixture for ${path}`) })(),
    writeFile: (path, content) => files.set(path, content),
    now: () => 1000,
    log: (msg) => logs.push(msg),
    warn: (msg) => warns.push(msg),
    ...overrides,
  }
  return { deps, logs, warns, files }
}

describe('runAnchorPathBackfillCli', () => {
  it('--dry-run plans and logs counts but writes nothing', () => {
    const kgDb = freshKgDb()
    seedSolutionWithPlaceholder(kgDb, 'sol:a:0', '1111111', 1)
    const { deps, logs, files } = makeDeps(kgDb)
    runAnchorPathBackfillCli(['--dry-run'], deps)
    expect(logs.some((l) => l.includes('resolvable') && l.includes('1'))).toBe(true)
    expect(files.size).toBe(0)
    const anchors = kgDb.prepare('SELECT * FROM kg_anchors').all() as KgAnchorRow[]
    expect(anchors[0]!.path).toBe('kanban_comments:1') // untouched
  })

  it('refuses a real run with no --backup', () => {
    const kgDb = freshKgDb()
    seedSolutionWithPlaceholder(kgDb, 'sol:a:0', '1111111', 1)
    const { deps, warns, files } = makeDeps(kgDb)
    runAnchorPathBackfillCli([], deps)
    expect(warns.some((w) => w.includes('REFUSED'))).toBe(true)
    expect(files.size).toBe(0)
    const anchors = kgDb.prepare('SELECT * FROM kg_anchors').all() as KgAnchorRow[]
    expect(anchors[0]!.path).toBe('kanban_comments:1') // untouched
  })

  it('--backup applies the fix and writes a restorable backup file', () => {
    const kgDb = freshKgDb()
    seedSolutionWithPlaceholder(kgDb, 'sol:a:0', '1111111', 1)
    const { deps, logs, files } = makeDeps(kgDb)
    runAnchorPathBackfillCli(['--backup', '/tmp/x.json'], deps)
    expect(logs.some((l) => l.includes('backfilled:  1') || l.includes('backfilled: 1'))).toBe(true)
    const anchorsAfter = kgDb.prepare('SELECT * FROM kg_anchors').all() as KgAnchorRow[]
    expect(anchorsAfter).toHaveLength(1)
    expect(anchorsAfter[0]!.path).toBe('src/a.ts')

    const backup = JSON.parse(files.get('/tmp/x.json')!) as AnchorBackfillBackup
    expect(backup.createdIds).toHaveLength(1)
    expect(backup.originals).toHaveLength(1)
    expect(backup.originals[0]!.path).toBe('kanban_comments:1')
  })

  it('--restore reverses a previous --backup run exactly', () => {
    const kgDb = freshKgDb()
    seedSolutionWithPlaceholder(kgDb, 'sol:a:0', '1111111', 1)
    const before = kgDb.prepare('SELECT * FROM kg_anchors').get() as KgAnchorRow
    const { deps, files } = makeDeps(kgDb)
    runAnchorPathBackfillCli(['--backup', '/tmp/x.json'], deps)

    const { deps: restoreDeps } = makeDeps(kgDb, { readFile: (path) => files.get(path)! })
    runAnchorPathBackfillCli(['--restore', '/tmp/x.json'], restoreDeps)

    const after = kgDb.prepare('SELECT * FROM kg_anchors').all() as KgAnchorRow[]
    expect(after).toHaveLength(1)
    expect(after[0]).toEqual(before)
  })
})
