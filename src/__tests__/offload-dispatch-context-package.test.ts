// Card 2be7e3e5 (Peti Telegram 11175): "minden feladat menjen oda a kello kontextussal eloszor" --
// the local LLM's context package must carry card + parent + Pair/predecessor + affected-files
// excerpt, size-bounded. The card + parent (ancestor chain) and affected-files excerpt already
// existed (ancestor_context, graph_args_for); this file pins the part that did not: resolve_leaves()'s
// parent_context must also fold in a predecessor card (the `blockedBy` dependency edge, CLAUDE.md
// rule 1c) and a Pair-FE/Pair-BE sibling card (the `Pair-FE: <id>` / `Pair-BE: <id>` line, rule 8a).
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DISPATCH = 'store/offload-dispatch.sh'

function src(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf-8')
}

// Extract a bash function's full source (name through matching closing brace), by name.
function extractFn(fullSrc: string, name: string): string {
  const idx = fullSrc.indexOf(`\n${name}()`)
  let depth = 0
  let end = idx
  for (let i = idx; i < fullSrc.length; i++) {
    if (fullSrc[i] === '{') depth++
    if (fullSrc[i] === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  return fullSrc.slice(idx, end)
}

type FakeCard = {
  id: string
  title: string
  description?: string
  status?: string
  parent_id?: string
  blockedBy?: string[]
  labels?: { name: string }[]
}

function parentContextFor(cardId: string, cards: FakeCard[]): string {
  const fnDef = extractFn(src(DISPATCH), 'resolve_leaves')
  const json = JSON.stringify(cards)
  const out = execFileSync(
    'bash',
    ['-c', `CARD=${cardId} OFFLOAD_STALE_IN_PROGRESS_SECONDS=600\n${fnDef}\nresolve_leaves`],
    { encoding: 'utf-8', input: json },
  )
  const leaves = JSON.parse(out) as { id: string; parent_context: string }[]
  const leaf = leaves.find((l) => l.id === cardId)
  expect(leaf, `resolve_leaves must return the target leaf ${cardId}`).toBeTruthy()
  return leaf!.parent_context
}

describe('resolve_leaves() parent_context includes predecessor + pair (card 2be7e3e5)', () => {
  it('a predecessor (blockedBy) card is folded into parent_context', () => {
    const cards: FakeCard[] = [
      { id: 'leaf0001', title: 'The leaf card', status: 'planned', blockedBy: ['pred0001'] },
      { id: 'pred0001', title: 'Predecessor card title', description: 'predecessor body text' },
    ]
    const ctx = parentContextFor('leaf0001', cards)
    expect(ctx).toContain('Predecessor card title')
    expect(ctx).toContain('predecessor body text')
    expect(ctx).toContain('pred0001')
  })

  it('a Pair-FE card referenced in the leaf own description is folded into parent_context', () => {
    const cards: FakeCard[] = [
      {
        id: 'leaf0002',
        title: 'Backend leaf',
        status: 'planned',
        description: 'Pair-FE: fec0ad01\nrest of the description',
      },
      { id: 'fec0ad01', title: 'Frontend pair card title', description: 'frontend pair body text' },
    ]
    const ctx = parentContextFor('leaf0002', cards)
    expect(ctx).toContain('Frontend pair card title')
    expect(ctx).toContain('frontend pair body text')
  })

  it('a Pair-BE card referenced in the leaf own description is folded into parent_context', () => {
    const cards: FakeCard[] = [
      {
        id: 'leaf0003',
        title: 'Frontend leaf',
        status: 'planned',
        description: 'Pair-BE: bec0ad01\nrest of the description',
      },
      { id: 'bec0ad01', title: 'Backend pair card title', description: 'backend pair body text' },
    ]
    const ctx = parentContextFor('leaf0003', cards)
    expect(ctx).toContain('Backend pair card title')
  })

  it('no predecessor and no pair -> parent_context has no predecessor/pair markers (no false positives)', () => {
    const cards: FakeCard[] = [
      { id: 'leaf0004', title: 'Plain leaf', status: 'planned', description: 'nothing special here' },
    ]
    const ctx = parentContextFor('leaf0004', cards)
    expect(ctx).not.toContain('ELOZMENY')
    expect(ctx).not.toContain('PAROSITOTT')
  })

  it('a missing predecessor id (dangling blockedBy) is skipped, not crashed on', () => {
    const cards: FakeCard[] = [
      { id: 'leaf0005', title: 'Leaf with dangling predecessor', status: 'planned', blockedBy: ['doesnotexist'] },
    ]
    const ctx = parentContextFor('leaf0005', cards)
    expect(ctx).not.toContain('ELOZMENY')
  })

  it('ancestor (parent) context and predecessor context both appear together, size-bounded per card', () => {
    const longDesc = 'x'.repeat(2000)
    const cards: FakeCard[] = [
      { id: 'leaf0006', title: 'Leaf', status: 'planned', parent_id: 'phase0001', blockedBy: ['pred0006'] },
      { id: 'phase0001', title: 'Parent phase title', description: longDesc },
      { id: 'pred0006', title: 'Predecessor title', description: longDesc },
    ]
    const ctx = parentContextFor('leaf0006', cards)
    expect(ctx).toContain('Parent phase title')
    expect(ctx).toContain('Predecessor title')
    expect(ctx).toContain('ELOZMENY')
    // Each card's description is capped at 400 chars (same cap as the existing ancestor chain) --
    // the long description must have been truncated, not carried in full twice over.
    expect(ctx.length).toBeLessThan(longDesc.length)
  })
})
