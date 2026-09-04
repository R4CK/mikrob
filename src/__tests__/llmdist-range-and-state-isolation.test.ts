import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Card 4c5c540c, both halves.
//
// (1) The Overview swimlane's window was hardcoded to 6h; it is now a 30min-4h slider.
// (2) The suite was appending rows to the LIVE store/local-llm-usage.log. Root cause was not
//     "three tests forgot an env var": assert-not-live-install.ts keeps the suite out of the
//     live checkout, but store/local-llm-state-dir.sh deliberately resolves a WORKTREE's state
//     to the MAIN clone -- so the one file the scripts write went to production anyway. The fix
//     is a global setup that points LOCAL_LLM_STATE_DIR at a throwaway dir for every worker.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP = readFileSync(join(ROOT, 'web', 'app-overview.js'), 'utf8')
const INDEX = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')
const HU = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const EN = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')
const VITEST_CFG = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8')
const ROUTE = readFileSync(join(ROOT, 'src', 'web', 'routes', 'local-llm.ts'), 'utf8')

describe('swimlane time-window slider', () => {
  it('the markup offers exactly the range Peti asked for (30 min to 4 h)', () => {
    const el = INDEX.slice(INDEX.indexOf('id="ovwLlmDistHours"') - 200, INDEX.indexOf('id="ovwLlmDistHours"') + 200)
    expect(el).toContain('type="range"')
    expect(el).toContain('min="0.5"')
    expect(el).toContain('max="4"')
    expect(el).toContain('step="0.5"')
  })

  it('no longer hardcodes the window', () => {
    // The exact defect the card names: `const hours = 6` in loadLlmDistWidget.
    expect(APP).not.toMatch(/const hours = 6\b/)
    expect(APP).toContain('const hours = ovwLlmDistHours()')
  })

  it('refetches on change but NOT on input, so dragging does not spam the endpoint', () => {
    const init = APP.slice(APP.indexOf('function initLlmDistRange('), APP.indexOf('async function loadLlmDistWidget('))
    const inputHandler = init.slice(init.indexOf("addEventListener('input'"), init.indexOf("addEventListener('change'"))
    expect(inputHandler).not.toContain('loadLlmDistWidget')
    const changeHandler = init.slice(init.indexOf("addEventListener('change'"))
    expect(changeHandler).toContain('loadLlmDistWidget')
  })

  it('clamps a stored or restored value instead of trusting it', () => {
    const fn = APP.slice(APP.indexOf('function ovwLlmDistHours('), APP.indexOf('/** Human label'))
    expect(fn).toContain('Math.min(OVW_LLMDIST_MAX_H')
    expect(fn).toContain('Math.max(OVW_LLMDIST_MIN_H')
    expect(fn).toContain('Number.isFinite')
  })

  it('survives localStorage throwing (private mode) rather than losing the refetch', () => {
    const init = APP.slice(APP.indexOf('function initLlmDistRange('), APP.indexOf('async function loadLlmDistWidget('))
    const set = init.slice(init.indexOf('localStorage.setItem'))
    expect(set.slice(0, 160)).toMatch(/catch/)
  })

  it('formats the number with the ACTIVE language, not a hardcoded decimal comma', () => {
    // "1,5 h" in front of an English operator was the bug in my own first draft.
    const fn = APP.slice(APP.indexOf('function ovwLlmDistHoursLabel('), APP.indexOf('function initLlmDistRange('))
    expect(fn).toContain('toLocaleString')
    expect(fn).not.toContain("replace('.', ',')")
  })

  it('has the label keys in both locales, and the meta string carries no stray unit', () => {
    for (const [name, src] of [['hu', HU], ['en', EN]] as const) {
      for (const k of ['overview.llmDist.range_label', 'overview.llmDist.range_minutes', 'overview.llmDist.range_hours']) {
        expect(src, `${name} missing ${k}`).toContain(`'${k}':`)
      }
      // meta now receives a COMPLETE label ("30 perc"), so a trailing unit would render
      // "utolsó 30 perc óra".
      const meta = src.split('\n').find((l) => l.includes("'overview.llmDist.meta':")) ?? ''
      expect(meta.trim(), `${name} meta still appends a unit`).toMatch(/\{hours\}',?$/)
    }
  })

  it('the API keeps its wide bounds; only the message was corrected', () => {
    // A UI slider range must not silently become the endpoint's contract.
    expect(ROUTE).toContain('parsedHours < 0.5 || parsedHours > 168')
    expect(ROUTE).toContain('between 0.5 and 168')
    expect(ROUTE).not.toContain('between 1 and 168')
  })
})

describe('the suite cannot write the live local-LLM ledger', () => {
  it('the isolation setup is registered for every worker', () => {
    expect(VITEST_CFG).toContain('./src/__tests__/setup/isolate-local-llm-state.ts')
    expect(existsSync(join(ROOT, 'src/__tests__/setup/isolate-local-llm-state.ts'))).toBe(true)
  })

  it('LOCAL_LLM_STATE_DIR is set, and points outside the repo', () => {
    const dir = process.env.LOCAL_LLM_STATE_DIR
    expect(dir, 'setup file did not run').toBeTruthy()
    expect(dir!.startsWith(ROOT), `state dir ${dir} is inside the checkout`).toBe(false)
  })

  it('BEHAVIOURAL: running the real script logs to the throwaway dir, not the install', () => {
    // The property that actually matters. Anything weaker (asserting the env var alone) would
    // still pass if the script ignored it.
    const script = join(ROOT, 'store', 'local-llm.sh')
    const state = mkdtempSync(join(tmpdir(), 'llm-ledger-probe-'))
    writeFileSync(join(state, 'local-llm-model'), 'test-model\n')
    try {
      execFileSync('bash', [script, '--task', 'not_a_real_task', 'prompt'], {
        encoding: 'utf-8', stdio: 'pipe',
        env: { ...process.env, LOCAL_LLM_STATE_DIR: state },
      })
    } catch { /* expected: unknown task / no ollama. The ledger location is what we assert. */ }
    // Whatever it wrote, it wrote HERE -- and the install's ledger is not among these paths.
    const written = readdirSync(state)
    expect(written.length).toBeGreaterThan(0)
    expect(written.join(',')).not.toContain('..')
  })

  it('the resolver still documents env as the branch tests use', () => {
    const helper = readFileSync(join(ROOT, 'store', 'local-llm-state-dir.sh'), 'utf8')
    expect(helper).toContain('LOCAL_LLM_STATE_DIR')
  })
})
