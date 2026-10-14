// Card b8da509b (Gemini-orch 4/4): once a Gemini-orch draft file has a Draft-Review verdict on
// the card, delete the on-disk draft directory and leave a one-line trace comment. Reuses
// kanban-draft-review-guard.ts's own DRAFT_REVIEW_RX/GENERATED_COMMENT_AUTHORS, so this suite
// does not re-test that vocabulary -- only the new file-ref parsing + cleanup decision + sweep.
import { describe, it, expect, vi } from 'vitest'
import {
  extractDraftRefPath,
  findLatestDraftFileRef,
  planDraftCleanup,
  runDraftCleanupSweep,
  type Comment,
} from '../gemini-orchestrator-draft-cleanup.js'

const DRAFT_REF_BODY =
  "[LOCAL-LLM DRAFT | dispatch-offload, Gemini-orch] Helyi (7B) draft keszult, de a szovege NEM a kartyan van -- a Gemini-orchestrator mod alatt (kartya 21fbc293, cf757409 dontes B) a draft fajlban marad: drafts/cardA/1700000000-cardA.md. DRAFT-ONLY: a kvota visszaterese utan a felelos agent olvassa el a fajlt es integralja, ne irja ujra Claude-dal.\n\n#### some title\n"

describe('extractDraftRefPath() (card b8da509b)', () => {
  it('extracts the relative path between the two literal anchors', () => {
    expect(extractDraftRefPath(DRAFT_REF_BODY)).toBe('drafts/cardA/1700000000-cardA.md')
  })

  it('returns null for unrelated text (e.g. the embedded comment draft shape, not the file-ref shape)', () => {
    expect(extractDraftRefPath('[LOCAL-LLM DRAFT | dispatch-offload] some other draft text')).toBeNull()
  })

  it('returns null for empty/undefined content', () => {
    expect(extractDraftRefPath('')).toBeNull()
  })
})

describe('findLatestDraftFileRef() (card b8da509b)', () => {
  it('returns null when the card never had a file-ref comment', () => {
    const comments: Comment[] = [{ author: 'backend', content: 'just a normal comment', created_at: 1 }]
    expect(findLatestDraftFileRef(comments)).toBeNull()
  })

  it('ignores a file-ref-shaped comment from a non local-llm author', () => {
    const comments: Comment[] = [{ author: 'backend', content: DRAFT_REF_BODY, created_at: 1 }]
    expect(findLatestDraftFileRef(comments)).toBeNull()
  })

  it('finds the single file-ref comment', () => {
    const comments: Comment[] = [{ author: 'local-llm', content: DRAFT_REF_BODY, created_at: 100 }]
    expect(findLatestDraftFileRef(comments)).toEqual({ path: 'drafts/cardA/1700000000-cardA.md', at: 100 })
  })

  it('picks the NEWEST file-ref when a card had multiple drafts (retries)', () => {
    const older = DRAFT_REF_BODY
    const newer = DRAFT_REF_BODY.replace('1700000000-cardA.md', '1700000500-cardA.md')
    const comments: Comment[] = [
      { author: 'local-llm', content: older, created_at: 100 },
      { author: 'local-llm', content: newer, created_at: 200 },
    ]
    expect(findLatestDraftFileRef(comments)).toEqual({ path: 'drafts/cardA/1700000500-cardA.md', at: 200 })
  })
})

describe('planDraftCleanup() (card b8da509b)', () => {
  it('no draft file ref at all -> do not delete', () => {
    const comments: Comment[] = [{ author: 'backend', content: 'Draft-Review: ELFOGADVA', created_at: 10 }]
    expect(planDraftCleanup(comments)).toEqual({ shouldDelete: false })
  })

  it('draft file ref but NO Draft-Review verdict yet -> do not delete (still pending adjudication)', () => {
    const comments: Comment[] = [{ author: 'local-llm', content: DRAFT_REF_BODY, created_at: 100 }]
    expect(planDraftCleanup(comments)).toEqual({ shouldDelete: false })
  })

  it('draft file ref + a later Draft-Review verdict -> delete, carrying the path and verdict', () => {
    const comments: Comment[] = [
      { author: 'local-llm', content: DRAFT_REF_BODY, created_at: 100 },
      { author: 'backend', content: 'Draft-Review: ELFOGADVA, beepitve.', created_at: 200 },
    ]
    expect(planDraftCleanup(comments)).toEqual({
      shouldDelete: true,
      path: 'drafts/cardA/1700000000-cardA.md',
      verdict: 'ELFOGADVA',
    })
  })

  it('a verdict comment authored by local-llm itself does not count (same anti-self-adjudication rule as the handoff guard)', () => {
    const comments: Comment[] = [
      { author: 'local-llm', content: DRAFT_REF_BODY, created_at: 100 },
      { author: 'local-llm', content: 'Draft-Review: ELFOGADVA', created_at: 200 },
    ]
    expect(planDraftCleanup(comments)).toEqual({ shouldDelete: false })
  })

  it('a verdict comment OLDER than the file-ref does not count (stale adjudication)', () => {
    const comments: Comment[] = [
      { author: 'backend', content: 'Draft-Review: ELFOGADVA', created_at: 50 },
      { author: 'local-llm', content: DRAFT_REF_BODY, created_at: 100 },
    ]
    expect(planDraftCleanup(comments)).toEqual({ shouldDelete: false })
  })

  it('accepts all four verdict words (ELUTASITVA, RESZBEN, FELESLEGES too)', () => {
    for (const word of ['ELUTASITVA', 'RESZBEN', 'FELESLEGES']) {
      const comments: Comment[] = [
        { author: 'local-llm', content: DRAFT_REF_BODY, created_at: 100 },
        { author: 'backend', content: `Draft-Review: ${word}`, created_at: 200 },
      ]
      expect(planDraftCleanup(comments).shouldDelete).toBe(true)
      expect(planDraftCleanup(comments).verdict).toBe(word)
    }
  })
})

describe('runDraftCleanupSweep() (card b8da509b)', () => {
  it('no card directories -> no-op, nothing deleted or posted', () => {
    const listCardIds = vi.fn(() => [] as string[])
    const getComments = vi.fn()
    const deleteDir = vi.fn()
    const postComment = vi.fn()
    const summary = runDraftCleanupSweep(listCardIds, getComments, deleteDir, postComment)
    expect(summary).toEqual({ cleaned: [] })
    expect(deleteDir).not.toHaveBeenCalled()
    expect(postComment).not.toHaveBeenCalled()
  })

  it('a card with a ref but no verdict yet is left alone', () => {
    const listCardIds = vi.fn(() => ['cardA'])
    const getComments = vi.fn(() => [{ author: 'local-llm', content: DRAFT_REF_BODY, created_at: 100 }])
    const deleteDir = vi.fn()
    const postComment = vi.fn()
    const summary = runDraftCleanupSweep(listCardIds, getComments, deleteDir, postComment)
    expect(summary).toEqual({ cleaned: [] })
    expect(deleteDir).not.toHaveBeenCalled()
  })

  it('a reviewed card gets its directory deleted and a one-line trace comment posted', () => {
    const listCardIds = vi.fn(() => ['cardA'])
    const getComments = vi.fn(() => [
      { author: 'local-llm', content: DRAFT_REF_BODY, created_at: 100 },
      { author: 'backend', content: 'Draft-Review: ELFOGADVA, beepitve.', created_at: 200 },
    ])
    const deleteDir = vi.fn()
    const postComment = vi.fn()
    const summary = runDraftCleanupSweep(listCardIds, getComments, deleteDir, postComment)
    expect(summary).toEqual({ cleaned: ['cardA'] })
    expect(deleteDir).toHaveBeenCalledTimes(1)
    expect(deleteDir.mock.calls[0][0]).toMatch(/drafts[\\/]cardA$/)
    expect(postComment).toHaveBeenCalledTimes(1)
    const [id, author, content] = postComment.mock.calls[0] as [string, string, string]
    expect(id).toBe('cardA')
    expect(author).toBe('gemini-orch-cleanup')
    expect(content).toContain('Draft-Review: ELFOGADVA')
    expect(content).toContain('drafts/cardA/')
    expect(content.split('\n')).toHaveLength(1) // "egysoros nyom" -- a single line
  })

  it('a getComments error for one card does not stop the sweep for the rest', () => {
    const listCardIds = vi.fn(() => ['cardBad', 'cardGood'])
    const getComments = vi.fn((id: string) => {
      if (id === 'cardBad') throw new Error('db unavailable')
      return [
        { author: 'local-llm', content: DRAFT_REF_BODY, created_at: 100 },
        { author: 'backend', content: 'Draft-Review: ELFOGADVA', created_at: 200 },
      ]
    })
    const deleteDir = vi.fn()
    const postComment = vi.fn()
    const summary = runDraftCleanupSweep(listCardIds, getComments, deleteDir, postComment)
    expect(summary).toEqual({ cleaned: ['cardGood'] })
    expect(deleteDir).toHaveBeenCalledTimes(1)
  })

  it('a deleteDir error for one card does not stop the sweep for the rest, and no trace comment is posted for it', () => {
    const listCardIds = vi.fn(() => ['cardBad', 'cardGood'])
    const comments = [
      { author: 'local-llm', content: DRAFT_REF_BODY, created_at: 100 },
      { author: 'backend', content: 'Draft-Review: ELFOGADVA', created_at: 200 },
    ]
    const getComments = vi.fn(() => comments)
    const deleteDir = vi.fn((p: string) => {
      if (p.includes('cardBad')) throw new Error('EACCES')
    })
    const postComment = vi.fn()
    const summary = runDraftCleanupSweep(listCardIds, getComments, deleteDir, postComment)
    expect(summary).toEqual({ cleaned: ['cardGood'] })
    expect(postComment).toHaveBeenCalledTimes(1)
    expect(postComment.mock.calls[0][0]).toBe('cardGood')
  })

  it('a postComment error still counts the card as cleaned (the file was already deleted)', () => {
    const listCardIds = vi.fn(() => ['cardA'])
    const getComments = vi.fn(() => [
      { author: 'local-llm', content: DRAFT_REF_BODY, created_at: 100 },
      { author: 'backend', content: 'Draft-Review: ELFOGADVA', created_at: 200 },
    ])
    const deleteDir = vi.fn()
    const postComment = vi.fn(() => {
      throw new Error('API down')
    })
    const summary = runDraftCleanupSweep(listCardIds, getComments, deleteDir, postComment)
    expect(summary).toEqual({ cleaned: ['cardA'] })
    expect(deleteDir).toHaveBeenCalledTimes(1)
  })

  it('multiple cards, mixed states: only the reviewed ones are cleaned', () => {
    const listCardIds = vi.fn(() => ['pending', 'reviewed', 'noRef'])
    const getComments = vi.fn((id: string) => {
      if (id === 'pending') return [{ author: 'local-llm', content: DRAFT_REF_BODY, created_at: 100 }]
      if (id === 'reviewed')
        return [
          { author: 'local-llm', content: DRAFT_REF_BODY, created_at: 100 },
          { author: 'backend', content: 'Draft-Review: RESZBEN, egy reszet hasznaltam.', created_at: 200 },
        ]
      return [{ author: 'backend', content: 'nothing to do with drafts', created_at: 1 }]
    })
    const deleteDir = vi.fn()
    const postComment = vi.fn()
    const summary = runDraftCleanupSweep(listCardIds, getComments, deleteDir, postComment)
    expect(summary).toEqual({ cleaned: ['reviewed'] })
    expect(deleteDir).toHaveBeenCalledTimes(1)
  })
})
