// Card bcd96d52: (event as any).sessionId read the SDK's 'system'/'init' message with the
// wrong field name -- the SDK carries `session_id` (snake_case) in both 0.2.116 and 0.3.224,
// confirmed against the shipped .d.ts. newSessionId was always undefined, so resume never
// worked on this path. `sessionId` (camelCase) is real, but on the transcript JSONL shape, a
// different, adjacent format -- almost certainly how the two got crossed.
import { describe, it, expect } from 'vitest'
import { extractInitSessionId } from '../agent.js'

describe('extractInitSessionId', () => {
  it('reads session_id (the real SDK field)', () => {
    expect(extractInitSessionId({ session_id: 'abc-123' })).toBe('abc-123')
  })

  it('is undefined when session_id is absent (was silently always-undefined via the wrong field before)', () => {
    expect(extractInitSessionId({})).toBeUndefined()
  })

  it('ignores a camelCase sessionId sibling field -- session_id is the only source of truth', () => {
    expect(extractInitSessionId({ sessionId: 'wrong-field' } as never)).toBeUndefined()
  })

  it('is undefined for a non-string session_id rather than throwing', () => {
    expect(extractInitSessionId({ session_id: 12345 } as never)).toBeUndefined()
  })
})
