// Card 2f5caa6f (527c9584 Fazis 3. lepese): the heartbeat-consolidated dispatch prompt must
// actually invoke skill-dispatch-hint.sh before composing the delegation message, not just
// reference the idea in prose. Structural source check on the seed SKILL.md, the same technique
// the other *-wiring.test.ts files use for a prompt/script binding that cannot be exercised by
// running the prompt itself (it is text a model reads, not code this suite executes).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILL_MD = join(
  __dirname, '..', '..', 'seed-scheduled-tasks', 'heartbeat-consolidated', 'SKILL.md',
)

describe('heartbeat-consolidated dispatch prompt wires skill-dispatch-hint.sh (card 2f5caa6f)', () => {
  const src = readFileSync(SKILL_MD, 'utf-8')

  it('invokes skill-dispatch-hint.sh with <cardId> and <agent> before the delegation step', () => {
    expect(src).toMatch(/skill-dispatch-hint\.sh <cardId> <agent>/)
  })

  it('the invocation happens BEFORE the delegation-message step (4e precedes 4b in the dispatch flow)', () => {
    const callIdx = src.indexOf('skill-dispatch-hint.sh <cardId> <agent>')
    const stepFourIdx = src.indexOf('4. HA NINCS futo munka, DE van planned kartya')
    expect(callIdx).toBeGreaterThan(-1)
    expect(stepFourIdx).toBeGreaterThan(-1)
    // step 4 itself names the 4e hint explicitly, so the reference sits downstream of step 4's
    // OWN text, not that the 4e block as a whole precedes it in the file.
    expect(src.slice(stepFourIdx, stepFourIdx + 800)).toContain('4e lepesben kapott skill-hintet')
  })

  it('tells the agent to skip the hint line when no skill matched, instead of inventing one', () => {
    expect(src).toMatch(/HA ures.*NE talalj ki skillt/s)
  })
})
