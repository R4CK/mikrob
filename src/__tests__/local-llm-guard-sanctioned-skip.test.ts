// Card 970156ce: the landing gate may go quiet for a SANCTIONED mask, and for nothing else.
//
// THE COLLISION THIS CLOSES. gpu-crashloop-guard.sh stops and masks ollama.service when the WSL VM
// short-boots on dxgkrnl GPU faults -- correct protection. Two cases in
// store/local-llm-model-routing.selftest.sh need Ollama to ANSWER, and that selftest runs inside
// fleet-test.sh, the gate on every landing. So while the machine was being protected, nobody in the
// fleet could land anything, whatever they had changed.
//
// WHY THIS FILE EXISTS AT ALL, and it is the whole point of the card (MikroB, comment 21246, on
// Cybersec's objection): the easy fix -- "Ollama did not answer, skip" -- buys the unblock by
// making the gate unable to tell a protected machine from a broken one. A gate that only ever goes
// quiet is indistinguishable from a gate that was deleted. So the skip is conditioned on INTENT,
// evidenced by the artefact the guard writes, and the direction that MUST STILL FAIL is pinned here
// rather than left to the reader's confidence.
//
// DETERMINISM: every case forces OLLAMA_HOST at a dead loopback port, so the assertions do not
// depend on whether the real Ollama happens to be up while the suite runs. Without that, control 1
// would silently become vacuous the moment someone unmasks the service.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SELFTEST = join(REPO_ROOT, 'store', 'local-llm-model-routing.selftest.sh')
const DEAD_OLLAMA = 'http://127.0.0.1:1'

let stateDir: string

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'gpu-guard-flag-'))
})
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

function writeFlag(content: string): void {
  writeFileSync(join(stateDir, '.gpu-crashloop-guard-masked.json'), content, 'utf-8')
}

/** Run the selftest with a dead Ollama and whatever flag state the case set up. */
function runSelftest(): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [SELFTEST], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 120_000,
      env: { ...process.env, OLLAMA_HOST: DEAD_OLLAMA, GPU_GUARD_STATE_DIR: stateDir },
    })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe('the routing selftest skips only for a SANCTIONED mask (card 970156ce)', () => {
  it('NO flag + Ollama down still FAILS -- the real-regression case is not absorbed', () => {
    // The mandatory negative control. If this ever goes green, the gate stopped asking about
    // intent and started asking about reachability, which is the fix that was rejected.
    const { code, out } = runSelftest()
    expect(code).not.toBe(0)
    expect(out).toContain('[FAIL]')
    expect(out).not.toContain('[skip]')
  })

  it('a flag naming ollama.service SKIPS those cases and PRINTS the recorded reason', () => {
    writeFlag(
      JSON.stringify({
        detected_at: 1788683875,
        short_boots: 3,
        units: 'ollama.service',
        reason: 'dxgkrnl GPU-passthrough crash-loop',
      })
    )
    const { code, out } = runSelftest()
    expect(code).toBe(0)
    expect(out).toContain('[skip]')
    // The REASON travels, not just the fact of a skip: an operator reading a landing log has to be
    // able to tell this from a test that was quietly deleted.
    expect(out).toContain('dxgkrnl GPU-passthrough crash-loop')
    expect(out).not.toContain('[FAIL]')
  })

  it('the summary still satisfies the wrapper, so a skipped run cannot pass on zero cases', () => {
    // store-selftests-all-run.test.ts requires a NON-ZERO passed count precisely so a selftest that
    // skipped everything cannot report a happy summary over nothing. This asserts the shape the
    // wrapper matches, on a run that DID skip.
    writeFlag(JSON.stringify({ units: 'ollama.service', reason: 'guard test' }))
    const { out } = runSelftest()
    expect(out).toMatch(/selftest: [1-9]\d* passed, 0 failed/)
  })

  it('the flag path resolves through the SHARED state-dir helper, not a second invented path', () => {
    // A CONFIGURATION PIN, and it covers the one thing the cases above cannot: they all set
    // GPU_GUARD_STATE_DIR, so none of them exercises how the path is resolved when nobody does.
    // Measured while building this, and it is why the pin exists: reading $HERE found no flag on a
    // machine where the guard had masked ollama an hour earlier, because the guard writes to the
    // running INSTALL's store while this selftest executes from an agent WORKTREE. Every case would
    // have stayed red and the fix would have looked done while changing nothing. Asserting against
    // the real resolved directory is not an option -- that would mean writing a flag into the live
    // install -- so what is pinned is that the script asks the same helper local-llm.sh asks.
    const src = readFileSync(SELFTEST, 'utf-8')
    expect(src).toContain('local-llm-state-dir.sh')
    expect(src).toContain('resolve_local_llm_state_dir')
    expect(src).toContain('LOCAL_LLM_STATE_RESOLVED')

    // AND it must NOT honour that resolver's `env` branch, which is the half that made the first
    // cut useless: the suite sets LOCAL_LLM_STATE_DIR per worker (card 4c5c540c) to keep test runs
    // of local-llm.sh out of the live ledger, so resolving through it points the flag lookup at an
    // empty temp dir -- inside fleet-test, the only place this fix has to work, nothing would ever
    // be skipped. The unset therefore has to happen, and it has to happen in a SUBSHELL: doing it
    // in this shell would strip the isolation from the local-llm.sh calls the selftest makes below
    // and reopen the production-ledger defect 4c5c540c closed. Verified by hand at the time this
    // landed -- the live store/local-llm-usage.log was byte-unchanged across a full suite run.
    expect(src).toContain('unset LOCAL_LLM_STATE_DIR')
    expect(src).toMatch(/GPU_GUARD_STATE="\$\(\s*\n\s*unset LOCAL_LLM_STATE_DIR/)
  })

  it('a flag naming a DIFFERENT unit does not license this skip', () => {
    writeFlag(JSON.stringify({ units: 'some-other.service', reason: 'unrelated' }))
    const { code, out } = runSelftest()
    expect(code).not.toBe(0)
    expect(out).toContain('[FAIL]')
  })

  it('a unit that merely CONTAINS the name is not the name (whole-token match)', () => {
    // CLAUDE.md code-quality rule 12: a substring test would accept this and skip on a mask that
    // never named this service. `units` is the guard's space-joined "${UNITS[*]}", so the check
    // splits and compares whole tokens.
    writeFlag(JSON.stringify({ units: 'not-ollama.service', reason: 'lookalike' }))
    const { code } = runSelftest()
    expect(code).not.toBe(0)
  })

  it('a malformed flag is not a sanctioned mask -- unreadable state fails CLOSED', () => {
    writeFlag('{ this is not json')
    const { code } = runSelftest()
    expect(code).not.toBe(0)
  })

  it('a sanctioned flag with NO reason still skips, and says so rather than printing nothing', () => {
    // The reason is operator-facing text from an artefact this file does not control. Missing text
    // must not turn into an empty line that reads like a bug in the skip itself.
    writeFlag(JSON.stringify({ units: 'ollama.service' }))
    const { code, out } = runSelftest()
    expect(code).toBe(0)
    expect(out).toContain('[skip]')
    expect(out).toContain('no reason recorded')
  })
})
