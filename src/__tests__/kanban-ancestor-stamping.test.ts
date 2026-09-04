// Ancestor updated_at bubbling, and the token-attribution filter that DEPENDS on it (card 4b03a88d).
//
// WHY THIS EXISTS, measured on the live board while the card was taken: phase card 607254fb read as
// 4.7 HOURS stale while one of its children had been touched 1 minute earlier and another 11 minutes
// earlier. Working rule 3 detects a stuck card from updated_at, and the orchestrator acted on exactly
// that reading -- it judged the lane idle while it was mid-task. So this is not a cosmetic upstream
// import: it fixes a signal the fleet's own orchestration consumes.
//
// THE COUPLING IS THE POINT. The `NOT EXISTS (child.parent_id = ...)` filter in correlateWithKanban
// was DELIBERATELY REJECTED on card f27c999b, because without bubbling a parent's updated_at means
// the parent itself was edited and the filter would discard CORRECT attribution. With bubbling the
// parent carries the child's timestamp and the filter becomes right. Either both are present or
// neither is; the last describe block pins that so the pair cannot be split by a later edit.
import { describe, it, expect, beforeEach, vi } from 'vitest'

// The two guards are pinned by the WARNING each emits, not by "it did not throw". Measured: with
// only a not-throws assertion, disabling the cycle check changed nothing -- the DEPTH limit stopped
// the walk instead and the test stayed green. A guard whose removal is invisible is not pinned.
const warnings: string[] = []
vi.mock('../logger.js', () => ({
  logger: {
    warn: (_o: unknown, msg: string) => { warnings.push(msg) },
    info: () => {}, error: () => {}, debug: () => {},
  },
}))
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  initDatabase,
  getDb,
  createKanbanCard,
  updateKanbanCard,
  moveKanbanCard,
  addKanbanComment,
  getKanbanCard,
} from '../db.js'

const stamp = (id: string): number => getKanbanCard(id)!.updated_at
/** Push a card's updated_at into the past so a later bubble is unambiguous. */
const age = (id: string, secondsAgo: number): void => {
  getDb().prepare('UPDATE kanban_cards SET updated_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000) - secondsAgo, id)
}

beforeEach(() => {
  initDatabase(':memory:')
  warnings.length = 0
})

/** Phase -> Task -> subtask, the fleet's own decomposition shape. */
function threeDeep(): void {
  createKanbanCard({ id: 'phase', title: 'Phase', priority: 'normal' })
  createKanbanCard({ id: 'task', title: 'Task', priority: 'normal', parent_id: 'phase' })
  createKanbanCard({ id: 'sub', title: 'Subtask', priority: 'normal', parent_id: 'task' })
  age('phase', 5000)
  age('task', 5000)
}

describe('a write to a child stamps the WHOLE ancestor chain', () => {
  it('THE MEASURED CASE: a comment on a subtask un-stales the phase two levels up', () => {
    // This is 607254fb's shape exactly: activity on a grandchild, a phase that looked 4.7h idle.
    threeDeep()
    const before = stamp('phase')
    addKanbanComment('sub', 'backend2', 'working')
    expect(stamp('phase')).toBeGreaterThan(before)
    expect(stamp('task')).toBeGreaterThan(before)
  })

  it('a status move bubbles too', () => {
    threeDeep()
    const before = stamp('phase')
    moveKanbanCard('sub', 'in_progress', 0, 'backend2')
    expect(stamp('phase')).toBeGreaterThan(before)
  })

  it('creating a child stamps its ancestors', () => {
    threeDeep()
    const before = stamp('phase')
    createKanbanCard({ id: 'step', title: 'Step', priority: 'normal', parent_id: 'sub' })
    expect(stamp('phase')).toBeGreaterThan(before)
  })

  it('a re-parent stamps BOTH the old and the new chain', () => {
    // The old parent just lost a child. That is a change to that subtree even though nothing
    // beneath it was written, and only stamping the new side would leave it looking untouched.
    createKanbanCard({ id: 'oldp', title: 'Old', priority: 'normal' })
    createKanbanCard({ id: 'newp', title: 'New', priority: 'normal' })
    createKanbanCard({ id: 'kid', title: 'Kid', priority: 'normal', parent_id: 'oldp' })
    age('oldp', 5000)
    age('newp', 5000)
    const oldBefore = stamp('oldp')
    const newBefore = stamp('newp')
    updateKanbanCard('kid', { parent_id: 'newp' }, { actor: 'backend2' })
    expect(stamp('newp')).toBeGreaterThan(newBefore)
    expect(stamp('oldp')).toBeGreaterThan(oldBefore)
  })

  it('a root card is not a special case that breaks -- it simply has nothing to stamp', () => {
    createKanbanCard({ id: 'solo', title: 'Solo', priority: 'normal' })
    expect(() => addKanbanComment('solo', 'a', 'x')).not.toThrow()
  })
})

describe('the walk is guarded, because parent_id is editable input', () => {
  it('a parent_id CYCLE stops instead of spinning, and does not fail the write', () => {
    // Reachable through the API, so not a theoretical concern. The write that triggered the stamp
    // must still succeed -- a bad edge is not a reason to lose a comment.
    createKanbanCard({ id: 'a', title: 'A', priority: 'normal' })
    createKanbanCard({ id: 'b', title: 'B', priority: 'normal', parent_id: 'a' })
    getDb().prepare('UPDATE kanban_cards SET parent_id = ? WHERE id = ?').run('b', 'a') // a -> b -> a
    expect(() => addKanbanComment('b', 'x', 'y')).not.toThrow()
    expect(getKanbanCard('b')).toBeDefined()
    // The CYCLE guard specifically -- not the depth limit, which would also stop this walk and would
    // make the cycle check deletable with every test still green.
    expect(warnings.some((m) => m.includes('cycle'))).toBe(true)
    expect(warnings.some((m) => m.includes('too deep'))).toBe(false)
  })

  it('a chain deeper than the limit stops rather than walking forever', () => {
    createKanbanCard({ id: 'n0', title: 'n0', priority: 'normal' })
    for (let i = 1; i <= 25; i++) {
      createKanbanCard({ id: `n${i}`, title: `n${i}`, priority: 'normal', parent_id: `n${i - 1}` })
    }
    age('n0', 5000)
    const before = stamp('n0')
    addKanbanComment('n25', 'x', 'y')
    // 25 levels is past ANCESTOR_DEPTH_LIMIT (16), so the far root is deliberately NOT reached.
    expect(stamp('n0')).toBe(before)
    expect(stamp('n24')).toBeGreaterThan(0)
    // And it is the DEPTH guard that stopped it, not the cycle check: there is no cycle here.
    expect(warnings.some((m) => m.includes('too deep'))).toBe(true)
    expect(warnings.some((m) => m.includes('cycle'))).toBe(false)
  })
})

describe('bubbling and the token-attribution filter are ONE change (card f27c999b coupling)', () => {
  const ROOT = join(__dirname, '..', '..')
  const dbSrc = readFileSync(join(ROOT, 'src', 'db.ts'), 'utf-8')
  const tokenSrc = readFileSync(join(ROOT, 'src', 'web', 'token-usage.ts'), 'utf-8')
  const strip = (s: string) => s.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

  it('if db.ts stamps ancestors, correlateWithKanban MUST skip parents', () => {
    // Splitting the pair is silently wrong in one direction: bubbling without the filter makes a
    // parent tie with its child on updated_at, so which title takes the token rows comes down to row
    // order. Neither half is individually incorrect, which is exactly why a test has to hold them
    // together rather than a comment asking nicely.
    const stamps = strip(dbSrc).includes('function touchAncestorChain(')
    const filters = strip(tokenSrc).includes('NOT EXISTS (SELECT 1 FROM kanban_cards child WHERE child.parent_id = kanban_cards.id)')
    expect(stamps).toBe(true)
    expect(filters).toBe(stamps)
  })

  it('the stamping helper is actually CALLED, not merely defined', () => {
    const code = strip(dbSrc)
    expect(code).toContain('touchAncestorChain(card.parent_id, now, card.id)')
    expect(code).toContain('touchAncestorsOf(')
  })
})
