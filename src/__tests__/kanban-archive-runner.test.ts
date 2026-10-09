// Card 965b0b2b (upstream adoption): sweepArchivedKanbanCards() was extracted out of
// listKanbanCards() onto this clock-driven runner (see kanban-archive-runner.ts's own header for
// why). The danger that file itself names: if the runner is never STARTED, KANBAN_ARCHIVE_DONE_DAYS
// becomes a silent no-op -- nothing fails, cards simply stop archiving. This test pins the wiring,
// not just the function's own correctness (already covered by kanban-archive-stale-updated-at.test.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sweepMock = vi.fn(() => 0)
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))
vi.mock('../db.js', () => ({ sweepArchivedKanbanCards: sweepMock }))

const { startKanbanArchiveRunner } = await import('../web/kanban-archive-runner.js')

beforeEach(() => {
  vi.useFakeTimers()
  sweepMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startKanbanArchiveRunner', () => {
  it('does not sweep immediately -- the first pass is delayed like its sibling runners', () => {
    const handle = startKanbanArchiveRunner()
    expect(sweepMock).not.toHaveBeenCalled()
    clearInterval(handle)
  })

  it('sweeps once after the initial delay, then again every interval', () => {
    const handle = startKanbanArchiveRunner()
    vi.advanceTimersByTime(70_000)
    expect(sweepMock).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60 * 60_000)
    expect(sweepMock).toHaveBeenCalledTimes(2)
    clearInterval(handle)
  })

  it('a thrown error from the sweep does not take the timer down -- the next tick still fires', () => {
    sweepMock.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const handle = startKanbanArchiveRunner()
    expect(() => vi.advanceTimersByTime(70_000)).not.toThrow()
    vi.advanceTimersByTime(60 * 60_000)
    expect(sweepMock).toHaveBeenCalledTimes(2)
    clearInterval(handle)
  })
})

describe('wiring contracts', () => {
  it('web.ts actually starts the runner -- silence here is the exact no-op this card is about', () => {
    const src = readFileSync(join(__dirname, '../../src/web.ts'), 'utf-8')
    expect(src).toContain('startKanbanArchiveRunner()')
    expect(src).toContain('clearInterval(kanbanArchiveInterval)')
  })
})
