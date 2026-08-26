// offload-batch-run.sh --test-select: the candidate selection/ordering/BLOKKOLT-filter logic (card
// 3e094b1e, alfeladat f8c72a5a). Exercises the exact SELECT_PY the real run uses, fed via stdin, so
// this never touches tmux/curl/kanban.
//
// WHY the ordering changed: a real overnight run measured 69 candidates, CAP=20, ZERO drafts -- the
// cap was entirely consumed by URGENT/HIGH planned cards (typically too complex for the local
// router), before the loop ever reached a genuinely mechanical LOW card. A manual run of the same
// pipeline on a LOW card excluded from that night's top-20 drafted successfully in seconds. So
// planned candidates are now ordered mechanical-first (low priority first); in_progress candidates
// keep their original urgent-first order (active work still gets immediate draft help first).
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store', 'offload-batch-run.sh')

function select(cards: unknown[]): string[] {
  const out = execFileSync('bash', [SCRIPT, '--test-select'], {
    input: JSON.stringify(cards),
    encoding: 'utf-8',
  })
  return out.split('\n').filter(Boolean)
}

const card = (id: string, status: string, priority: string, title = id) => ({ id, status, priority, title })

describe('offload-batch-run.sh --test-select: candidate order', () => {
  it('puts in_progress candidates first, urgent-first within that bucket', () => {
    const ids = select([
      card('ip-low', 'in_progress', 'low'),
      card('ip-urgent', 'in_progress', 'urgent'),
      card('planned-urgent', 'planned', 'urgent'),
    ])
    expect(ids.slice(0, 2)).toEqual(['ip-urgent', 'ip-low'])
    expect(ids[2]).toBe('planned-urgent')
  })

  it('orders planned candidates mechanical-first (low priority first), not urgent-first', () => {
    const ids = select([
      card('p-urgent', 'planned', 'urgent'),
      card('p-high', 'planned', 'high'),
      card('p-normal', 'planned', 'normal'),
      card('p-low', 'planned', 'low'),
    ])
    expect(ids).toEqual(['p-low', 'p-normal', 'p-high', 'p-urgent'])
  })

  it('excludes BLOKKOLT-* cards regardless of priority', () => {
    const ids = select([
      card('blocked', 'planned', 'low', '[BLOKKOLT-uzleti-dontes-marad] low but parked'),
      card('normal', 'planned', 'low'),
    ])
    expect(ids).toEqual(['normal'])
  })

  it('excludes cards outside in_progress/planned (done, waiting)', () => {
    const ids = select([
      card('done-card', 'done', 'urgent'),
      card('waiting-card', 'waiting', 'urgent'),
      card('planned-card', 'planned', 'low'),
    ])
    expect(ids).toEqual(['planned-card'])
  })

  it('reproduces the measured starvation scenario: a low planned card now sorts before a pile of high/urgent ones', () => {
    const many = Array.from({ length: 25 }, (_, i) => card(`urgent-${i}`, 'planned', 'urgent'))
    const ids = select([...many, card('mechanical-fix', 'planned', 'low')])
    expect(ids[0]).toBe('mechanical-fix')
  })
})
