// Card 30a34eba: let a message's recipient see how many others are waiting behind it, so they can
// decide for themselves whether to self-interrupt a long-running step.
import { describe, it, expect } from 'vitest'
import { formatQueueDepthNote } from '../web/message-queue-depth-note.js'

describe('formatQueueDepthNote', () => {
  it('depth 0 (nothing else waiting) adds NO noise -- the routine case stays quiet', () => {
    expect(formatQueueDepthNote(0)).toBe('')
  })

  it('a negative count (should never happen, but a decoration must not misreport) is also silent', () => {
    expect(formatQueueDepthNote(-1)).toBe('')
  })

  it('one other message waiting is named, with the count', () => {
    const note = formatQueueDepthNote(1)
    expect(note).toContain('+1')
    expect(note).toContain('vár rád a sorban')
  })

  it('several other messages waiting: the exact count is named, not just "some"', () => {
    const note = formatQueueDepthNote(7)
    expect(note).toContain('+7')
  })

  it('MUTATION-PROOF: the note actually carries the self-interrupt guidance, not just the count', () => {
    // A mutant that only prints the number, dropping the actual point of the card (letting the
    // recipient decide whether to break out of a long step), would still pass a bare count check.
    expect(formatQueueDepthNote(2)).toMatch(/megszakítanod/)
  })
})
