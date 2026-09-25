// card 5b06720f: initDatabase() used to let a missing/broken better-sqlite3 native binding
// (e.g. after a stray pnpm/yarn install moved it into node_modules/.ignored) surface as a raw,
// generic "Could not locate the bindings file" error with no hint at the real cause -- the process
// then crash-loops on boot with nothing actionable to act on. This pins the speaking rewrap.
//
// The mock extends the REAL better-sqlite3 class and only intercepts one sentinel path, so every
// other test in this file (and every other test file, since vi.mock is file-scoped) still opens a
// genuine on-disk/':memory:' database exactly as before -- this is not a fake DB layer.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TMP = mkdtempSync(join(tmpdir(), 'db-native-binding-test-'))
const THROW_PATH = join(TMP, 'trigger-binding-error.db')

vi.mock('better-sqlite3', async () => {
  const actual = (await vi.importActual('better-sqlite3')) as { default: unknown }
  const RealDatabase = actual.default as new (...args: unknown[]) => unknown
  function FakeDatabase(this: unknown, path: string, ...rest: unknown[]): unknown {
    if (path === THROW_PATH) {
      throw new Error('Could not locate the bindings file. Tried:\n -> fake/path/better_sqlite3.node')
    }
    return new RealDatabase(path, ...rest)
  }
  return { ...actual, default: FakeDatabase as unknown as new (...args: unknown[]) => unknown }
})

const { initDatabase } = await import('../db.js')

describe('db.ts speaks a clear error when the native binding is missing (card 5b06720f)', () => {
  it('wraps a bindings-file error with actionable guidance, preserving the original as cause', () => {
    let caught: unknown
    try {
      initDatabase(THROW_PATH)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/better-sqlite3 native binding missing or broken/)
    expect((caught as Error).message).toMatch(/npm ci/)
    expect((caught as Error).cause).toBeInstanceOf(Error)
    expect(((caught as Error).cause as Error).message).toMatch(/bindings file/)
  })

  it('does not interfere with a normal, successful open', () => {
    const dbPath = join(TMP, 'real.db')
    expect(() => initDatabase(dbPath)).not.toThrow()
  })

  it('MUTATION-PROOF: an unrelated error is not rewrapped with the binding-specific message', () => {
    let caught: unknown
    try {
      initDatabase(join(TMP, 'does', 'not', 'exist', 'test.db'))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).not.toMatch(/native binding missing or broken/)
  })
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})
