// Card 4bade960: the dedup pre-filter must run on every new card, structurally, and must never
// block or corrupt card creation when the check itself misbehaves (bad JSON, non-zero exit,
// timeout). These tests hold the guard to exactly that contract: append a note on a real match,
// change nothing on no-match or on any failure of the underlying script.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let stdout = ''
let shouldError: Error | null = null
export let spawns: string[][] = []
vi.mock('node:child_process', () => ({
  execFile: (
    _cmd: string,
    args: readonly string[],
    _opts: unknown,
    cb: (e: Error | null, out: string) => void,
  ) => {
    spawns.push([...args])
    queueMicrotask(() => cb(shouldError, stdout))
  },
}))

let warnLogs: Array<Record<string, unknown>> = []
vi.mock('../logger.js', () => ({
  logger: { warn: (o: Record<string, unknown>) => warnLogs.push(o), info: () => {} },
}))

const { dedupPrefilterDescriptionUpdate } = await import('../web/kanban-dedup-prefilter-guard.js')

beforeEach(() => {
  stdout = ''
  shouldError = null
  spawns = []
  warnLogs = []
})

describe('dedupPrefilterDescriptionUpdate', () => {
  it('appends a note on a shared-reference match, keeping the original description', async () => {
    stdout = JSON.stringify({
      cardId: 'new1',
      match: { doneCardId: 'old1', doneTitle: 'Old card title', reason: 'shared-reference', sharedRefs: ['34c4840e'] },
    })
    const result = await dedupPrefilterDescriptionUpdate('new1', 'Eredeti leírás.')
    expect(result).toContain('Eredeti leírás.')
    expect(result).toContain('[DEDUP-PREFILTER]')
    expect(result).toContain('old1')
    expect(result).toContain('34c4840e')
    // Calls the SAME script the >2-day dispatch filter uses -- one calibrated implementation.
    expect(spawns[0]!.some((a) => a.includes('dedup-prefilter-check.sh'))).toBe(true)
    expect(spawns[0]).toContain('new1')
  })

  it('returns null (no description change) when the script reports no match', async () => {
    stdout = JSON.stringify({ cardId: 'new1', match: null })
    const result = await dedupPrefilterDescriptionUpdate('new1', 'Eredeti leírás.')
    expect(result).toBeNull()
  })

  it('fails open on a non-zero exit / spawn error -- never blocks or corrupts creation', async () => {
    shouldError = new Error('spawn failed')
    const result = await dedupPrefilterDescriptionUpdate('new1', 'Eredeti leírás.')
    expect(result).toBeNull()
    expect(warnLogs.length).toBe(1)
  })

  it('fails open on malformed JSON output', async () => {
    stdout = 'not json'
    const result = await dedupPrefilterDescriptionUpdate('new1', 'Eredeti leírás.')
    expect(result).toBeNull()
    expect(warnLogs.length).toBe(1)
  })
})
