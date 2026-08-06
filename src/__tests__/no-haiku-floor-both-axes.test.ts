// Card a62e0f4a (Cybered latent finding on the e7df7dc1 gate): applyNoHaikuFloor ran on the WEEKLY
// axis only. The cheaper-tier-wins merge then undid it -- it picks whichever axis sits further down
// the ladder, so a QA agent whose BANNER chain had reached Haiku beat its floored weekly target
// (Sonnet 4.6) and the review gate would have run on Haiku. Clamping one input and then picking the
// other is not a floor.
//
// The banner axis is dormant today (enabled:false), so this is a LATENT bypass: nothing is broken in
// production right now, and nothing here asserts otherwise. These tests pin the invariant so turning
// the banner axis on cannot reintroduce it.
import { describe, it, expect } from 'vitest'
import { resolveTargetModel } from '../web/model-fallback-runner.js'
import { MODEL_LADDER, NO_HAIKU_AGENTS, ladderIndexOf } from '../model-catalog.js'

const FABLE = 'claude-fable-5'
const OPUS = 'claude-opus-5'
const SONNET5 = 'claude-sonnet-5'
const SONNET46 = 'claude-sonnet-4-6'
const HAIKU = 'claude-haiku-4-5-20251001'

describe('resolveTargetModel -- the no-Haiku floor holds on BOTH axes (card a62e0f4a)', () => {
  it('THE REGRESSION: a floored agent whose BANNER target is Haiku does not land on Haiku', () => {
    // Exactly the reported scenario: weekly floored to Sonnet 4.6, banner chain at Haiku.
    // Pre-fix the merge returned HAIKU, because ladderIndexOf(haiku) > ladderIndexOf(sonnet-4-6).
    expect(resolveTargetModel('qa', HAIKU, SONNET46)).toBe(SONNET46)
    expect(resolveTargetModel('qa2', HAIKU, SONNET46)).toBe(SONNET46)
  })

  it('a floored agent never lands on Haiku from ANY combination of the two axes', () => {
    for (const agent of NO_HAIKU_AGENTS) {
      for (const banner of MODEL_LADDER) {
        for (const weekly of MODEL_LADDER) {
          expect(resolveTargetModel(agent, banner, weekly)).not.toBe(HAIKU)
        }
      }
    }
  })

  it('a floored agent bottoms out at Sonnet 4.6 when BOTH axes say Haiku', () => {
    expect(resolveTargetModel('qa', HAIKU, HAIKU)).toBe(SONNET46)
  })

  it('the floor does NOT apply to agents outside NO_HAIKU_AGENTS', () => {
    // Peti deliberately routes the FE/support agents down to Haiku -- cheap-but-running beats
    // stopped. The fix must not quietly promote them.
    expect(NO_HAIKU_AGENTS.has('fron-ted')).toBe(false)
    expect(resolveTargetModel('fron-ted', HAIKU, SONNET46)).toBe(HAIKU)
    expect(resolveTargetModel('jogasz', HAIKU, HAIKU)).toBe(HAIKU)
  })
})

describe('resolveTargetModel -- cheaper tier still wins (the pre-existing behaviour is intact)', () => {
  it('the weekly target wins when it is further down the ladder', () => {
    expect(resolveTargetModel('backend2', OPUS, SONNET46)).toBe(SONNET46)
  })

  it('the banner target wins when IT is further down the ladder', () => {
    expect(resolveTargetModel('backend2', SONNET46, OPUS)).toBe(SONNET46)
  })

  it('a tie returns the weekly target (same rung, so the choice is observationally identical)', () => {
    expect(resolveTargetModel('backend2', SONNET5, SONNET5)).toBe(SONNET5)
  })

  it('neither axis can PROMOTE past the other -- the result is never above both inputs', () => {
    for (const banner of MODEL_LADDER) {
      for (const weekly of MODEL_LADDER) {
        const out = resolveTargetModel('backend2', banner, weekly)
        const deeper = Math.max(ladderIndexOf(banner), ladderIndexOf(weekly))
        expect(ladderIndexOf(out)).toBe(deeper)
      }
    }
  })

  it('an OFF-LADDER model (an Ollama/OpenRouter offload) is not rewritten onto a Claude rung', () => {
    // ladderIndexOf() maps an unknown id to 0 (top rung), so an off-ladder banner target loses to
    // any real weekly step -- it must never be the thing that gets picked and written back.
    const offLadder = 'qwen2.5-coder:7b'
    expect(resolveTargetModel('backend2', offLadder, SONNET46)).toBe(SONNET46)
    // With both off-ladder / top-rung, the weekly side stands.
    expect(resolveTargetModel('backend2', offLadder, FABLE)).toBe(FABLE)
  })
})
