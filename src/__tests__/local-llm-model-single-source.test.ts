// ONE opinion about which local model is active (card f8d55568 / b96e3dea).
//
// THE DEFECT THIS PINS. store/local-llm-model is the config, but THREE files carried FOUR literal
// fallbacks for it and they DISAGREED: local-llm.sh fell back to the GENERAL `qwen2.5:7b` while
// local-llm-bench.sh and quota-bridge.py fell back to the CODER build. A missing or blanked config
// therefore did not degrade to a known state -- the dispatch seam quietly started asking a
// non-coding model for code while the bench and the quota bridge still reported on the coder model,
// and nothing errored anywhere.
//
// THE TEST IS BEHAVIOURAL, NOT TEXTUAL, on purpose. Grepping for a model name would both miss a
// fallback written differently and false-positive on legitimate mentions -- local-llm.ts carries a
// RECOMMENDATIONS table full of model names that are suggestions, not fallbacks. So instead each
// reader is RUN with no config present, and asked to prove it does not invent one. A literal moved
// somewhere clever still fails this.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '..', '..')
const STORE = join(ROOT, 'store')

/** A scratch copy of a store script, run with NO local-llm-model beside it. The scripts resolve the
 *  config relative to their own location, so a copy in an empty directory is a config-less run. */
function runWithoutConfig(script: string, args: string[] = []): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'llm-model-'))
  copyFileSync(join(STORE, script), join(dir, script))
  const r = spawnSync('bash', [join(dir, script), ...args], { encoding: 'utf-8', timeout: 60_000 })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

// Any concrete model tag: a name followed by ':' and a size/variant. If a reader prints one of these
// with no config present, it invented it.
const MODEL_TAG = /[a-z0-9.\-]+:\d+(\.\d+)?b[a-z0-9_\-]*/i

describe('local-llm model resolution: exactly one source of truth', () => {
  it('the dispatch seam refuses rather than inventing a model', () => {
    const { out } = runWithoutConfig('local-llm.sh', ['--health'])
    expect(out).toMatch(/no model configured/i)
    expect(out, 'local-llm.sh printed a model tag with no config present').not.toMatch(MODEL_TAG)
  })

  it('the bench refuses rather than benchmarking a model nobody configured', () => {
    const { code, out } = runWithoutConfig('local-llm-bench.sh')
    expect(out).toMatch(/no model configured/i)
    expect(code).toBe(4)
    expect(out, 'local-llm-bench.sh printed a model tag with no config present').not.toMatch(MODEL_TAG)
  })

  it('the quota bridge reports "none configured" instead of a name it made up', () => {
    // Reporting path: it must not abort, but attributing numbers to a model the fleet is not
    // running is worse than saying none is configured, because the figure then looks attributed.
    const src = readFileSync(join(STORE, 'quota-bridge.py'), 'utf-8')
    const resolver = src.slice(src.indexOf('def _read_model'), src.indexOf('QUALITY_MODEL'))
    expect(resolver, 'quota-bridge._read_model reintroduced a literal fallback').not.toMatch(MODEL_TAG)
    expect(src).toContain('<none configured>')
  })

  it('the dashboard reader returns empty rather than a default', () => {
    const src = readFileSync(join(ROOT, 'src', 'web', 'routes', 'local-llm.ts'), 'utf-8')
    const i = src.indexOf('MODEL_FILE)')
    const resolver = src.slice(i, i + 400)
    expect(resolver, 'the dashboard active-model reader grew a literal fallback').not.toMatch(MODEL_TAG)
  })

  it('the config file itself is the only place a default lives', () => {
    // Sanity: the live config exists and is a single line. If this ever fails, the four readers
    // above are the only thing standing between the fleet and a silently wrong model.
    const f = join(STORE, 'local-llm-model')
    expect(existsSync(f)).toBe(true)
    expect(readFileSync(f, 'utf-8').trim().split('\n')).toHaveLength(1)
  })
})
