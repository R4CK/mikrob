// Card 626df838 (Gemini-orch 3/4): Gemini's first-pass opinion on a local-LLM draft, restricted
// to MikroB-project cards, posted under a marker that must never satisfy the real
// Draft-Review handoff guard.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DRAFT_REVIEW_RX } from '../web/kanban-draft-review-guard.js'

let killSwitchEnabled = false
let fallbackRoute: 'claude' | 'gemini' = 'claude'

vi.mock('../gemini-orchestrator.js', () => ({
  isGeminiOrchestratorEnabled: vi.fn(() => killSwitchEnabled),
  readFallbackRoute: vi.fn(() => fallbackRoute),
  isBlockedByLandedFilter: vi.fn((_project: string, tags: string, title: string, desc: string) => {
    const hay = `${tags} ${title} ${desc}`.toLowerCase()
    return /blokkolt|sec\b|biztonsag|cybersec/.test(hay)
  }),
}))

import {
  isEligibleForGeminiDraftReview,
  containsSecretShape,
  resolveDraftPathSafely,
  alreadyAdjudicated,
  parseReviewResponse,
  formatReviewComment,
  reviewOneCard,
  runGeminiOrchestratorDraftReviewSweep,
  REVIEW_AUTHOR,
  type DraftReviewCardMeta,
} from '../gemini-orchestrator-draft-review.js'
import { DRAFTS_DIR } from '../gemini-orchestrator-draft-cleanup.js'
import type { GeminiResult } from '../gemini-client.js'

beforeEach(() => {
  killSwitchEnabled = false
  fallbackRoute = 'claude'
  vi.clearAllMocks()
})

function card(overrides: Partial<DraftReviewCardMeta> = {}): DraftReviewCardMeta {
  return { id: 'c1', title: 'Boring infra fix', description: 'nothing sensitive here', project: 'MikroB', tags: '', ...overrides }
}

// Built at runtime, not a literal on disk: the secret-write-guard hook (rightly) refuses to let
// a real-shaped private-key fixture land in a tracked file, even a test fixture.
const FAKE_PRIVATE_KEY_BLOCK = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ')
const FAKE_GITHUB_TOKEN = ['ghp', 'a'.repeat(36)].join('_')
const FAKE_STRIPE_KEY = ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_')

// ── isEligibleForGeminiDraftReview: project allowlist + the landed content gate ────────────
describe('isEligibleForGeminiDraftReview() (card 626df838)', () => {
  it('allows an exact "MikroB" project with no sensitive signal', () => {
    expect(isEligibleForGeminiDraftReview(card())).toBe(true)
  })

  it('is case-insensitive on the project name', () => {
    expect(isEligibleForGeminiDraftReview(card({ project: 'mikrob' }))).toBe(true)
  })

  it('rejects mopsion -- the title says KIZAROLAG MikroB-projekt', () => {
    expect(isEligibleForGeminiDraftReview(card({ project: 'mopsion' }))).toBe(false)
  })

  it('rejects a null/unknown project', () => {
    expect(isEligibleForGeminiDraftReview(card({ project: null }))).toBe(false)
  })

  it('rejects a MikroB-project card the landed filter blocks on tags (e.g. a SEC label)', () => {
    expect(isEligibleForGeminiDraftReview(card({ tags: 'SEC' }))).toBe(false)
  })

  it('rejects a MikroB-project card the landed filter blocks on a BLOKKOLT-* title tag', () => {
    expect(isEligibleForGeminiDraftReview(card({ title: '[BLOKKOLT-Peti-stop] something' }))).toBe(false)
  })
})

// ── containsSecretShape: reuses secret-gate.ts patterns, no second hand-copied list ─────────
describe('containsSecretShape() (card 626df838)', () => {
  it('is false on ordinary text', () => {
    expect(containsSecretShape('just a normal draft about refactoring a function')).toBe(false)
  })

  it('catches a Stripe-shaped secret key', () => {
    expect(containsSecretShape(`here is ${FAKE_STRIPE_KEY} for testing`)).toBe(true)
  })

  it('catches a GitHub token', () => {
    expect(containsSecretShape(`token: ${FAKE_GITHUB_TOKEN}`)).toBe(true)
  })

  it('catches a private key block', () => {
    expect(containsSecretShape(FAKE_PRIVATE_KEY_BLOCK)).toBe(true)
  })
})

// ── resolveDraftPathSafely: the draft file must resolve under DRAFTS_DIR ────────────────────
describe('resolveDraftPathSafely() (card 626df838)', () => {
  it('resolves a normal relative draft path under DRAFTS_DIR', () => {
    const abs = resolveDraftPathSafely('drafts/c1/123-leaf.md')
    expect(abs).toBe(`${DRAFTS_DIR}/c1/123-leaf.md`)
  })

  it('refuses a traversal attempt that would land outside DRAFTS_DIR', () => {
    expect(resolveDraftPathSafely('../../etc/passwd')).toBeNull()
  })

  it('refuses an absolute path elsewhere on disk', () => {
    expect(resolveDraftPathSafely('/etc/passwd')).toBeNull()
  })
})

// ── alreadyAdjudicated: idempotency against both a real verdict and a prior Gemini opinion ──
describe('alreadyAdjudicated() (card 626df838)', () => {
  it('false when nothing has reviewed the draft yet', () => {
    expect(alreadyAdjudicated([], 100)).toBe(false)
  })

  it('true when a human Draft-Review verdict already exists at/after the draft', () => {
    const comments = [{ author: 'backend2', content: 'Draft-Review: ELFOGADVA', created_at: 150 }]
    expect(alreadyAdjudicated(comments, 100)).toBe(true)
  })

  it('true when this module already posted its own first-pass opinion at/after the draft', () => {
    const comments = [{ author: REVIEW_AUTHOR, content: 'GEMINI-ELSO-KOR: USABLE\nfine', created_at: 150 }]
    expect(alreadyAdjudicated(comments, 100)).toBe(true)
  })

  it('false when the only verdict predates this draft (a NEWER draft arrived unreviewed)', () => {
    const comments = [{ author: 'backend2', content: 'Draft-Review: ELFOGADVA', created_at: 50 }]
    expect(alreadyAdjudicated(comments, 100)).toBe(false)
  })

  it('a verdict from a GENERATED author (e.g. local-llm itself) does not count', () => {
    const comments = [{ author: 'local-llm', content: 'Draft-Review: ELFOGADVA', created_at: 150 }]
    expect(alreadyAdjudicated(comments, 100)).toBe(false)
  })
})

// ── parseReviewResponse: fail-closed on anything but the exact shape ────────────────────────
describe('parseReviewResponse() (card 626df838)', () => {
  it('parses a valid verdict', () => {
    expect(parseReviewResponse('{"verdict":"USABLE","reason":"looks fine"}')).toEqual({ verdict: 'USABLE', reason: 'looks fine' })
  })

  it('strips a markdown fence', () => {
    expect(parseReviewResponse('```json\n{"verdict":"PARTIAL","reason":"half done"}\n```')).toEqual({ verdict: 'PARTIAL', reason: 'half done' })
  })

  it('null on an invalid verdict value', () => {
    expect(parseReviewResponse('{"verdict":"MAYBE","reason":"x"}')).toBeNull()
  })

  it('null on missing reason', () => {
    expect(parseReviewResponse('{"verdict":"USABLE"}')).toBeNull()
  })

  it('null on unparsable text', () => {
    expect(parseReviewResponse('not json at all')).toBeNull()
  })

  it('null on a JSON array instead of an object', () => {
    expect(parseReviewResponse('["USABLE"]')).toBeNull()
  })
})

// ── formatReviewComment: the posted text must NEVER satisfy the real Draft-Review guard ─────
describe('formatReviewComment() (card 626df838) -- marker distinctness, the load-bearing invariant', () => {
  it('never matches the REAL imported DRAFT_REVIEW_RX, for any verdict value', () => {
    for (const verdict of ['USABLE', 'PARTIAL', 'UNUSABLE'] as const) {
      const text = formatReviewComment({ verdict, reason: 'some reason text' })
      expect(DRAFT_REVIEW_RX.test(text)).toBe(false)
    }
  })

  it('still carries the verdict and reason, legible to a human', () => {
    const text = formatReviewComment({ verdict: 'PARTIAL', reason: 'missing the rollback path' })
    expect(text).toContain('PARTIAL')
    expect(text).toContain('missing the rollback path')
  })
})

// ── reviewOneCard: the full per-card decision, injected deps, never throws ──────────────────
describe('reviewOneCard() (card 626df838)', () => {
  const baseDeps = () => ({
    readCard: vi.fn(() => ({ title: 'Boring infra fix', description: 'nothing sensitive', project: 'MikroB' })),
    readComments: vi.fn(() => [{ author: 'local-llm', content: 'draft ref: a draft fajlban marad: drafts/c1/1-leaf.md. DRAFT-ONLY:', created_at: 100 }]),
    readLabels: vi.fn(() => []),
    readDraft: vi.fn(() => 'draft body text'),
    postComment: vi.fn(),
    callGemini: vi.fn(async (): Promise<GeminiResult> => ({ ok: true, text: '{"verdict":"USABLE","reason":"fine"}' })),
  })

  it('posts a review when everything lines up', async () => {
    const deps = baseDeps()
    const result = await reviewOneCard('c1', 'key', deps)
    expect(result.reviewed).toBe(true)
    expect(deps.postComment).toHaveBeenCalledWith('c1', REVIEW_AUTHOR, expect.stringContaining('GEMINI-ELSO-KOR: USABLE'))
  })

  it('skips with no_draft when there is no draft-ref comment', async () => {
    const deps = baseDeps()
    deps.readComments = vi.fn(() => [])
    const result = await reviewOneCard('c1', 'key', deps)
    expect(result).toEqual({ id: 'c1', reviewed: false, reason: 'no_draft' })
    expect(deps.callGemini).not.toHaveBeenCalled()
  })

  it('skips with already_adjudicated when a human verdict already covers this draft', async () => {
    const deps = baseDeps()
    deps.readComments = vi.fn(() => [
      { author: 'local-llm', content: 'draft ref: a draft fajlban marad: drafts/c1/1-leaf.md. DRAFT-ONLY:', created_at: 100 },
      { author: 'backend2', content: 'Draft-Review: ELFOGADVA', created_at: 200 },
    ])
    const result = await reviewOneCard('c1', 'key', deps)
    expect(result).toEqual({ id: 'c1', reviewed: false, reason: 'already_adjudicated' })
    expect(deps.callGemini).not.toHaveBeenCalled()
  })

  it('skips with unsafe_draft_path on a traversal attempt, never reading the file or calling Gemini', async () => {
    const deps = baseDeps()
    deps.readComments = vi.fn(() => [{ author: 'local-llm', content: 'a draft fajlban marad: ../../etc/passwd. DRAFT-ONLY:', created_at: 100 }])
    const result = await reviewOneCard('c1', 'key', deps)
    expect(result).toEqual({ id: 'c1', reviewed: false, reason: 'unsafe_draft_path' })
    expect(deps.readDraft).not.toHaveBeenCalled()
    expect(deps.callGemini).not.toHaveBeenCalled()
  })

  it('skips with not_eligible on a mopsion-project card, never calling Gemini', async () => {
    const deps = baseDeps()
    deps.readCard = vi.fn(() => ({ title: 'x', description: 'y', project: 'mopsion' }))
    const result = await reviewOneCard('c1', 'key', deps)
    expect(result).toEqual({ id: 'c1', reviewed: false, reason: 'not_eligible' })
    expect(deps.callGemini).not.toHaveBeenCalled()
  })

  it('skips with secret_shape_detected and never calls Gemini when the draft body has a secret shape', async () => {
    const deps = baseDeps()
    deps.readDraft = vi.fn(() => `oops here is ${FAKE_STRIPE_KEY}`)
    const result = await reviewOneCard('c1', 'key', deps)
    expect(result).toEqual({ id: 'c1', reviewed: false, reason: 'secret_shape_detected' })
    expect(deps.callGemini).not.toHaveBeenCalled()
    expect(deps.postComment).not.toHaveBeenCalled()
  })

  it('skips with secret_shape_detected when the CARD DESCRIPTION (not the draft) has a secret shape', async () => {
    const deps = baseDeps()
    deps.readCard = vi.fn(() => ({ title: 'x', description: `key is ${FAKE_GITHUB_TOKEN}`, project: 'MikroB' }))
    const result = await reviewOneCard('c1', 'key', deps)
    expect(result.reason).toBe('secret_shape_detected')
    expect(deps.callGemini).not.toHaveBeenCalled()
  })

  it('fail-closed reason when Gemini returns an unparsable response, and nothing is posted', async () => {
    const deps = baseDeps()
    deps.callGemini = vi.fn(async (): Promise<GeminiResult> => ({ ok: true, text: 'not json' }))
    const result = await reviewOneCard('c1', 'key', deps)
    expect(result).toEqual({ id: 'c1', reviewed: false, reason: 'invalid_response_schema' })
    expect(deps.postComment).not.toHaveBeenCalled()
  })

  it('fail-closed reason when Gemini call itself fails', async () => {
    const deps = baseDeps()
    deps.callGemini = vi.fn(async (): Promise<GeminiResult> => ({ ok: false, reason: 'quota' }))
    const result = await reviewOneCard('c1', 'key', deps)
    expect(result).toEqual({ id: 'c1', reviewed: false, reason: 'quota' })
  })

  it('never throws when readComments throws', async () => {
    const deps = baseDeps()
    deps.readComments = vi.fn(() => { throw new Error('db down') })
    const result = await reviewOneCard('c1', 'key', deps)
    expect(result.reviewed).toBe(false)
    expect(result.reason).toContain('comments_unreadable')
  })
})

// ── runGeminiOrchestratorDraftReviewSweep: kill switch + route gating ────────────────────────
describe('runGeminiOrchestratorDraftReviewSweep() (card 626df838)', () => {
  it('no-ops when the kill switch is off', async () => {
    killSwitchEnabled = false
    fallbackRoute = 'gemini'
    const summary = await runGeminiOrchestratorDraftReviewSweep(() => ['c1'])
    expect(summary).toEqual({ ran: false, reason: 'kill_switch_off' })
  })

  it('no-ops when the route is not gemini', async () => {
    killSwitchEnabled = true
    fallbackRoute = 'claude'
    const summary = await runGeminiOrchestratorDraftReviewSweep(() => ['c1'])
    expect(summary).toEqual({ ran: false, reason: 'not_gemini_route' })
  })

  it('runs with an empty list when enabled and on-route but there are no draft cards', async () => {
    killSwitchEnabled = true
    fallbackRoute = 'gemini'
    const summary = await runGeminiOrchestratorDraftReviewSweep(() => [])
    expect(summary.ran).toBe(true)
    expect(summary.results).toEqual([])
  })
})
