import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureIngestToken } from '../ingest-token.js'

let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('ensureIngestToken', () => {
  it('creates a new 32-byte (64 hex char) token when the file does not exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'ingest-token-'))
    const path = join(dir, 'nested', '.ingest-token')
    const token = ensureIngestToken(path)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('creates the parent directory if missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'ingest-token-'))
    const path = join(dir, 'a', 'b', 'c', '.ingest-token')
    ensureIngestToken(path)
    expect(statSync(join(dir, 'a', 'b', 'c')).isDirectory()).toBe(true)
  })

  it('writes the file with 0600 permissions', () => {
    dir = mkdtempSync(join(tmpdir(), 'ingest-token-'))
    const path = join(dir, '.ingest-token')
    ensureIngestToken(path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('returns the SAME token on repeated calls (persisted, not regenerated)', () => {
    dir = mkdtempSync(join(tmpdir(), 'ingest-token-'))
    const path = join(dir, '.ingest-token')
    const first = ensureIngestToken(path)
    const second = ensureIngestToken(path)
    expect(second).toBe(first)
  })
})
