// Card 5ecf6133: drives the REAL runAnchorPathBackfillCli with a real in-memory kg DB (migrate())
// and mocked file IO/filesForSha -- no real git call, no real file written.
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, upsertNode, upsertAnchor, type KgAnchorRow } from '../kg/store.js'
import { runAnchorPathBackfillCli, atomicWriteFile, type AnchorBackfillCliDeps } from '../kg/anchor-path-backfill-cli.js'
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
    backupExists: (path) => files.has(path),
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

  // CYBERSEC F-5: a re-run (or a re-run after a crash) pointed at a --backup path that ALREADY
  // has a file must be refused outright, never silently overwritten -- otherwise a prior, real
  // backup (e.g. 214 originals) can be replaced by this run's own empty pre-mutation write, and
  // a later --restore would exit 0 "RESTORED: 0" while the real backup is already gone.
  it('refuses a real run whose --backup path already exists, without touching the graph', () => {
    const kgDb = freshKgDb()
    seedSolutionWithPlaceholder(kgDb, 'sol:a:0', '1111111', 1)
    const { deps, warns, files } = makeDeps(kgDb)
    files.set('/tmp/x.json', 'stale-backup-from-a-prior-run')
    runAnchorPathBackfillCli(['--backup', '/tmp/x.json'], deps)
    expect(warns.some((w) => w.includes('REFUSED') && w.includes('already exists'))).toBe(true)
    expect(files.get('/tmp/x.json')).toBe('stale-backup-from-a-prior-run') // untouched, not overwritten
    const anchors = kgDb.prepare('SELECT * FROM kg_anchors').all() as KgAnchorRow[]
    expect(anchors[0]!.path).toBe('kanban_comments:1') // untouched
  })

  // CYBERSEC F-4a / CYBERED H-A: the final file on disk after a clean run must carry a non-null
  // appliedAt (the real commit timestamp), not the pre-mutation placeholder value.
  it('the final backup file on disk has a non-null appliedAt', () => {
    const kgDb = freshKgDb()
    seedSolutionWithPlaceholder(kgDb, 'sol:a:0', '1111111', 1)
    const { deps, files } = makeDeps(kgDb)
    runAnchorPathBackfillCli(['--backup', '/tmp/x.json'], deps)
    const backup = JSON.parse(files.get('/tmp/x.json')!) as AnchorBackfillBackup
    expect(backup.appliedAt).toBe(1000)
  })

  // Simulates the exact crash window CYBERED's H-A names: the process dies right after the
  // pre-mutation write and never reaches the post-commit overwrite. --restore must refuse that
  // file, not report a clean success while leaving the created rows behind.
  it('--restore refuses the pre-mutation snapshot left behind by a crash before the post-commit write', () => {
    const kgDb = freshKgDb()
    seedSolutionWithPlaceholder(kgDb, 'sol:a:0', '1111111', 1)
    let writeCount = 0
    const files = new Map<string, string>()
    const { deps } = makeDeps(kgDb, {
      writeFile: (path, content) => {
        writeCount++
        if (writeCount === 1) files.set(path, content) // only the pre-mutation write lands
        // the second (post-commit) write is dropped, simulating the crash
      },
    })
    runAnchorPathBackfillCli(['--backup', '/tmp/x.json'], deps)
    expect(writeCount).toBe(2) // the code DID try both writes; only the first one "landed"

    const { deps: restoreDeps } = makeDeps(kgDb, { readFile: (path) => files.get(path)! })
    expect(() => runAnchorPathBackfillCli(['--restore', '/tmp/x.json'], restoreDeps)).toThrow(/appliedAt=null/)
  })
})

describe('atomicWriteFile (real filesystem)', () => {
  it('writes via a temp file + rename -- target has full content, no leftover temp file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-backfill-atomic-'))
    try {
      const target = join(dir, 'backup.json')
      atomicWriteFile(target, JSON.stringify({ hello: 'world' }))
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ hello: 'world' })
      expect(readdirSync(dir)).toEqual(['backup.json']) // no .tmp-* leftover
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a second write fully replaces the first, never leaving a truncated mix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-backfill-atomic-'))
    try {
      const target = join(dir, 'backup.json')
      atomicWriteFile(target, JSON.stringify({ appliedAt: null }))
      atomicWriteFile(target, JSON.stringify({ appliedAt: 12345 }))
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ appliedAt: 12345 })
      expect(readdirSync(dir)).toEqual(['backup.json'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
