import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, saveMemory } from '../db.js'
import { buildMemoryContext, MEMORY_CONTENT_MAX_CHARS } from '../memory.js'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

// Each test uses its own chatId so recentMemories() never bleeds across tests.
let chatSeq = 0
function freshChat(): string {
  return `truncation-test-${++chatSeq}`
}

describe('buildMemoryContext content truncation (card 4f87d517)', () => {
  it('short content passes through unchanged', async () => {
    const chat = freshChat()
    const content = 'Rövid emlékezés, bőven a limit alatt.'
    saveMemory(chat, content, 'semantic', 'rövid')
    const ctx = await buildMemoryContext(chat, 'rövid')
    expect(ctx).toContain(content)
    expect(ctx).not.toMatch(/…\(\+\d+ karakter\)/)
  })

  it('content one char over the limit is truncated with a count signal', async () => {
    const chat = freshChat()
    const longContent = 'A'.repeat(MEMORY_CONTENT_MAX_CHARS + 1)
    saveMemory(chat, longContent, 'semantic', 'overlong')
    const ctx = await buildMemoryContext(chat, 'overlong')
    expect(ctx).toContain('A'.repeat(MEMORY_CONTENT_MAX_CHARS))
    expect(ctx).toContain('…(+1 karakter)')
    expect(ctx).not.toContain(longContent)
  })

  it('heavily overlong content shows correct remainder count', async () => {
    const chat = freshChat()
    const extra = 250
    const longContent = 'B'.repeat(MEMORY_CONTENT_MAX_CHARS + extra)
    saveMemory(chat, longContent, 'semantic', 'heavily-overlong')
    const ctx = await buildMemoryContext(chat, 'heavily-overlong')
    expect(ctx).toContain(`…(+${extra} karakter)`)
    expect(ctx).not.toContain(longContent)
  })

  it('only the prefix up to MAX_CONTENT_CHARS appears before the signal', async () => {
    const chat = freshChat()
    const prefix = 'C'.repeat(MEMORY_CONTENT_MAX_CHARS)
    const suffix = 'XXXXXXXXXX'
    saveMemory(chat, prefix + suffix, 'semantic', 'prefix')
    const ctx = await buildMemoryContext(chat, 'prefix')
    expect(ctx).toContain(prefix)
    expect(ctx).not.toContain(suffix)
  })

  it('returns empty string when no memories exist for the chatId', async () => {
    const ctx = await buildMemoryContext('no-such-chat-xyz-truncation', 'anything')
    expect(ctx).toBe('')
  })

  it('multiple entries: only the long one gets a truncation signal', async () => {
    const chat = freshChat()
    const short = 'Rövid.'
    const long = 'D'.repeat(MEMORY_CONTENT_MAX_CHARS + 100)
    saveMemory(chat, short, 'semantic', 'short-multi')
    saveMemory(chat, long, 'semantic', 'long-multi')
    const ctx = await buildMemoryContext(chat, 'short-multi long-multi')
    expect(ctx).toContain(short)
    expect(ctx).toContain('…(+100 karakter)')
    // Short entry must appear without a truncation signal next to it
    const shortLine = ctx.split('\n').find((l) => l.includes(short))
    expect(shortLine).toBeDefined()
    expect(shortLine).not.toMatch(/…\(\+\d+ karakter\)/)
  })
})
