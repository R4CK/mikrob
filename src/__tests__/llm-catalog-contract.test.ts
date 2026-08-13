// The local-LLM catalogue contract, enforced in CI (card ad6cf75a, EPIC ebc7b4dd).
//
// WHY THIS FILE EXISTS AT ALL. store/gpu-detect-selftest.sh and store/llm-catalog-selftest.py carry
// 41 controls between them -- and until now NOTHING RAN THEM. A selftest that only executes when
// someone remembers to type its name is documentation, not a gate: the defects it pins can return
// in a commit that never invokes it. So this file drags both into the suite that already runs on
// every change, and adds the consumer contract on top.
//
// The contract matters because TWO consumers read the catalogue -- the first-run installer step (T2)
// and the selector UI (T4). A schema is only a contract if something FAILS when it drifts.
//
// It checks DERIVED facts, not presence. `fileMib` being an integer proves nothing; `fileMib`
// equalling the sum of its parts is the property that was actually wrong and shipped twice -- once
// sized by one shard of five, once summed against itself when a repo published a quant both sharded
// and standalone.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '..', '..')
const CATALOG = join(ROOT, 'store', 'llm-catalog.py')

function run(cmd: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 120_000 })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** A minimal document that satisfies the contract -- the baseline every mutation below breaks. */
function validDoc(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-13T20:00:00Z',
    source: 'huggingface',
    stale: false,
    host: { gpu: { vramTotalMib: 6144, cpuOnly: false }, ramTotalMib: 24000 },
    warnings: [],
    models: [
      {
        id: 'qwen_test:q4_k_m',
        repo: 'Qwen/Test-GGUF',
        repoOwner: 'Qwen',
        quant: 'Q4_K_M',
        parts: [
          { path: 'a-00001-of-00002.gguf', sizeMib: 3000, sha256: 'a'.repeat(64) },
          { path: 'a-00002-of-00002.gguf', sizeMib: 1000, sha256: 'b'.repeat(64) },
        ],
        partCount: 2,
        fileMib: 4000,
        requiredMib: 5143,
        kvCacheMib: 119,
        contextTokens: 4096,
        tier: 'partial',
        tokensPerSecond: null,
        installRef: 'hf.co/Qwen/Test-GGUF:Q4_K_M',
        trusted: true,
        trustReason: 'allowlisted-publisher',
        installedAt: null,
        benchmarkedAt: null,
      },
    ],
  }
}

function validate(doc: unknown): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'llmcat-'))
  const f = join(dir, 'doc.json')
  writeFileSync(f, JSON.stringify(doc))
  return run('python3', [CATALOG, '--validate', f])
}

describe('local-LLM catalogue: the selftests actually run in CI', () => {
  it('gpu-detect selftest passes', () => {
    const { code, out } = run('bash', [join(ROOT, 'store', 'gpu-detect-selftest.sh')])
    expect(out).toContain('selftest: PASS')
    expect(code).toBe(0)
  })

  it('llm-catalog selftest passes (offline, fixture-driven)', () => {
    const { code, out } = run('python3', [join(ROOT, 'store', 'llm-catalog-selftest.py')])
    expect(out).toContain('selftest: PASS')
    expect(code).toBe(0)
  })
})

describe('local-LLM catalogue: consumer contract', () => {
  it('accepts a well-formed document', () => {
    const { code, out } = validate(validDoc())
    expect(out).toContain('VALID')
    expect(code).toBe(0)
  })

  // Each case breaks exactly ONE property. A validator that passes any of these would let a
  // consumer read a document it cannot trust -- and both consumers act on these numbers.
  const mutations: ReadonlyArray<readonly [string, (d: any) => void]> = [
    ['an unknown schemaVersion is refused, not read anyway', (d) => (d.schemaVersion = 99)],
    ['fileMib that is not the sum of its parts', (d) => (d.models[0].fileMib = 1)],
    ['partCount disagreeing with parts', (d) => (d.models[0].partCount = 7)],
    ['a part with no digest -- the set is not pinned', (d) => (d.models[0].parts[0].sha256 = null)],
    ['requiredMib not exceeding fileMib', (d) => (d.models[0].requiredMib = 10)],
    ['a tier that should never be offered', (d) => (d.models[0].tier = 'too-big')],
    ['an invented throughput', (d) => (d.models[0].tokensPerSecond = 'fast')],
    ['an installRef that cannot be installed', (d) => (d.models[0].installRef = 'qwen')],
    ['a model with no parts at all', (d) => (d.models[0].parts = [])],
  ]

  for (const [label, mutate] of mutations) {
    it(`rejects: ${label}`, () => {
      const doc = validDoc()
      mutate(doc)
      const { code, out } = validate(doc)
      expect(out, `the validator accepted a document with: ${label}`).toContain('INVALID')
      expect(code).toBe(1)
    })
  }
})
