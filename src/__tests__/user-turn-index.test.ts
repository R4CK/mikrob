// Incremental user-turn index (card ba0d218f). The endpoint was ~12s because it re-read ~2 GB of
// transcripts per request; these tests pin the two properties that make the replacement correct:
// it counts the SAME turns as the full scan, and it only reads what was appended.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  countTurnsByDay,
  isRealUserTurn,
  refreshUserTurnIndex,
  turnsOnDay,
} from '../web/user-turn-index.js'

let root: string
let statePath: string

const DAY = '2026-07-31'
const at = (h: number, m = 0) => new Date(`${DAY}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`).toISOString()

const userLine = (ts: string, content: unknown = 'szia') =>
  JSON.stringify({ type: 'user', timestamp: ts, message: { content } }) + '\n'

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'turn-index-'))
  root = join(base, 'projects')
  statePath = join(base, 'state.json')
  mkdirSync(join(root, 'proj-a'), { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const refresh = () => refreshUserTurnIndex({ root, statePath })
const dayMs = new Date(`${DAY}T09:00:00`).getTime()

describe('isRealUserTurn', () => {
  it('counts an operator prompt', () => {
    expect(isRealUserTurn({ type: 'user', message: { content: 'csinald meg' } })).toBe(true)
  })

  it('does NOT count tool results, slash-command echoes or meta events', () => {
    expect(isRealUserTurn({ type: 'user', message: { content: [{ type: 'tool_result' }] } })).toBe(false)
    expect(isRealUserTurn({ type: 'user', message: { content: '<local-command-stdout>x' } })).toBe(false)
    expect(isRealUserTurn({ type: 'user', message: { content: '<command-name>/foo' } })).toBe(false)
    expect(isRealUserTurn({ type: 'user', isMeta: true, message: { content: 'x' } })).toBe(false)
    expect(isRealUserTurn({ type: 'assistant', message: { content: 'x' } })).toBe(false)
  })
})

describe('countTurnsByDay', () => {
  it('buckets by LOCAL calendar day and skips unparseable lines', () => {
    const days = countTurnsByDay([userLine(at(9)), 'not json', userLine(at(23, 59))])
    expect(days[DAY]).toBe(2)
  })
})

describe('refreshUserTurnIndex', () => {
  it('counts turns across files', () => {
    writeFileSync(join(root, 'proj-a', 's1.jsonl'), userLine(at(9)) + userLine(at(10)))
    const { days } = refresh()
    expect(turnsOnDay(days, dayMs)).toBe(2)
  })

  it('reads NOTHING on a second pass when nothing changed (the whole point)', () => {
    writeFileSync(join(root, 'proj-a', 's1.jsonl'), userLine(at(9)))
    refresh()
    const second = refresh()
    expect(second.stats.filesRead).toBe(0)
    expect(second.stats.bytesRead).toBe(0)
    expect(turnsOnDay(second.days, dayMs)).toBe(1) // still the right answer
  })

  it('reads ONLY the appended bytes when a file grows', () => {
    const f = join(root, 'proj-a', 's1.jsonl')
    const first = userLine(at(9))
    writeFileSync(f, first)
    refresh()
    const added = userLine(at(11))
    appendFileSync(f, added)
    const second = refresh()
    expect(second.stats.bytesRead).toBe(added.length) // not the whole file
    expect(turnsOnDay(second.days, dayMs)).toBe(2)
  })

  it('does not double-count across refreshes', () => {
    const f = join(root, 'proj-a', 's1.jsonl')
    writeFileSync(f, userLine(at(9)))
    refresh()
    appendFileSync(f, userLine(at(10)))
    refresh()
    appendFileSync(f, userLine(at(11)))
    expect(turnsOnDay(refresh().days, dayMs)).toBe(3)
  })

  it('leaves a PARTIAL trailing line for the next pass (an agent mid-write)', () => {
    const f = join(root, 'proj-a', 's1.jsonl')
    writeFileSync(f, userLine(at(9)) + '{"type":"user","timestamp":"' + at(10))
    expect(turnsOnDay(refresh().days, dayMs)).toBe(1) // the half line is not counted yet
    appendFileSync(f, '","message":{"content":"kesz"}}\n')
    expect(turnsOnDay(refresh().days, dayMs)).toBe(2) // and it IS once complete
  })

  it('RECOUNTS a truncated/rewritten file instead of trusting stale tallies', () => {
    const f = join(root, 'proj-a', 's1.jsonl')
    writeFileSync(f, userLine(at(9)) + userLine(at(10)) + userLine(at(11)))
    expect(turnsOnDay(refresh().days, dayMs)).toBe(3)
    writeFileSync(f, userLine(at(12))) // rotated: smaller file, different content
    expect(turnsOnDay(refresh().days, dayMs)).toBe(1)
  })

  it('a CORRUPT index costs one rescan, never a wrong answer', () => {
    writeFileSync(join(root, 'proj-a', 's1.jsonl'), userLine(at(9)) + userLine(at(10)))
    refresh()
    writeFileSync(statePath, 'not json')
    const after = refresh()
    expect(turnsOnDay(after.days, dayMs)).toBe(2)
    expect(after.stats.filesRead).toBe(1) // it did re-read, deliberately
  })

  it('separates days, so "today" and "yesterday" come from one pass', () => {
    writeFileSync(
      join(root, 'proj-a', 's1.jsonl'),
      userLine(at(9)) + JSON.stringify({ type: 'user', timestamp: '2026-07-30T09:00:00', message: { content: 'tegnap' } }) + '\n',
    )
    const { days } = refresh()
    expect(turnsOnDay(days, dayMs)).toBe(1)
    expect(turnsOnDay(days, new Date('2026-07-30T09:00:00').getTime())).toBe(1)
  })

  it('persists the index so a restart does not re-read everything', () => {
    writeFileSync(join(root, 'proj-a', 's1.jsonl'), userLine(at(9)))
    refresh()
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as { files: Record<string, unknown> }
    expect(Object.keys(state.files)).toHaveLength(1)
  })

  it('an absent transcript root is not an error (a fresh install has none)', () => {
    const { days } = refreshUserTurnIndex({ root: join(root, 'nope'), statePath })
    expect(days).toEqual({})
  })
})
