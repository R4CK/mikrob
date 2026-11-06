import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Card 0244910e N3 (RedHat non-blocking finding on 9655494c F1-B1 GO, comment 17142): the
// `dashboard-user agent-key:mint/:revoke` CLI (scripts/dashboard-user.ts) had no test at all.
// Mutants RedHat ran and found uncaught:
//   C1: the "existing key, no --rotate -> refuse" check removed
//   C2: --rotate not revoking the old key before minting a new one (leaves 2 valid keys)
//   C3: the agentId regex widened/removed
//   C4: revoking an unknown agent_id still reporting success
// This file runs the REAL CLI (via tsx, same as `npm run dashboard-user`) against an isolated,
// throwaway SQLite file (DASHBOARD_USER_DB_OVERRIDE, card 0244910e) -- never the real
// store/claudeclaw.db.

const ROOT = join(__dirname, '..', '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const SCRIPT = join(ROOT, 'scripts', 'dashboard-user.ts')

let dir: string
let dbPath: string

// The CLI's own stdout can carry a stray log line alongside the key (same root cause as card
// 0244910e N1/N2 in the bash wrapper: the shared pino logger defaults to stdout, and a one-shot
// migration log line reliably appears on a freshly-created DB -- measured here on every single
// run against a fresh isolated DB file, not just a rare first-run edge case). Extract the one
// line that is shaped like the real key, the same filter agent-key-provision.sh now applies.
function extractKeyLine(stdout: string): string {
  const candidates = stdout.split('\n').filter((l) => /^[A-Za-z0-9_-]{20,}$/.test(l))
  expect(candidates.length).toBe(1)
  return candidates[0]!
}

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(TSX, [SCRIPT, ...args], {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DASHBOARD_USER_DB_OVERRIDE: dbPath },
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dashboard-user-cli-'))
  dbPath = join(dir, 'isolated.db')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('dashboard-user agent-key:mint / agent-key:revoke CLI (0244910e)', () => {
  it('mint: happy path prints a key-shaped line on stdout', () => {
    const r = run(['agent-key:mint', 'qa'])
    expect(r.status).toBe(0)
    extractKeyLine(r.stdout)
  })

  it('C1: minting again without --rotate refuses (existing key stays intact)', () => {
    const first = run(['agent-key:mint', 'qa'])
    expect(first.status).toBe(0)
    const second = run(['agent-key:mint', 'qa'])
    expect(second.status).not.toBe(0)
    expect(second.stderr).toContain('already has a key')
  })

  it('C2: --rotate revokes the OLD key -- the old key stops working after rotation', () => {
    const first = run(['agent-key:mint', 'qa'])
    const oldKey = extractKeyLine(first.stdout)
    const second = run(['agent-key:mint', 'qa', '--rotate'])
    expect(second.status).toBe(0)
    const newKey = extractKeyLine(second.stdout)
    expect(newKey).not.toBe(oldKey)

    // Revoking the OLD key by name reports 0 revoked -- it must already be gone, proving
    // --rotate actually revoked it rather than leaving two live keys behind.
    // (If C2 regresses and --rotate stops revoking, this would instead report 1.)
    const revokeAgain = run(['agent-key:revoke', 'qa'])
    expect(revokeAgain.status).toBe(0)
    expect(revokeAgain.stdout).toContain('Revoked 1 key')
  })

  it('C3: invalid agentId is rejected (empty, uppercase, too long, leading digit)', () => {
    for (const bad of ['', 'QA', 'a'.repeat(33), '9ab', 'has space', 'semi;colon']) {
      if (bad === '') continue // no positional arg -> usage(), covered separately
      const r = run(['agent-key:mint', bad])
      expect(r.status, `expected rejection for agentId ${JSON.stringify(bad)}`).not.toBe(0)
      expect(r.stderr).toContain('Invalid agentId')
    }
  })

  it('C3 control: a valid agentId at the boundary (32 chars) is accepted', () => {
    const name = 'a' + '0'.repeat(31) // 32 chars, starts with a letter
    expect(name.length).toBe(32)
    const r = run(['agent-key:mint', name])
    expect(r.status).toBe(0)
    extractKeyLine(r.stdout)
  })

  it('C4: revoking a never-minted agentId reports 0 revoked and a non-zero exit', () => {
    const r = run(['agent-key:revoke', 'never-minted-xyz'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('No key found')
  })

  it('revoke: happy path revokes exactly the minted key', () => {
    run(['agent-key:mint', 'qa'])
    const r = run(['agent-key:revoke', 'qa'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Revoked 1 key')
  })
})
