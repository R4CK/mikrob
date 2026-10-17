// MT-05 (card c991508f): the route-layer glue must be byte-identical-behaviour when
// KG_CAPTURE_ENABLED is off (the MODULTERV's "kapcsolo mogott, alapbol OFF" rule) -- it must not
// even open the kg database file in that case.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let settingValue = '0'
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (key: string) => (key === 'KG_CAPTURE_ENABLED' ? settingValue : '0'),
}))
vi.mock('../logger.js', () => ({ logger: { warn: () => {} } }))

let openCalls = 0
let enqueueCalls: Array<{ cardId: string; reason: string }> = []
vi.mock('../kg/store.js', () => ({
  openKgDb: () => { openCalls += 1; return { close: () => {} } },
  kgDbPath: () => ':memory:',
}))
vi.mock('../kg/capture.js', () => ({
  enqueueCapture: (_db: unknown, cardId: string, reason: string) => { enqueueCalls.push({ cardId, reason }) },
}))

const { onKanbanCardStatusChanged, resetKgDbSingletonForTest } = await import('../web/kg-capture-hook.js')

beforeEach(() => {
  settingValue = '0'
  openCalls = 0
  enqueueCalls = []
  resetKgDbSingletonForTest()
})

describe('onKanbanCardStatusChanged', () => {
  it('is a true no-op when KG_CAPTURE_ENABLED is off -- never opens the kg db', () => {
    settingValue = '0'
    onKanbanCardStatusChanged('c1', 'waiting', 'done')
    expect(openCalls).toBe(0)
    expect(enqueueCalls).toHaveLength(0)
  })

  it('enqueues once enabled, on a real waiting->done transition', () => {
    settingValue = '1'
    onKanbanCardStatusChanged('c1', 'waiting', 'done')
    expect(openCalls).toBe(1)
    expect(enqueueCalls).toEqual([{ cardId: 'c1', reason: 'closed' }])
  })

  it('does not enqueue for a non-done target status', () => {
    settingValue = '1'
    onKanbanCardStatusChanged('c1', 'planned', 'in_progress')
    expect(enqueueCalls).toHaveLength(0)
  })

  it('does not enqueue when the card was already done (a re-save, not a real transition)', () => {
    settingValue = '1'
    onKanbanCardStatusChanged('c1', 'done', 'done')
    expect(enqueueCalls).toHaveLength(0)
  })
})
