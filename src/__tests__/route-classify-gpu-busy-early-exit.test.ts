// Card 9874e359. Peti reported a wall of failed route-triage rows on the local-LLM panel. The cause
// is not one failure, it is AMPLIFICATION: route-classify.sh splits a long task into up to nine
// overlapping windows and asks the model about each, and when the shared GPU flock is held every one
// of those calls waits out its full LOCK_WAIT (~22s) and fails. Measured on the live board before
// the fix: 17 contention episodes produced 107 failed route-triage rows -- 6.3 per episode, 29 in
// the worst, each ~22s -- and the verdict was UNKNOWN either way.
//
// These tests RUN the script against a fake local-llm.sh and count invocations, rather than grepping
// the source for a flag. The distinction that matters is behavioural: the loop must stop for a BUSY
// GPU (exit 6, local-llm.sh's own name for "the flock was still held") and must NOT stop for an
// ordinary failed or unparseable answer, which is evidence about that window only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'store',
  'route-classify.sh'
)

/** Long enough to be split into several windows (WINDOW=120, STRIDE=60, first 600 chars used). */
const LONG_TASK = 'refactor the helper that formats a duration into words. '.repeat(11)

let dir: string

/** A stand-in local-llm.sh that records every invocation and answers however the test needs. */
function fakeLlm(body: string): string {
  const p = join(dir, 'fake-llm.sh')
  writeFileSync(p, `#!/usr/bin/env bash\necho call >> "${join(dir, 'calls')}"\n${body}\n`, 'utf-8')
  chmodSync(p, 0o755)
  return p
}

function run(llm: string): { out: string; calls: number; log: string } {
  const logPath = join(dir, 'verdict.log')
  const out = execFileSync('bash', [SCRIPT, LONG_TASK], {
    encoding: 'utf-8',
    env: { ...process.env, ROUTE_CLASSIFY_LLM: llm, ROUTE_CLASSIFY_LOG: logPath },
  }).trim()
  const callsFile = join(dir, 'calls')
  const calls = existsSync(callsFile)
    ? readFileSync(callsFile, 'utf-8').split('\n').filter(Boolean).length
    : 0
  return { out, calls, log: existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '' }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'route-classify-9874e359-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('route-classify stops asking once the GPU is known busy (card 9874e359)', () => {
  it('BASELINE: the task really is split into several windows, so the count below means something', () => {
    // Without this, a fix that made the loop ask exactly once for EVERY input would look identical
    // to the fix under test. The MECHANICAL answer is the one that does not short-circuit the loop.
    const { out, calls } = run(fakeLlm('echo MECHANICAL'))
    expect(out).toBe('MECHANICAL')
    expect(calls).toBeGreaterThan(1)
  })

  it('THE FIX: a GPU-busy exit stops the loop after ONE call, instead of one per window', () => {
    const { out, calls } = run(fakeLlm('exit 6'))
    expect(calls).toBe(1)
    // The verdict is unchanged -- this is a latency and noise fix, not a routing change.
    expect(out).toBe('UNKNOWN')
  })

  it('the abstain is written to the audit trail under its OWN name, not folded into `windowed`', () => {
    // The file's whole reason for logging (Cybered's third finding) is that a control which did not
    // run must not look like a control that ran and had no objection. "GPU busy" is a third thing.
    const { log } = run(fakeLlm('exit 6'))
    expect(log).toContain('gpu-busy')
    expect(log).toContain('UNKNOWN')
  })

  it('DISCRIMINATION: an ordinary failure does NOT stop the loop -- only the GPU-busy status does', () => {
    // exit 1 with no output is "the model had nothing useful for THIS window", which says nothing
    // about the next one. Folding every failure into the early exit would silently reduce the
    // classifier to a single-window check on every unhealthy call.
    const { out, calls } = run(fakeLlm('exit 1'))
    expect(calls).toBeGreaterThan(1)
    expect(out).toBe('UNKNOWN')
  })

  it('an unparseable ANSWER also keeps the loop going (exit 0, nothing recognisable)', () => {
    const { calls, out } = run(fakeLlm("echo 'I am not sure about this one'; exit 0"))
    expect(calls).toBeGreaterThan(1)
    expect(out).toBe('UNKNOWN')
  })

  it('SECURITY still wins on the first window and still short-circuits (unchanged)', () => {
    const { out, calls } = run(fakeLlm('echo SECURITY'))
    expect(out).toBe('SECURITY')
    expect(calls).toBe(1)
  })

  it('the caller contract is intact: the script still exits 0 and prints one of the three words', () => {
    for (const [body, expected] of [
      ['exit 6', 'UNKNOWN'],
      ['echo MECHANICAL', 'MECHANICAL'],
      ['echo SECURITY', 'SECURITY'],
    ] as const) {
      rmSync(join(dir, 'calls'), { force: true })
      expect(run(fakeLlm(body)).out, body).toBe(expected)
    }
  })
})
