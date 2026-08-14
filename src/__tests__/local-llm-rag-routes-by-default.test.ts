// store/local-llm-rag.sh routes by DEFAULT, not behind --auto (card e817817c).
//
// The finding (mine, alongside c7a0c142's router work; independently confirmed by Cybered on that
// card's gate): routeTask() correctly refuses authz/architecture work, but the wrapper only called
// it when the caller passed --auto -- and NO documented fleet call passed it. Not the
// local-llm-offload skill, not offload-dispatch's per-agent instructions, not any agent's own
// CLAUDE.md, not the central one (line 274). So on every path an agent actually used, the gate was
// absent and an authz task could reach the 7B unjudged.
//
// Fixed in the code rather than in the docs: a doc fix has to be repeated for the next new agent or
// skill, a default cannot be forgotten. This test pins the default so a later edit cannot quietly
// put the gate back behind a flag.
//
// Behavioural, not source-level: the router runs before the token read and before any ollama call,
// so the real script can be executed here with no local model up.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', '..', 'store', 'local-llm-rag.sh')
const ROUTER_BUILD = join(HERE, '..', '..', 'dist', 'local-llm-router.js')

/** A task routeTask() must refuse: the authz signal family. Never reaches the model. */
const AUTHZ_TASK = 'change the tenant authorization check so it grants access'

function run(script: string, args: readonly string[]): { status: number; stderr: string } {
  try {
    execFileSync('bash', [script, ...args], { encoding: 'utf-8', stdio: 'pipe' })
    return { status: 0, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stderr?: string }
    return { status: err.status ?? -1, stderr: String(err.stderr ?? '') }
  }
}

/** Same, with env and stdout -- the advisory path (card ee43a6ac) is configured by env and prints
 *  its banner on stdout, next to the draft, because the two must never travel separately. */
function runEnv(
  script: string,
  args: readonly string[],
  env: Record<string, string>,
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bash', [script, ...args], {
      encoding: 'utf-8',
      stdio: 'pipe',
      env: { ...process.env, ...env },
      timeout: 120_000,
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? -1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

// The routing assertions below need the compiled router; without it every call routes online for a
// DIFFERENT reason (the missing-build branch) and they would pass vacuously. Each one therefore also
// asserts the reason it got, and the whole group is skipped when there is no build to judge with.
describe.skipIf(!existsSync(ROUTER_BUILD))('local-llm-rag.sh routes without --auto (card e817817c)', () => {
  it('refuses an authz task on the DEFAULT path -- no --auto, no --difficulty', () => {
    const r = run(SCRIPT, ['--show-context', '--agent', 'mikrob', AUTHZ_TASK])
    expect(r.status).toBe(9) // 9 = routed online
    expect(r.stderr).toContain('ROUTE=online')
    expect(r.stderr).toContain('non-offloadable category: authz') // judged, not merely unbuilt
    expect(r.stderr).not.toContain('router not built')
  })

  it('--no-route opts out: the same task is NOT routed', () => {
    // The differential against the case above -- same script, same task, one flag apart. That is
    // what makes this assertion non-vacuous: the ROUTE line demonstrably appears in this harness.
    const r = run(SCRIPT, ['--no-route', '--show-context', '--agent', 'mikrob', AUTHZ_TASK])
    expect(r.stderr).not.toContain('ROUTE=')
  })

  it('--auto is still accepted, so existing callers (offload-dispatch.sh) keep working', () => {
    const r = run(SCRIPT, ['--auto', '--show-context', '--agent', 'mikrob', AUTHZ_TASK])
    expect(r.status).toBe(9)
    expect(r.stderr).toContain('non-offloadable category: authz')
    expect(r.stderr).not.toContain('unknown option')
  })
})

describe('local-llm-rag.sh default is pinned even where the behavioural tests cannot run', () => {
  it('the script initialises routing ON', () => {
    // The group above is build-gated, and a build-gated group SKIPS GREEN on a checkout that was
    // never built -- the failure mode that let an env-gated suite hide a real break before. This
    // pin is weaker (it reads the source, it does not exercise it) but it always runs, so flipping
    // the default back to opt-in cannot pass unnoticed anywhere.
    const src = readFileSync(SCRIPT, 'utf-8')
    expect(src).toMatch(/^AUTO=1\b/m)
    expect(src).not.toMatch(/^AUTO=0\b/m)
    expect(src).toContain('--no-route)') // the opt-out the default depends on still exists
  })
})

describe('local-llm-rag.sh fails closed when the router is not built (card e817817c)', () => {
  it('routes ONLINE instead of drafting unjudged', () => {
    // Copied somewhere with no sibling dist/, which is what an unbuilt checkout looks like. The
    // dangerous direction is the ungated one: with nothing to judge the task, a 7B draft of an authz
    // change is worse than spending Claude tokens on it.
    const dir = mkdtempSync(join(tmpdir(), 'rag-nodist-'))
    cpSync(SCRIPT, join(dir, 'local-llm-rag.sh'))
    const r = run(join(dir, 'local-llm-rag.sh'), ['--agent', 'mikrob', 'write a trivial helper'])
    expect(r.status).toBe(9)
    expect(r.stderr).toContain('router not built')
  })
})

// --- advisory-only draft on an ONLINE verdict (card ee43a6ac) -----------------------------------
// The card moves DRAFTING to the local model for tasks the router sends online, and leaves the
// DECISION where it was. So the property under test is not "a draft appears" -- it is that nothing
// about the routing answer changes, on every path, including the ones where the draft fails.
describe.skipIf(!existsSync(ROUTER_BUILD))('advisory draft never changes the routing answer (card ee43a6ac)', () => {
  // Fast paths only: --show-context stops before the model call, and a dead OLLAMA_HOST makes the
  // draft fail immediately. Neither needs a local model, so these assert the invariant rather than
  // the model's mood.
  const DEAD_OLLAMA = 'http://127.0.0.1:9'

  it('advisory OFF is the old behaviour, exactly', () => {
    const r = runEnv(SCRIPT, ['--show-context', '--agent', 'mikrob', AUTHZ_TASK], { LOCAL_LLM_ADVISORY: '0' })
    expect(r.status).toBe(9)
    expect(r.stderr).toContain('non-offloadable category: authz')
    expect(r.stderr).not.toContain('advisory')
  })

  it('advisory ON still answers 9 on --show-context -- the prompt dump is not a local answer', () => {
    // The dangerous shape would be exit 0 here: a caller reading 0 as "local handled it" while the
    // router said online.
    const r = runEnv(SCRIPT, ['--show-context', '--agent', 'mikrob', AUTHZ_TASK], { LOCAL_LLM_ADVISORY: '1' })
    expect(r.status).toBe(9)
    expect(r.stderr).toContain('ROUTE=online')
  })

  it('an advisory run never logs ROUTE=local -- the log must not contradict the decision', () => {
    // Measured regression: the first cut let the online branch fall through into the stage-1 block,
    // which printed "ROUTE=local -> drafting on the 7B" for a task that was going online. The log is
    // how anyone later reconstructs what the router decided, so a contradicting line is a defect in
    // its own right.
    const r = runEnv(SCRIPT, ['--show-context', '--agent', 'mikrob', AUTHZ_TASK], { LOCAL_LLM_ADVISORY: '1' })
    expect(r.stderr).not.toContain('ROUTE=local')
  })

  it('a dead local model changes nothing: still 9, and it says the draft is missing', () => {
    // The whole point of a time-boxed, failure-tolerant draft: the online answer cannot depend on
    // whether ollama happens to be up.
    const r = runEnv(SCRIPT, ['--agent', 'mikrob', AUTHZ_TASK], {
      LOCAL_LLM_ADVISORY: '1',
      OLLAMA_HOST: DEAD_OLLAMA,
      LOCAL_LLM_ADVISORY_TIMEOUT: '10',
    })
    expect(r.status).toBe(9)
    expect(r.stderr).toContain('advisory draft unavailable')
    expect(r.stdout).not.toContain('ADVISORY DRAFT') // no banner without a draft to label
  })

  it('an unusable ask is not drafted at all -- reviewing noise costs more than writing', () => {
    const HEDGED = 'not sure what we want here, maybe rename something, unclear'
    const r = runEnv(SCRIPT, ['--agent', 'mikrob', HEDGED], { LOCAL_LLM_ADVISORY: '1', OLLAMA_HOST: DEAD_OLLAMA })
    expect(r.status).toBe(9)
    expect(r.stderr).toContain('ambiguous/hedged')
    expect(r.stderr).toContain('advisory draft SKIPPED')
  })
})
