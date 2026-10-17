// Card 44091907 (RedHat GO melleklete, 669b7f92 komment 20820, INFO item 1): the gate-agent
// roster (qa, qa2, cybersec, cybersec2, cybered) is duplicated as a literal list in several
// places that have no shared import path between them -- src/db.ts (TS), kanban-gate-
// completeness-guard.ts (TS, a second un-exported literal) and shared-memory-inject.py
// (Python, no import path into the TS source at all, per its own comment). A roster change
// (new gate sibling, retired agent) that updates some but not all of them would drift silently:
// nothing before this test compared them against each other.
//
// This reads each source file's text and extracts its literal roster via a declaration-anchored
// regex (the needle includes the declaring keyword, not just the bare identifier -- see the
// comment-vs-declaration pitfall already documented for symbol-presence checks elsewhere in this
// codebase), then asserts every roster is the exact same set.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GATE_ROLE_AGENTS } from '../web/kanban-verdicts.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function parseQuotedList(raw: string): string[] {
  return Array.from(raw.matchAll(/'([^']+)'|"([^"]+)"/g))
    .map((m) => m[1] ?? m[2] ?? '')
    .filter(Boolean)
}

function sortedUnique(names: string[]): string[] {
  return Array.from(new Set(names)).sort()
}

describe('gate-agent roster parity across its duplicated declarations (card 44091907)', () => {
  const dbTs = readFileSync(join(ROOT, 'src', 'db.ts'), 'utf-8')
  const dbMatch = dbTs.match(/const GATE_AUTHORS = \[([^\]]+)\]/)
  expect(dbMatch, 'src/db.ts GATE_AUTHORS declaration not found -- update this test\'s regex if it was renamed/reshaped').toBeTruthy()
  const dbRoster = sortedUnique(parseQuotedList(dbMatch![1]!))

  const guardTs = readFileSync(join(ROOT, 'src', 'web', 'kanban-gate-completeness-guard.ts'), 'utf-8')
  const guardMatch = guardTs.match(/const GATE_AGENT_NAMES: ReadonlySet<string> = new Set<GateAgent>\(\[([^\]]+)\]\)/)
  expect(guardMatch, 'kanban-gate-completeness-guard.ts GATE_AGENT_NAMES declaration not found -- update this test\'s regex if it was renamed/reshaped').toBeTruthy()
  const guardRoster = sortedUnique(parseQuotedList(guardMatch![1]!))

  const verdictsRoster = sortedUnique(Object.values(GATE_ROLE_AGENTS).flat())

  const hookPy = readFileSync(join(ROOT, 'scripts', 'hooks', 'shared-memory-inject.py'), 'utf-8')
  const hookMatch = hookPy.match(/GATE_AGENT_NAMES = frozenset\(\[([^\]]+)\]\)/)
  expect(hookMatch, 'shared-memory-inject.py GATE_AGENT_NAMES declaration not found -- update this test\'s regex if it was renamed/reshaped').toBeTruthy()
  const hookRoster = sortedUnique(parseQuotedList(hookMatch![1]!))

  it('src/db.ts GATE_AUTHORS matches kanban-gate-completeness-guard.ts GATE_AGENT_NAMES', () => {
    expect(dbRoster).toEqual(guardRoster)
  })

  it('src/db.ts GATE_AUTHORS matches the flattened kanban-verdicts.ts GATE_ROLE_AGENTS', () => {
    expect(dbRoster).toEqual(verdictsRoster)
  })

  it('src/db.ts GATE_AUTHORS matches shared-memory-inject.py GATE_AGENT_NAMES', () => {
    expect(dbRoster).toEqual(hookRoster)
  })

  it('the agreed roster is exactly the expected five gate agents (sanity anchor, not just mutual agreement)', () => {
    expect(dbRoster).toEqual(['cybered', 'cybersec', 'cybersec2', 'qa', 'qa2'])
  })
})
