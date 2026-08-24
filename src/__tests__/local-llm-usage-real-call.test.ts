import { describe, it, expect } from 'vitest'
import { isRealCall, type UsageRow } from '../web/routes/local-llm.js'

const row = (source: string, caller = 'backend'): UsageRow => ({
  ts: 0,
  caller,
  task: 'code',
  model: 'qwen2.5-coder:7b-instruct-q4_K_M',
  ms: 100,
  status: 'ok',
  source,
  evalTokens: 0,
  promptTokens: 0,
  evalDurationMs: 0,
})

describe('isRealCall', () => {
  it('counts bare and rag calls as real (existing behavior)', () => {
    expect(isRealCall(row('bare'))).toBe(true)
    expect(isRealCall(row('rag'))).toBe(true)
  })

  it('counts dispatch-offload calls as real -- regression for the undercounting bug', () => {
    // offload-dispatch.sh tags every dispatch-time offload call with
    // source=dispatch-offload. The old `source === 'bare' || 'rag'` allowlist
    // silently dropped these from today/total/last_7d and folded them into
    // ui_probes, making real usage look near-zero.
    expect(isRealCall(row('dispatch-offload'))).toBe(true)
  })

  it('excludes the dashboard UI-test probe regardless of its source value', () => {
    expect(isRealCall(row('ui', 'ui-test'))).toBe(false)
    // Defensive: a probe must be excluded by caller even if it ever lands
    // with a bare/rag/dispatch-offload source tag.
    expect(isRealCall(row('bare', 'ui-test'))).toBe(false)
  })
})
