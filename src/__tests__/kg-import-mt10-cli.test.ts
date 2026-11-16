// Card 81593084 (MT P2 / MT-10): the four importers existed, were unit-tested and landed, but
// nothing called them against the live databases (kg_nodes had zero decision/finding/
// error_class/lesson/anti_pattern rows -- measured directly against store/knowledge-graph.db).
// Drives the REAL runImportMt10Cli() with every collaborator mocked: no DB, no IO.
import { describe, it, expect, vi } from 'vitest'
import type Database from 'better-sqlite3'
import {
  runImportMt10Cli,
  runImportMt10,
  flagValue,
  ROOT_DECISIONS_PROJECT,
  ROOT_DECISIONS_SOURCE_PATH,
  type ImportMt10CliDeps,
} from '../kg/import-mt10-cli.js'
import type { FindingsImportReport } from '../kg/import-findings.js'
import type { DecisionsImportReport } from '../kg/import-decisions-log.js'
import type { ColdMemoriesImportReport } from '../kg/import-cold-memories.js'
import type { AntiPatternsImportReport } from '../kg/import-anti-patterns.js'

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
}
const decisionsReport: DecisionsImportReport = {
  entriesParsed: 0,
  decisionsUpserted: 0,
  governsEdges: 0,
  cardRefsSkippedMissing: 0,
  entriesRejectedSecret: 0,
  secretRejectedLines: [],
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

  it('flagValue returns undefined when the flag is absent', () => {
    expect(flagValue(['--db', 'x'], '--kg-db')).toBeUndefined()
    expect(flagValue(['--db', 'x'], '--db')).toBe('x')
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
