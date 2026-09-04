// Card 8417fa5e: the four Qwen3.8 specialist templates are actually CALLED by a workflow.
//
// The measured gap: store/local-llm-model-routing.json already routed board-reconcile,
// morning-brief, daily-log and tg-draft to the local specialist, the prompts existed, and the model
// was installed -- but nothing invoked them. The only `--task board-reconcile` occurrence in the
// repo was inside the routing selftest, so the routing was exercised and the CAPABILITY was not.
// MikroB wrote all four kinds of Hungarian text on the online model instead.
//
// WHAT THIS TEST IS FOR, and it is not "the prose mentions a task name". A wiring that tells MikroB
// to start from a local draft WITHOUT telling it to re-check the facts would be worse than no
// wiring at all -- see the measurement in CLAUDE.md: across three tg-draft samples the style rules
// held perfectly (zero em dashes, zero AI cliches) while TWO INVERTED A FACT and one invented an
// action nobody asked for. So the review obligation is pinned here alongside the call itself.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROJECT_ROOT } from '../config.js'

const TASKS = ['morning-brief', 'tg-draft', 'daily-log', 'board-reconcile'] as const
const claudeMd = readFileSync(join(PROJECT_ROOT, 'CLAUDE.md'), 'utf-8')

describe('the four specialist templates are wired into a real workflow (card 8417fa5e)', () => {
  it('CLAUDE.md names each task, so none of the four is left unreachable again', () => {
    for (const task of TASKS) {
      expect(claudeMd, `${task} has a routing override and a prompt, but no caller`).toContain(
        `--task ${task}`,
      )
    }
  })

  it('the morning brief calls the real script by absolute path', () => {
    // A relative path in an instruction is a path relative to whatever directory the agent happens
    // to be in -- the same class as the cd-chain problem, and it fails silently.
    expect(claudeMd).toContain('/home/neon/marveen/store/local-llm.sh --task morning-brief')
  })

  it('every wired task actually resolves to a routing override and a prompt file', () => {
    // Wiring a call to a template that does not exist would "pass" a prose check and fail at 06:00.
    const routing = JSON.parse(
      readFileSync(join(PROJECT_ROOT, 'store', 'local-llm-model-routing.json'), 'utf-8'),
    ) as { overrides?: Record<string, string> }
    for (const task of TASKS) {
      expect(routing.overrides?.[task], `${task} has no model override`).toBeTruthy()
      expect(
        existsSync(join(PROJECT_ROOT, 'store', 'local-llm-skills', `${task}.txt`)),
        `${task}.txt prompt is missing`,
      ).toBe(true)
    }
  })

  it('the wiring tells MikroB the draft is STRUCTURE, and the facts are its own job', () => {
    // The load-bearing half. Measured, not assumed: the local model keeps the tone and corrupts the
    // content, so an instruction that stops at "use the local draft" would ship inverted facts in
    // Peti's morning brief.
    expect(claudeMd).toContain('MEGFORDÍTOTT egy tényt')
    expect(claudeMd).toMatch(/minden állítást vess össze/)
  })

  it('critical Telegram messages are excluded from the draft path by name', () => {
    // tg-draft is the one with a direct route to Peti, and precision is exactly what degrades.
    expect(claudeMd).toMatch(/Kritikusat.*NE ezzel írj/s)
  })
})

// --- gate closure: same sha, not merely all present (card 1c4f9af1) --------------------------
// Cybered's finding. Pinned in the same file because it is the same class of problem: a rule that
// lives only in prose is a rule nobody can check, and CLAUDE.md rule 4a is where MikroB's closure
// step is written down.
describe('rule 4a demands the gates agree on a SHA, not just that all of them spoke', () => {
  it('names the check and what to do with each of its answers', () => {
    expect(claudeMd).toContain('gate-closure-check.py')
    // The distinction the tool exists to draw: every gate passing is necessary, not sufficient.
    expect(claudeMd).toMatch(/NEM elég önmagában/)
    expect(claudeMd).toContain('DISAGREE')
    // NOSHA has to be named too, or a reader meets an answer the instruction never mentioned and
    // guesses -- and 8% of real verdicts carry no Gate-SHA line.
    expect(claudeMd).toContain('NOSHA')
  })
})
