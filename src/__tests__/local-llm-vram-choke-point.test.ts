// store/local-llm.sh: a VRAM choke-point ahead of every `generate` call (card 234306ca,
// plan-grilling GO-WITH-CHANGES, MikroB decision comment 6511).
//
// WHY THIS EXISTS. Each of the 6 local-LLM dispatchers already calls vram-guard-check.sh itself
// before deciding to route to the local model (card f9bad591's option A, kept as-is this round,
// defense-in-depth). That protects only the dispatchers that remember to add the same five-line
// block. This choke point protects a FUTURE dispatcher that does not: every caller of `generate`
// passes through local-llm.sh regardless, so the check runs even for one that never heard of
// vram-guard-check.sh.
//
// REUSES THE EXISTING EXIT-6 "GPU BUSY" CONVENTION (see local-llm-busy-status-log.test.ts) rather
// than inventing a new signal -- none of the 6 dispatchers check a specific exit code from their
// own vram-guard-check.sh call, they all treat any nonzero as HOLD, so this costs nothing.
//
// THE GUARD'S OWN LINE MUST SURVIVE, VERBATIM (MikroB's explicit requirement): a dispatcher that
// still has its own direct call gets the line from that call unchanged; one that does not gets it
// from local-llm.sh's stderr instead, in the same place every other die() message goes.
//
// END TO END, not source-level, same pattern as local-llm-busy-status-log.test.ts: the script is
// copied into a sandbox so $HERE is isolated, and LOCAL_LLM_VRAM_GUARD points at a fake guard
// binary the test controls -- no real GPU or ollama needed, since the choke point runs before any
// network call.
import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, copyFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
let sandbox: string

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'llm-vram-choke-'))
  copyFileSync(join(ROOT, 'store', 'local-llm.sh'), join(sandbox, 'local-llm.sh'))
  mkdirSync(join(sandbox, 'local-llm-skills'))
  writeFileSync(join(sandbox, 'local-llm-model'), 'stub-model:latest\n')
})

function fakeGuard(sandboxDir: string, name: string, stdout: string, exitCode: number): string {
  const p = join(sandboxDir, name)
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(stdout)}\nexit ${exitCode}\n`)
  chmodSync(p, 0o755)
  return p
}

function run(guard: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(
    'bash',
    [join(sandbox, 'local-llm.sh'), '--caller', 'backend3', '--source', 'test', 'draft this'],
    {
      encoding: 'utf-8',
      timeout: 15_000,
      env: { ...process.env, OLLAMA_HOST: 'http://127.0.0.1:1', LOCAL_LLM_VRAM_GUARD: guard, ...extraEnv },
    },
  )
}

describe('local-llm.sh: VRAM choke-point ahead of generate (card 234306ca)', () => {
  it('HOLD exits 6 and puts the guard\'s own line on stderr, verbatim', () => {
    const guard = fakeGuard(sandbox, 'guard-hold.sh', 'HOLD critical 23000/24000 MiB (96%)', 1)
    const r = run(guard)
    expect(r.status).toBe(6)
    expect(r.stderr).toContain('HOLD critical 23000/24000 MiB (96%)')
  })

  it('a real ollama-side failure never happens here -- HOLD is caught before any network call', () => {
    // OLLAMA_HOST points at a closed port (127.0.0.1:1); if the choke point did not short-circuit
    // BEFORE the network call, the failure would come back as an ollama/timeout error, not exit 6
    // with the guard's own line -- this is the case that proves the ORDER, not just the outcome.
    const guard = fakeGuard(sandbox, 'guard-hold2.sh', 'HOLD warn 20000/24000 MiB (83%)', 1)
    const r = run(guard)
    expect(r.status).toBe(6)
    expect(r.stderr).not.toMatch(/ollama api error/)
  })

  it('ADMIT (exit 0) does not short-circuit -- the call proceeds to the (here unreachable) ollama step', () => {
    const guard = fakeGuard(sandbox, 'guard-admit.sh', 'ADMIT ok 4000/24000 MiB (16%)', 0)
    const r = run(guard)
    // OLLAMA_HOST is a closed port, so the call fails LATER, on the real network step -- never 6,
    // and never the guard's own HOLD line, proving ADMIT does not trip the choke point at all.
    expect(r.status).not.toBe(6)
    expect(r.stderr ?? '').not.toContain('MiB')
  })

  it('a MISSING guard binary does not block generate (fail-open on absence, matching every dispatcher)', () => {
    const missing = join(sandbox, 'does-not-exist.sh')
    const r = run(missing)
    expect(r.status).not.toBe(6)
  })
})
