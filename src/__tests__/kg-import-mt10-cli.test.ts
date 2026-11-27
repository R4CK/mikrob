// Card 81593084 (MT P2 / MT-10): the four importers existed, were unit-tested and landed, but
// nothing called them against the live databases (kg_nodes had zero decision/finding/
// error_class/lesson/anti_pattern rows -- measured directly against store/knowledge-graph.db).
// Drives the REAL runImportMt10Cli() with every collaborator mocked: no DB, no IO.
import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  runImportMt10Cli,
  runImportMt10,
  flagValue,
  ROOT_DECISIONS_SOURCE_PATH,
  type ImportMt10CliDeps,
} from '../kg/import-mt10-cli.js'
import { migrate as migrateKg } from '../kg/store.js'
import { importFindings, type FindingsImportReport } from '../kg/import-findings.js'
import { importDecisionsLog, type DecisionsImportReport } from '../kg/import-decisions-log.js'
import { importColdMemories, type ColdMemoriesImportReport } from '../kg/import-cold-memories.js'
import { importAntiPatterns, type AntiPatternsImportReport } from '../kg/import-anti-patterns.js'

function fakeDb(): Database.Database {
  return {} as Database.Database
}

const findingsReport: FindingsImportReport = {
  verdictsSeen: 0,
  verdictsSkippedMissing: 0,
  verdictsSkippedSecret: 0,
  findingsUpserted: 0,
  foundOnEdges: 0,
  classEdges: 0,
  classifiedCount: 0,
  unclassifiedCount: 0,
  cardTitleSkippedSecret: 0,
  findingSkippedSecret: 0,
  errorClassSkippedSecret: 0,
}
const decisionsReport: DecisionsImportReport = {
  entriesParsed: 0,
  decisionsUpserted: 0,
  governsEdges: 0,
  cardRefsSkippedMissing: 0,
  entriesRejectedSecret: 0,
  secretRejectedLines: [],
  cardRefsSkippedSecret: 0,
}
const coldMemoriesReport: ColdMemoriesImportReport = {
  memoriesScanned: 0,
  lessonsUpserted: 0,
  aboutEdges: 0,
  rowsRejectedSecret: 0,
  secretRejectedSources: [],
}
const antiPatternsReport: AntiPatternsImportReport = {
  commentsScanned: 0,
  commentAntiPatternsUpserted: 0,
  decisionsScanned: 0,
  decisionAntiPatternsUpserted: 0,
  rejectedForEdges: 0,
  cardRefsSkippedMissing: 0,
  commentsSkippedAuthor: 0,
  rowsRejectedSecret: 0,
  secretRejectedSources: [],
}

function makeDeps(overrides: Partial<ImportMt10CliDeps> = {}): { deps: ImportMt10CliDeps; logs: string[] } {
  const logs: string[] = []
  const deps: ImportMt10CliDeps = {
    captureEnabled: () => true,
    initDatabase: vi.fn(),
    getDb: vi.fn(() => fakeDb()),
    openKgDb: vi.fn(() => fakeDb()),
    kgDbPath: () => '/fake/kg.db',
    readDecisionsMd: vi.fn(() => '## fixture\n\nbody\n'),
    importFindings: vi.fn(() => findingsReport),
    importDecisionsLog: vi.fn(() => decisionsReport),
    importColdMemories: vi.fn(() => coldMemoriesReport),
    importAntiPatterns: vi.fn(() => antiPatternsReport),
    log: (msg) => logs.push(msg),
    ...overrides,
  }
  return { deps, logs }
}

describe('runImportMt10Cli', () => {
  it('--help prints the help text and touches nothing', () => {
    const { deps, logs } = makeDeps()
    runImportMt10Cli(['--help'], deps)
    expect(logs.some((l) => l.includes('kg-import-mt10 --'))).toBe(true)
    expect(deps.initDatabase).not.toHaveBeenCalled()
  })

  it('KG_CAPTURE_ENABLED off -> SKIPPED, no database opened, no importer run', () => {
    const { deps, logs } = makeDeps({ captureEnabled: () => false })
    runImportMt10Cli([], deps)
    expect(logs).toEqual(['SKIPPED -- KG_CAPTURE_ENABLED off. Nothing read or written.'])
    expect(deps.initDatabase).not.toHaveBeenCalled()
    expect(deps.getDb).not.toHaveBeenCalled()
    expect(deps.openKgDb).not.toHaveBeenCalled()
    expect(deps.importFindings).not.toHaveBeenCalled()
  })

  it('MUTATION-PIN-SHAPE: a normal run calls all four importers exactly once, in order, with the root project/source path', () => {
    const { deps } = makeDeps()
    runImportMt10Cli([], deps)
    expect(deps.importFindings).toHaveBeenCalledTimes(1)
    expect(deps.importDecisionsLog).toHaveBeenCalledTimes(1)
    expect(deps.importColdMemories).toHaveBeenCalledTimes(1)
    expect(deps.importAntiPatterns).toHaveBeenCalledTimes(1)
    const decisionsArgs = (deps.importDecisionsLog as any).mock.calls[0]
    expect(decisionsArgs[3]).toBe('mikrob') // mapProjectToPartition(ROOT_DECISIONS_PROJECT)
    expect(decisionsArgs[4]).toBe(ROOT_DECISIONS_SOURCE_PATH)
    const antiArgs = (deps.importAntiPatterns as any).mock.calls[0]
    expect(antiArgs[3]).toBe('mikrob')
    expect(antiArgs[4]).toBe(ROOT_DECISIONS_SOURCE_PATH)
  })

  it('--db/--kg-db/--decisions-md flags are passed through to the respective openers', () => {
    const { deps } = makeDeps()
    runImportMt10Cli(['--db', '/tmp/a.db', '--kg-db', '/tmp/b.db', '--decisions-md', '/tmp/D.md'], deps)
    expect(deps.initDatabase).toHaveBeenCalledWith('/tmp/a.db')
    expect(deps.openKgDb).toHaveBeenCalledWith('/tmp/b.db')
    expect(deps.readDecisionsMd).toHaveBeenCalledWith('/tmp/D.md')
  })

  it('logs a one-line summary per importer', () => {
    const { deps, logs } = makeDeps({
      importFindings: vi.fn(() => ({ ...findingsReport, verdictsSeen: 5, findingsUpserted: 5, classEdges: 5, unclassifiedCount: 2 })),
      importDecisionsLog: vi.fn(() => ({ ...decisionsReport, entriesParsed: 10, decisionsUpserted: 10, governsEdges: 3 })),
      importColdMemories: vi.fn(() => ({ ...coldMemoriesReport, memoriesScanned: 7, lessonsUpserted: 7, aboutEdges: 1 })),
      importAntiPatterns: vi.fn(() => ({ ...antiPatternsReport, commentsScanned: 2, decisionsScanned: 10, commentAntiPatternsUpserted: 1, decisionAntiPatternsUpserted: 1, rejectedForEdges: 2 })),
    })
    runImportMt10Cli([], deps)
    expect(logs.find((l) => l.startsWith('findings:'))).toContain('upserted=5')
    expect(logs.find((l) => l.startsWith('decisions:'))).toContain('upserted=10')
    expect(logs.find((l) => l.startsWith('coldMemories:'))).toContain('upserted=7')
    expect(logs.find((l) => l.startsWith('antiPatterns:'))).toContain('upserted=2')
  })

  it('F-3 (CYBERSEC NO-GO 39527): the summary prints the F4/F-2 secret-skip counters, not just entriesRejectedSecret', () => {
    const { deps, logs } = makeDeps({
      importFindings: vi.fn(() => ({
        ...findingsReport, verdictsSkippedSecret: 2, cardTitleSkippedSecret: 3, findingSkippedSecret: 4, errorClassSkippedSecret: 5,
      })),
      importDecisionsLog: vi.fn(() => ({ ...decisionsReport, entriesRejectedSecret: 11, cardRefsSkippedSecret: 12 })),
    })
    runImportMt10Cli([], deps)
    const findingsLine = logs.find((l) => l.startsWith('findings:'))
    const decisionsLine = logs.find((l) => l.startsWith('decisions:'))
    expect(findingsLine).toContain('secretSkipped=2')
    expect(findingsLine).toContain('cardTitleSkipped=3')
    expect(findingsLine).toContain('findingSkipped=4')
    expect(findingsLine).toContain('errorClassSkipped=5')
    expect(decisionsLine).toContain('secretSkipped=11')
    expect(decisionsLine).toContain('cardRefSkipped=12')
  })

  it('flagValue returns undefined when the flag is absent', () => {
    expect(flagValue(['--db', 'x'], '--kg-db')).toBeUndefined()
    expect(flagValue(['--db', 'x'], '--db')).toBe('x')
  })

  // LOW-2 (card 81593084 CYBERSEC GO comment 32549): `--kg-db --help` used to read '--help' as
  // --kg-db's value (a file literally named `--help` would have been opened).
  it('LOW-2: flagValue does not consume a following flag as the value', () => {
    expect(flagValue(['--kg-db', '--help'], '--kg-db')).toBeUndefined()
    expect(flagValue(['--kg-db'], '--kg-db')).toBeUndefined()
  })

  // MEDIUM-1 (card 81593084 CYBERSEC GO comment 32549): cold-memories' about-edges target
  // `card:<id>` nodes that only antiPatterns creates among these four importers -- running
  // coldMemories before antiPatterns silently dropped those edges on the first run.
  it('MEDIUM-1: antiPatterns runs before coldMemories', () => {
    const { deps } = makeDeps()
    runImportMt10Cli([], deps)
    const antiOrder: number = (deps.importAntiPatterns as any).mock.invocationCallOrder[0]
    const coldOrder: number = (deps.importColdMemories as any).mock.invocationCallOrder[0]
    expect(antiOrder).toBeLessThan(coldOrder)
  })
})

describe('runImportMt10 (pure combination, no CLI/switch plumbing)', () => {
  it('passes the same decisionsMarkdown to both the decisions and anti-patterns importers', () => {
    const deps = {
      importFindings: vi.fn(() => findingsReport),
      importDecisionsLog: vi.fn(() => decisionsReport),
      importColdMemories: vi.fn(() => coldMemoriesReport),
      importAntiPatterns: vi.fn(() => antiPatternsReport),
    }
    const report = runImportMt10(fakeDb(), fakeDb(), '## x\nbody', 'mikrob', 'DECISIONS.md', deps)
    expect(deps.importDecisionsLog).toHaveBeenCalledWith('## x\nbody', expect.anything(), expect.anything(), 'mikrob', 'DECISIONS.md')
    expect(deps.importAntiPatterns).toHaveBeenCalledWith(expect.anything(), expect.anything(), '## x\nbody', 'mikrob', 'DECISIONS.md')
    expect(report).toEqual({
      findings: findingsReport,
      decisions: decisionsReport,
      coldMemories: coldMemoriesReport,
      antiPatterns: antiPatternsReport,
    })
  })
})

// EK (card 4e9ad774, "Kész, ha" #1): real importers, real in-memory DBs, no mocks. Reproduces
// the exact MEDIUM-1 shape (card 81593084 comment 32549): a card whose only route into the graph
// is the anti-patterns importer (a Draft-Review: ELUTASITVA comment), referenced by an 8-hex-char
// cold memory, so the about-edge exists only if antiPatterns ran first.
function makeMt10MainDbFixture(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT);
    CREATE TABLE kanban_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, author TEXT NOT NULL,
      content TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE kanban_verdicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT, gate TEXT, verdict TEXT, sha TEXT,
      findings_ref TEXT, created_at INTEGER
    );
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, category TEXT NOT NULL,
      content TEXT NOT NULL, keywords TEXT, created_at INTEGER NOT NULL
    );
  `)
  db.prepare(`INSERT INTO kanban_cards VALUES ('cafe1234', 'Card under test', 'MikroB')`).run()
  db.prepare(
    `INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES
       ('cafe1234', 'backend2', 'Draft-Review: ELUTASITVA\n\nIndok: nem ezt kerte a kartya.', 1000)`,
  ).run()
  db.prepare(
    `INSERT INTO memories (agent_id, category, content, keywords, created_at) VALUES
       ('qa', 'cold', 'A cafe1234 kartyan a regresszio az async refaktorbol jott.', null, 1000)`,
  ).run()
  return db
}

describe('runImportMt10 (real importers, real in-memory DBs -- rerun idempotency, MEDIUM-1)', () => {
  it('two consecutive imports on a fresh graph DB give identical node and edge counts', () => {
    const mainDb = makeMt10MainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)
    const deps = { importFindings, importDecisionsLog, importColdMemories, importAntiPatterns }

    const report1 = runImportMt10(mainDb, kgDb, '# Döntésnapló\n', 'mikrob', 'DECISIONS.md', deps)
    const nodesAfterRun1 = (kgDb.prepare('SELECT count(*) as c FROM kg_nodes').get() as { c: number }).c
    const edgesAfterRun1 = (kgDb.prepare('SELECT count(*) as c FROM kg_edges').get() as { c: number }).c

    const report2 = runImportMt10(mainDb, kgDb, '# Döntésnapló\n', 'mikrob', 'DECISIONS.md', deps)
    const nodesAfterRun2 = (kgDb.prepare('SELECT count(*) as c FROM kg_nodes').get() as { c: number }).c
    const edgesAfterRun2 = (kgDb.prepare('SELECT count(*) as c FROM kg_edges').get() as { c: number }).c

    expect(nodesAfterRun2).toBe(nodesAfterRun1)
    expect(edgesAfterRun2).toBe(edgesAfterRun1)
    // Specifically: the about-edge from the cold-memory lesson to card:cafe1234 is created
    // ALREADY on run 1 (antiPatterns ran first, so card:cafe1234 existed in time) -- the
    // MEDIUM-1 bug meant run 1 reported 0 here and the edge only appeared from run 2 on.
    expect(report1.coldMemories.aboutEdges).toBe(1)
    expect(report2.coldMemories.aboutEdges).toBe(0)
  })
})
