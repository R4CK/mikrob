// Card 52114c2f (CYBERSEC NO-GO 34686/34694, F4; extended by QA 34710/34711): mutation-tested
// with real vitest mutants against store/agent-auth-header.sh -- H1 (own-key branch disabled),
// H2 (shared-token fallback check removed) and H3 (wrong key file path) all SURVIVED when only
// this card's own targeted file set ran (8 files / 126 tests), because none of those files
// executes the script. The shell selftest (store/agent-auth-header.selftest.sh) kills all three,
// but it only runs via the full-suite auto-discovery in store-selftests-all-run.test.ts -- a
// delta re-gate that names a targeted file list (the fleet's own convention, see memory
// "Delta re-gate: verify only the changed part") would not include that discovery file and would
// miss a regression in any of these three behaviours. This file execs the real script directly
// so the same three behaviours are pinned even in a targeted run.
//
// QA 34710/34711 (same Gate-SHA, 407f2feb9): the H1-H3 pin above left F2 (caller binding) and F3
// (revoked/junk-key fallback) uncovered by this same targeted-run reasoning -- a later edit could
// silently reopen either without any test in this file's own set going red. Added below.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(__dirname, '..', '..', 'store', 'agent-auth-header.sh')

let work: string

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'agent-auth-header-behaviour-'))
  mkdirSync(join(work, 'agents', 'backend'), { recursive: true })
  mkdirSync(join(work, 'main', 'store'), { recursive: true })
  writeFileSync(join(work, 'main', 'store', '.dashboard-token'), 'shared-token-value')
})

afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

function run(agent: string, env: Record<string, string> = {}): { out: string; status: number } {
  try {
    const out = execFileSync('bash', [SCRIPT, agent], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        MARVEEN_AGENTS_ROOT: join(work, 'agents'),
        MARVEEN_MAIN: join(work, 'main'),
        MARVEEN_AGENT_ID: 'backend',
        // Closed port: the probe added for F3 cannot complete, so it never overrides the
        // own-key-used behaviour these mutants target.
        AGENT_AUTH_HEADER_PROBE_URL: 'http://127.0.0.1:1/unreachable',
        AGENT_AUTH_HEADER_PROBE_TIMEOUT: '1',
        ...env,
      },
      encoding: 'utf8',
    })
    return { out: out.trim(), status: 0 }
  } catch (err) {
    const e = err as { status?: number; stdout?: string }
    return { out: (e.stdout ?? '').trim(), status: e.status ?? 1 }
  }
}

describe('store/agent-auth-header.sh behaviour (card 52114c2f F4, pinned via real execFileSync)', () => {
  it('H1: uses the agent\'s OWN key when the file is present (not the shared token)', () => {
    writeFileSync(join(work, 'agents', 'backend', '.dashboard-agent-key'), 'own-agent-key-value')
    const { out, status } = run('backend')
    expect(status).toBe(0)
    expect(out).toBe('Authorization: Bearer own-agent-key-value')
  })

  it('H2: fails closed (exit 4, nothing on stdout) when neither a key nor the shared token exists', () => {
    rmSync(join(work, 'main', 'store', '.dashboard-token'))
    const { out, status } = run('backend')
    expect(status).toBe(4)
    expect(out).toBe('')
  })

  it('H3: reads the REQUESTED agent\'s own key file, not a different one', () => {
    writeFileSync(join(work, 'agents', 'backend', '.dashboard-agent-key'), 'backend-key-value')
    mkdirSync(join(work, 'agents', 'qa2'), { recursive: true })
    writeFileSync(join(work, 'agents', 'qa2', '.dashboard-agent-key'), 'qa2-key-value')
    const { out, status } = run('backend')
    expect(status).toBe(0)
    expect(out).toBe('Authorization: Bearer backend-key-value')
    expect(out).not.toContain('qa2-key-value')
  })

  it('F2: refuses (exit 2, nothing on stdout) when the caller requests ANOTHER agent\'s key', () => {
    mkdirSync(join(work, 'agents', 'qa2'), { recursive: true })
    writeFileSync(join(work, 'agents', 'qa2', '.dashboard-agent-key'), 'qa2-key-value')
    // run() already sets MARVEEN_AGENT_ID=backend; request qa2's key instead.
    const { out, status } = run('qa2')
    expect(status).toBe(2)
    expect(out).toBe('')
  })

  describe('F3: revoked/junk-key fallback (real HTTP probe)', () => {
    let server: Server
    let probeUrl: string

    beforeEach(async () => {
      server = createServer((req, res) => {
        const auth = req.headers.authorization ?? ''
        res.statusCode = auth === 'Bearer revoked-key-value' ? 401 : 200
        res.end()
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      probeUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agents`
    })

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    it('a revoked (401) own key falls back to the shared token, with a distinct warning', () => {
      writeFileSync(join(work, 'agents', 'backend', '.dashboard-agent-key'), 'revoked-key-value')
      // Card 52114c2f (QA 34710/34711 pin, measured under fleet-test's shared, contended
      // sandbox): the mock listens fine, but a 3s --max-time occasionally elapsed before curl's
      // own process got scheduled, so the probe came back inconclusive ("000") instead of 401 --
      // the SAME benign under-load flake this sandbox's own fleet-test.sh documents for vitest's
      // birpc timeout (card 54699bbb). 10s gives real headroom without masking a logic bug: the
      // probe's OUTCOME (401 vs 200) is still exactly what this test asserts on.
      // Round-4 re-measurement (2026-11-20): the 10s curl --max-time above is itself longer than
      // vitest's own default 5000ms per-test timeout, so under heavier contention the TEST died
      // first ("Test timed out in 5000ms") before curl's own allowance ran out -- the 10s fix was
      // incomplete without raising this test's own timeout to match.
      const { out, status } = run('backend', { AGENT_AUTH_HEADER_PROBE_URL: probeUrl, AGENT_AUTH_HEADER_PROBE_TIMEOUT: '10' })
      expect(status).toBe(0)
      expect(out).toBe('Authorization: Bearer shared-token-value')
    }, 15000)

    it('a valid (200) own key is used as-is, not the shared token', () => {
      writeFileSync(join(work, 'agents', 'backend', '.dashboard-agent-key'), 'own-agent-key-value')
      const { out, status } = run('backend', { AGENT_AUTH_HEADER_PROBE_URL: probeUrl, AGENT_AUTH_HEADER_PROBE_TIMEOUT: '10' })
      expect(status).toBe(0)
      expect(out).toBe('Authorization: Bearer own-agent-key-value')
    }, 15000)
  })
})
