import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

// Same pattern as store/.dashboard-token elsewhere in this fleet: a local, gitignored, 0600
// secret file, generated on first use rather than shipped or hand-typed. The extension's options
// page is where Peti copies this value in ONCE.
export function ensureIngestToken(tokenPath: string): string {
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, 'utf-8').trim()
    if (existing) return existing
  }
  const token = randomBytes(32).toString('hex')
  mkdirSync(dirname(tokenPath), { recursive: true })
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 })
  return token
}
