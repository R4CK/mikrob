import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalModelName,
  isModelDisabled,
  readDisabledModels,
  serializeDisabledModels,
  DisabledModelsUnreadableError,
  type DisabledModels,
} from '../local-llm-model-disabled.js'

// Card 5d151091 (pair-FE 5dd4a211): the per-model operator kill switch. Two consumers read this
// state -- the dashboard routes and store/local-llm.sh -- so the module's two load-bearing
// properties are tested here directly: (1) canonical keying, without which a model disabled as
// "x:latest" would not block a caller asking for "x"; (2) the fail direction, where a MISSING file
// means "nothing disabled" but a CORRUPT one must never read as that.

let dir = ''
let file = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llm-model-disabled-'))
  file = join(dir, 'local-llm-model-disabled.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('canonicalModelName', () => {
  it('resolves a tagless name to :latest and leaves a tagged one alone', () => {
    expect(canonicalModelName('qwen2.5-coder')).toBe('qwen2.5-coder:latest')
    expect(canonicalModelName('qwen2.5-coder:7b')).toBe('qwen2.5-coder:7b')
    expect(canonicalModelName('hf.co/user/repo')).toBe('hf.co/user/repo:latest')
  })
})

describe('readDisabledModels', () => {
  it('reads a missing file as "nothing disabled" -- the normal state before any switch is used', () => {
    expect(readDisabledModels(file).size).toBe(0)
  })

  it('round-trips through serializeDisabledModels', () => {
    const before: DisabledModels = new Map([['qwen2.5-coder:7b', 1788380000000]])
    writeFileSync(file, serializeDisabledModels(before))
    expect(readDisabledModels(file)).toEqual(before)
  })

  it('canonicalises keys on read, so a hand-written tagless entry still blocks the tagged model', () => {
    writeFileSync(file, '{"disabledModels":{"qwen2.5-coder":{"disabledAt":1788380000000}}}')
    const models = readDisabledModels(file)
    expect([...models.keys()]).toEqual(['qwen2.5-coder:latest'])
    expect(isModelDisabled(models, 'qwen2.5-coder:latest')).toBe(true)
    expect(isModelDisabled(models, 'qwen2.5-coder')).toBe(true)
    expect(isModelDisabled(models, 'qwen2.5-coder:7b')).toBe(false)
  })

  it('keeps an entry whose disabledAt is missing or unusable -- the switch is the fact, not the timestamp', () => {
    writeFileSync(file, '{"disabledModels":{"a:1b":{},"b:1b":{"disabledAt":"tegnap"},"c:1b":{"disabledAt":7}}}')
    const models = readDisabledModels(file)
    expect(models.get('a:1b')).toBe(0)
    expect(models.get('b:1b')).toBe(0)
    expect(models.get('c:1b')).toBe(7)
    expect(isModelDisabled(models, 'a:1b')).toBe(true)
  })

  it('THROWS on a corrupt document instead of reporting "nothing disabled" (the fail-open class)', () => {
    for (const bad of ['{ broken', '{"disabledModels":[]}', '{"disabledModels":null}', '{"other":{}}', 'null', '[]']) {
      writeFileSync(file, bad)
      expect(() => readDisabledModels(file), bad).toThrow(DisabledModelsUnreadableError)
    }
  })
})

describe('serializeDisabledModels', () => {
  it('writes the documented shape, sorted, newline-terminated', () => {
    const out = serializeDisabledModels(new Map([['z:1b', 2], ['a:1b', 1]]))
    expect(out.endsWith('\n')).toBe(true)
    expect(JSON.parse(out)).toEqual({ disabledModels: { 'a:1b': { disabledAt: 1 }, 'z:1b': { disabledAt: 2 } } })
    expect(out.indexOf('a:1b')).toBeLessThan(out.indexOf('z:1b'))
  })

  it('an empty map serializes to a document readDisabledModels accepts (not to a corrupt one)', () => {
    writeFileSync(file, serializeDisabledModels(new Map()))
    expect(readDisabledModels(file).size).toBe(0)
  })
})

// The switch is only worth anything if BOTH consumers enforce it. These read the sources rather than
// spawning ollama: what matters is that neither call path can reach a model around the check.
describe('enforcement is wired into both consumers, not just the API', () => {
  const route = readFileSync(new URL('../web/routes/local-llm.ts', import.meta.url), 'utf-8')
  const shell = readFileSync(new URL('../../store/local-llm.sh', import.meta.url), 'utf-8')

  it('exposes the FE contract paths (card 5dd4a211 built against these)', () => {
    expect(route).toContain("path === '/api/local-llm/models' && method === 'GET'")
    expect(route).toContain('/api\\/local-llm\\/models\\/(.+)\\/(enable|disable)')
  })

  it('refuses to make a disabled model the fleet default through the activate door', () => {
    const door = route.slice(route.indexOf("path === '/api/local-llm/model' && method === 'POST'"))
    expect(door.slice(0, door.indexOf('/api/local-llm/pull'))).toContain('isModelDisabled(readDisabledModels(MODEL_DISABLED_FILE), model)')
  })

  it('store/local-llm.sh checks the switch AFTER the model is finally chosen, and stops rather than substituting', () => {
    const routing = shell.indexOf('ROUTED="$(route_model_for_task "$TASK")"')
    const check = shell.indexOf('model_switch_state "$MODEL"')
    expect(routing).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(routing)
    // Exit 9 is the fleet's "this belongs online" code; anything else (or a silent model swap)
    // would hide the switch from the caller.
    const block = shell.slice(check, check + 1200)
    expect(block).toContain('DISABLED)')
    expect(block).toContain('UNREADABLE)')
    expect(block.match(/exit 9/g)?.length).toBe(2)
  })

  it('store/local-llm.sh canonicalises the tag on both sides, like the TS module', () => {
    expect(shell).toContain('canon = name if ":" in name else name + ":latest"')
    expect(shell).toContain('keys = {(k if ":" in k else k + ":latest") for k in models}')
  })
})
