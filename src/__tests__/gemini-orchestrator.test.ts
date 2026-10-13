// Card 23a14c4b (Gemini-orch 1/4): the sequencing-only decision layer. Pins the seven
// plan-grilling conditions from cf757409 comment 17552 as behavioral tests, not prose.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GeminiResult } from '../gemini-client.js'

let killSwitchJson: string | null = null
let fallbackStateJson: string | null = null
let writtenQueue: unknown = null
let forcedSpawnResult: { status: number | null; error?: Error } | null = null

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  return {
    ...real,
    spawnSync: vi.fn((...args: Parameters<typeof real.spawnSync>) => {
      if (forcedSpawnResult) return forcedSpawnResult as ReturnType<typeof real.spawnSync>
      return real.spawnSync(...args)
    }),
  }
})

vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return {
    ...real,
    readFileSync: vi.fn((path: string) => {
      const p = String(path)
      if (p.endsWith('gemini-orchestrator-enabled.json')) {
        if (killSwitchJson === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return killSwitchJson
      }
      if (p.endsWith('gemini-fallback-state.json')) {
        if (fallbackStateJson === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return fallbackStateJson
      }
      return real.readFileSync(path)
    }),
    writeFileSync: vi.fn((path: string, data: string) => {
      if (String(path).endsWith('gemini-orchestrator-queue.json')) {
        writtenQueue = JSON.parse(data)
      }
    }),
  }
})

vi.mock('../web/vault.js', () => ({
  getSecret: vi.fn(() => 'fake-gemini-key'),
}))

vi.mock('../db.js', () => ({
  initDatabase: vi.fn(),
  listKanbanCards: vi.fn(() => []),
  getLabelsForAllCards: vi.fn(() => new Map()),
}))

import {
  isGeminiOrchestratorEnabled,
  isEligibleForGeminiOrdering,
  buildOrderingMetadata,
  buildOrderingPrompt,
  parseOrderingResponse,
  decideGeminiOrder,
  runGeminiOrchestratorSweep,
  runAsEntryPoint,
  type OrchestratorCard,
} from '../gemini-orchestrator.js'

function card(over: Partial<OrchestratorCard> = {}): OrchestratorCard {
  return { id: 'c1', title: 'Add a retry button', labels: [], project: 'MikroB', status: 'planned', ...over }
}

beforeEach(() => {
  killSwitchJson = null
  fallbackStateJson = null
  writtenQueue = null
  forcedSpawnResult = null
  vi.restoreAllMocks()
})

describe('isGeminiOrchestratorEnabled (condition 1: OFF by default)', () => {
  it('missing file -> false', () => {
    killSwitchJson = null
    expect(isGeminiOrchestratorEnabled()).toBe(false)
  })
  it('malformed JSON -> false, never throws', () => {
    killSwitchJson = '{not json'
    expect(() => isGeminiOrchestratorEnabled()).not.toThrow()
    expect(isGeminiOrchestratorEnabled()).toBe(false)
  })
  it('enabled: "true" (string, not boolean) -> false, only a literal boolean true counts', () => {
    killSwitchJson = JSON.stringify({ enabled: 'true' })
    expect(isGeminiOrchestratorEnabled()).toBe(false)
  })
  it('enabled: true -> true', () => {
    killSwitchJson = JSON.stringify({ enabled: true })
    expect(isGeminiOrchestratorEnabled()).toBe(true)
  })
})

describe('isEligibleForGeminiOrdering (conditions 5+6: mopsion/BLOKKOLT/sensitive excluded)', () => {
  it('MikroB-project card, no labels, benign title: eligible', () => {
    expect(isEligibleForGeminiOrdering(card())).toBe(true)
  })
  it('mopsion project: excluded', () => {
    expect(isEligibleForGeminiOrdering(card({ project: 'mopsion' }))).toBe(false)
  })
  it('no project (null): excluded (fail-closed allowlist, mirrors is_gemini_blocked)', () => {
    expect(isEligibleForGeminiOrdering(card({ project: null }))).toBe(false)
  })
  it('unrelated project string: excluded', () => {
    expect(isEligibleForGeminiOrdering(card({ project: 'SomeOtherThing' }))).toBe(false)
  })
  it('BLOKKOLT-* label: excluded regardless of suffix', () => {
    expect(isEligibleForGeminiOrdering(card({ labels: ['BLOKKOLT-Peti-dontes'] }))).toBe(false)
    expect(isEligibleForGeminiOrdering(card({ labels: ['blokkolt-tisztazas'] }))).toBe(false)
  })
  it('an exact blocked-tag label (e.g. @security): excluded', () => {
    expect(isEligibleForGeminiOrdering(card({ labels: ['@security'] }))).toBe(false)
  })
  it('sensitive-stem title (plain ASCII stem): excluded', () => {
    expect(isEligibleForGeminiOrdering(card({ title: 'Jelszo reset flow' }))).toBe(false)
  })
  it('accent-dependent sensitive stem (stem sits INSIDE the accented char): excluded', () => {
    // "Szamla" / "Számla" -- the accented á is part of the matched stem itself, same class of
    // case the a92e9913 RedHat 17567 B4a tests pinned for is_gemini_blocked.
    expect(isEligibleForGeminiOrdering(card({ title: 'Uj Szamla export' }))).toBe(false)
    expect(isEligibleForGeminiOrdering(card({ title: 'Új Számla export' }))).toBe(false)
  })
  // WhiteHat F1 (comment 17666) regression corpus: words the earlier hand-ported vocabulary
  // missed, now covered because the landed filter's own SENS_RE already includes them.
  it('authz/PII title stems missing from the earlier port (permission/access/szemelyes/hozzaferes): excluded', () => {
    expect(isEligibleForGeminiOrdering(card({ title: 'Permission model for the export' }))).toBe(false)
    expect(isEligibleForGeminiOrdering(card({ title: 'Access review of the export job' }))).toBe(false)
    expect(isEligibleForGeminiOrdering(card({ title: 'Szemelyes adat maszkolasa a naploban' }))).toBe(false)
    expect(isEligibleForGeminiOrdering(card({ title: 'Hozzaferes-kezeles atirasa' }))).toBe(false)
  })
  it('a label matches the blocked exact-tag set (e.g. finance): excluded', () => {
    expect(isEligibleForGeminiOrdering(card({ labels: ['finance'] }))).toBe(false)
  })
  // RedHat N2 (comment 17825, same re-gate as WhiteHat2 F1' above): a label that is NOT a literal
  // BLOCKED_TAGS member still needs the same stem check title/desc already get. "[Biztonsag]" is
  // not an exact match (that set has "security", not the Hungarian word) and is not a blokkolt-*
  // prefix -- the earlier, now-fixed behavior let a benign-titled card carrying it through
  // unblocked, which is exactly the kind of label-vs-title asymmetry Peti 11131 forbids.
  it('a tag/label that is not an exact blocked-tag match but DOES contain a sensitive stem: excluded (N2 fix)', () => {
    expect(isEligibleForGeminiOrdering(card({ labels: ['[Biztonsag]'] }))).toBe(false)
    expect(isEligibleForGeminiOrdering(card({ labels: ['jelszo-rotacio'] }))).toBe(false)
    expect(isEligibleForGeminiOrdering(card({ labels: ['szamla'] }))).toBe(false)
  })
  // WhiteHat2 F1' (comment 17828/17831, same re-gate): the SEC/BLOKKOLT-* marker often lives as a
  // "[TAG]" prefix in the TITLE, not as a kanban label -- isEligibleForGeminiOrdering only ever
  // sends `card.labels` as tags, so a title-only marker with NO matching label used to sail
  // through this gate entirely. The fix lives in offload-dispatch.sh's --check-blocked entry
  // point itself (it now extracts title-prefix bracket tags the same way tags_for() does), so
  // these pass through the REAL subprocess, not a mock, to exercise the actual fix end to end.
  it('a title-prefix [SEC]/[BLOKKOLT-*] tag with NO matching label: excluded (F1 prime fix)', () => {
    expect(isEligibleForGeminiOrdering(card({ title: '[SEC] Benign title', labels: [] }))).toBe(false)
    expect(
      isEligibleForGeminiOrdering(card({ title: '[BLOKKOLT-Peti-stop] [MikroB][INFRA] Benign title', labels: [] })),
    ).toBe(false)
  })
  it('a benign label alongside a benign title: still eligible', () => {
    expect(isEligibleForGeminiOrdering(card({ labels: ['@frontend', 'ui'] }))).toBe(true)
  })
  it('fail-closed: a crashed/killed subprocess (status null) is treated as blocked, never allowed', () => {
    forcedSpawnResult = { status: null, error: new Error('spawn bash ENOENT') }
    expect(isEligibleForGeminiOrdering(card())).toBe(false)
  })
  it('fail-closed: an unexpected exit code (not the 42 allowed-sentinel) is treated as blocked', () => {
    forcedSpawnResult = { status: 2 }
    expect(isEligibleForGeminiOrdering(card())).toBe(false)
  })
  // N1 (RedHat 17825/17831): bash's own generic failure code (1) must NOT be read as "allowed" --
  // that collision is exactly what the sentinel-42 contract (not plain exit 1) exists to prevent.
  it('fail-closed: exit code 1 (the OLD "allowed" meaning, also bash\'s generic failure code) is treated as blocked, not allowed', () => {
    forcedSpawnResult = { status: 1 }
    expect(isEligibleForGeminiOrdering(card())).toBe(false)
  })
  it('CONTROL: exit code 42 (the actual allowed sentinel) is treated as allowed', () => {
    forcedSpawnResult = { status: 42 }
    expect(isEligibleForGeminiOrdering(card())).toBe(true)
  })
  // N4 (RedHat 17825): an unbounded spawnSync could hang the whole sweep forever on a wedged
  // subprocess -- a timeout option must actually be passed, not just assumed from the fail-closed
  // status-null handling above (that only covers what happens AFTER a timeout fires).
  it('N4: spawnSync is called with a bounded timeout, not unbounded', async () => {
    const { spawnSync } = await import('node:child_process')
    isEligibleForGeminiOrdering(card())
    const lastCall = vi.mocked(spawnSync).mock.calls.at(-1)
    const opts = lastCall?.[2] as { timeout?: number } | undefined
    expect(opts?.timeout).toBeGreaterThan(0)
  })
})

describe('runAsEntryPoint (F2 / RedHat N3, comment 17825): initDatabase before the DB read', () => {
  it('calls initDatabase before runGeminiOrchestratorSweep would read from the DB', async () => {
    const { initDatabase, listKanbanCards } = await import('../db.js')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    runAsEntryPoint()
    expect(initDatabase).toHaveBeenCalled()
    // The kill switch defaults OFF in this suite (no gemini-orchestrator-enabled.json fixture is
    // set up), so the sweep itself no-ops without ever reaching listKanbanCards -- this assertion
    // exists only so a future change that makes the sweep run unconditionally does not silently
    // start reading the DB before this test would notice.
    await new Promise((r) => setTimeout(r, 0))
    expect(listKanbanCards).not.toHaveBeenCalled()
    exitSpy.mockRestore()
  })
})

describe('buildOrderingMetadata (condition 2: ONLY id+title+labels ever leaves the process)', () => {
  it('strips every other field off the card, structurally', () => {
    const meta = buildOrderingMetadata([card({ id: 'x1', title: 'T', labels: ['a'] })])
    expect(meta).toEqual([{ id: 'x1', title: 'T', labels: ['a'] }])
    expect(Object.keys(meta[0]!).sort()).toEqual(['id', 'labels', 'title'])
  })
})

describe('buildOrderingPrompt', () => {
  it('embeds the metadata JSON and asks for id-only JSON array output', () => {
    const prompt = buildOrderingPrompt([{ id: 'x1', title: 'Fix the thing', labels: ['@backend'] }])
    expect(prompt).toContain('"id":"x1"')
    expect(JSON.parse(prompt.split('\n').pop()!)).toEqual([{ id: 'x1', title: 'Fix the thing', labels: ['@backend'] }])
    expect(prompt.toLowerCase()).toContain('json')
  })
})

describe('parseOrderingResponse (condition 3: fail-closed on anything but an exact match)', () => {
  const ids = ['a', 'b', 'c']
  it('exact valid permutation: returns it', () => {
    expect(parseOrderingResponse('["b","a","c"]', ids)).toEqual(['b', 'a', 'c'])
  })
  it('markdown-fenced JSON: still parses (defensive strip)', () => {
    expect(parseOrderingResponse('```json\n["a","b","c"]\n```', ids)).toEqual(['a', 'b', 'c'])
  })
  it('not JSON at all: null', () => {
    expect(parseOrderingResponse('sure, here is the order: a, b, c', ids)).toBeNull()
  })
  it('JSON but not an array: null', () => {
    expect(parseOrderingResponse('{"order":["a","b","c"]}', ids)).toBeNull()
  })
  it('contains an unknown id: null (never partially trusted)', () => {
    expect(parseOrderingResponse('["a","b","zzz"]', ids)).toBeNull()
  })
  it('duplicate id: null', () => {
    expect(parseOrderingResponse('["a","a","b"]', ids)).toBeNull()
  })
  it('missing an id (partial list): null, never silently truncated', () => {
    expect(parseOrderingResponse('["a","b"]', ids)).toBeNull()
  })
  it('array of non-strings: null', () => {
    expect(parseOrderingResponse('[1,2,3]', ids)).toBeNull()
  })
})

describe('decideGeminiOrder (condition 3: fail-closed end to end)', () => {
  it('no eligible cards: fails closed without ever calling Gemini', async () => {
    const callGemini = vi.fn()
    const result = await decideGeminiOrder([card({ project: 'mopsion' })], 'key', callGemini)
    expect(result).toEqual({ ok: false, reason: 'no_eligible_cards' })
    expect(callGemini).not.toHaveBeenCalled()
  })

  it('Gemini call fails (network/timeout/quota): fails closed, reason passed through, never throws', async () => {
    const callGemini = vi.fn(async (): Promise<GeminiResult> => ({ ok: false, reason: 'network', detail: 'boom' }))
    const result = await decideGeminiOrder([card()], 'key', callGemini)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('network')
  })

  it('Gemini returns garbage text: fails closed with invalid_response_schema, never throws', async () => {
    const callGemini = vi.fn(async (): Promise<GeminiResult> => ({ ok: true, text: 'not json' }))
    const result = await decideGeminiOrder([card()], 'key', callGemini)
    expect(result).toEqual({ ok: false, reason: 'invalid_response_schema' })
  })

  it('Gemini returns a valid order: ok:true with that order', async () => {
    const cards = [card({ id: 'a' }), card({ id: 'b' })]
    const callGemini = vi.fn(async (): Promise<GeminiResult> => ({ ok: true, text: '["b","a"]' }))
    const result = await decideGeminiOrder(cards, 'key', callGemini)
    expect(result).toEqual({ ok: true, order: ['b', 'a'] })
  })

  // Condition 2, end to end: the excluded card's title must never appear in what Gemini receives.
  it('an excluded (sensitive) card never appears in the prompt sent to Gemini', async () => {
    const cards = [card({ id: 'ok1', title: 'Add dark mode' }), card({ id: 'sec1', title: 'Jelszo bug fix', labels: ['@security'] })]
    let seenPrompt = ''
    const callGemini = vi.fn(async (opts: { prompt: string }): Promise<GeminiResult> => {
      seenPrompt = opts.prompt
      return { ok: true, text: '["ok1"]' }
    })
    const result = await decideGeminiOrder(cards, 'key', callGemini)
    expect(result).toEqual({ ok: true, order: ['ok1'] })
    expect(seenPrompt).not.toContain('Jelszo')
    expect(seenPrompt).not.toContain('sec1')
  })
})

describe('runGeminiOrchestratorSweep (conditions 1+4+7: kill switch, route gate, never closes a card)', () => {
  it('kill switch OFF (no file): no Gemini call, no queue write', async () => {
    killSwitchJson = null
    fallbackStateJson = JSON.stringify({ route: 'gemini' })
    const loadCards = vi.fn(() => [card()])
    await runGeminiOrchestratorSweep(loadCards)
    expect(loadCards).not.toHaveBeenCalled()
    expect(writtenQueue).toBeNull()
  })

  it('kill switch ON but route is claude: no action', async () => {
    killSwitchJson = JSON.stringify({ enabled: true })
    fallbackStateJson = JSON.stringify({ route: 'claude' })
    const loadCards = vi.fn(() => [card()])
    await runGeminiOrchestratorSweep(loadCards)
    expect(loadCards).not.toHaveBeenCalled()
    expect(writtenQueue).toBeNull()
  })

  it('kill switch ON + route gemini + a valid decision: writes the queue file, never a kanban call', async () => {
    killSwitchJson = JSON.stringify({ enabled: true })
    fallbackStateJson = JSON.stringify({ route: 'gemini' })
    const loadCards = vi.fn(() => [card({ id: 'only1' })])
    const callGemini = vi.fn(async (): Promise<GeminiResult> => ({ ok: true, text: '["only1"]' }))
    await runGeminiOrchestratorSweep(loadCards, callGemini)
    expect(writtenQueue).toMatchObject({ order: ['only1'] })
  })

  it('kill switch ON + route gemini + Gemini fails: fail-closed, nothing written', async () => {
    killSwitchJson = JSON.stringify({ enabled: true })
    fallbackStateJson = JSON.stringify({ route: 'gemini' })
    const loadCards = vi.fn(() => [card({ id: 'only1' })])
    const callGemini = vi.fn(async (): Promise<GeminiResult> => ({ ok: false, reason: 'quota' }))
    await runGeminiOrchestratorSweep(loadCards, callGemini)
    expect(writtenQueue).toBeNull()
  })
})
