// Card 22835648 (Rename 1/3 of the CleanCore-name retirement, Peti 2026-10-11 Telegram 11045/11048).
// TS counterpart of store/env-compat-lib.selftest.sh -- same cases, same precedence.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { envCompatGet } from '../env-compat.js'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const NEW = 'MY_TEST_NEW_VAR'
const OLD = 'MY_TEST_OLD_VAR'

describe('envCompatGet', () => {
  let savedNew: string | undefined
  let savedOld: string | undefined

  beforeEach(() => {
    savedNew = process.env[NEW]
    savedOld = process.env[OLD]
    delete process.env[NEW]
    delete process.env[OLD]
  })

  afterEach(() => {
    if (savedNew === undefined) delete process.env[NEW]; else process.env[NEW] = savedNew
    if (savedOld === undefined) delete process.env[OLD]; else process.env[OLD] = savedOld
  })

  it('new var wins over old', () => {
    process.env[NEW] = 'new-value'
    process.env[OLD] = 'old-value'
    expect(envCompatGet(NEW, OLD, 'default')).toBe('new-value')
  })

  it('old var used when new is unset', () => {
    process.env[OLD] = 'old-value'
    expect(envCompatGet(NEW, OLD, 'default')).toBe('old-value')
  })

  it('warns (via logger.warn) when falling back to the old var, naming both names', async () => {
    const { logger } = await import('../logger.js')
    process.env[OLD] = 'old-value'
    envCompatGet(NEW, OLD, 'default')
    expect(logger.warn).toHaveBeenCalled()
    const [, msg] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [unknown, string]
    expect(msg).toContain(OLD)
    expect(msg).toContain(NEW)
  })

  it('warns on every fallback call -- no cross-call de-dup', async () => {
    const { logger } = await import('../logger.js')
    process.env[OLD] = 'old-value'
    const before = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.length
    envCompatGet(NEW, OLD, 'default')
    envCompatGet(NEW, OLD, 'default')
    const after = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.length
    expect(after - before).toBe(2)
  })

  it('default used when neither is set', () => {
    expect(envCompatGet(NEW, OLD, 'default')).toBe('default')
  })

  it('empty string when neither is set and no default given', () => {
    expect(envCompatGet(NEW, OLD)).toBe('')
  })

  it('an empty (blank) new var falls through to old, same as unset', () => {
    process.env[NEW] = ''
    process.env[OLD] = 'old-value'
    expect(envCompatGet(NEW, OLD, 'default')).toBe('old-value')
  })
})
