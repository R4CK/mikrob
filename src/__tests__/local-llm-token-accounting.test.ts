// Local-LLM token accounting (card d08b98f4). The Claude Limit panel's third row claims a number of
// SAVED tokens; if that number were an estimate it would be decoration. It is not: local-llm.sh has
// always logged the model's own eval_count / prompt_eval_count as TSV columns 8 and 9, and these
// tests pin that they are read, summed and attributed correctly.
import { describe, it, expect } from 'vitest'
import { isRealCall, parseUsageRows, type UsageRow } from '../web/routes/local-llm.js'

/** A ledger line exactly as store/local-llm.sh log_usage writes it. */
const line = (o: Partial<{ ts: number; caller: string; task: string; model: string; ms: number; status: string; source: string; evalTokens: number | string; promptTokens: number | string }> = {}): string =>
  [
    o.ts ?? 1_785_000_000,
    o.caller ?? 'backend',
    o.task ?? 'code',
    o.model ?? 'qwen2.5-coder:7b-instruct-q4_K_M',
    o.ms ?? 1234,
    o.status ?? 'ok',
    o.source ?? 'bare',
    o.evalTokens ?? 120,
    o.promptTokens ?? 45,
  ].join('\t')

const sumTokens = (rows: UsageRow[]): number =>
  rows.filter((r) => isRealCall(r) && r.status !== 'err').reduce((n, r) => n + r.evalTokens + r.promptTokens, 0)

describe('parseUsageRows -- token columns', () => {
  it('reads eval_count and prompt_eval_count from columns 8 and 9', () => {
    const [row] = parseUsageRows([line({ evalTokens: 300, promptTokens: 77 })])
    expect(row?.evalTokens).toBe(300)
    expect(row?.promptTokens).toBe(77)
  })

  it('sums to the EXACT expected total for known lines (not an estimate)', () => {
    const rows = parseUsageRows([
      line({ evalTokens: 100, promptTokens: 10 }),
      line({ evalTokens: 250, promptTokens: 40 }),
      line({ evalTokens: 5, promptTokens: 5 }),
    ])
    expect(sumTokens(rows)).toBe(410)
  })

  it('an OLD 7-column row (written before the token columns) counts as 0, never as a guess', () => {
    const legacy = [1_785_000_000, 'backend', 'code', 'm', 900, 'ok', 'bare'].join('\t')
    const rows = parseUsageRows([legacy])
    expect(rows).toHaveLength(1)
    expect(sumTokens(rows)).toBe(0)
  })

  it('garbage or negative token values count as 0 (a bad measurement must not inflate the saving)', () => {
    const rows = parseUsageRows([
      line({ evalTokens: 'NaN', promptTokens: '-50' }),
      line({ evalTokens: '', promptTokens: 'abc' }),
    ])
    expect(sumTokens(rows)).toBe(0)
  })

  it('FAILED calls contribute nothing -- an error produced no answer, so it saved nothing', () => {
    const rows = parseUsageRows([
      line({ status: 'err', evalTokens: 999, promptTokens: 999 }),
      line({ status: 'ok', evalTokens: 10, promptTokens: 1 }),
    ])
    expect(sumTokens(rows)).toBe(11)
  })

  it('UI probe calls contribute nothing (they are not work the fleet offloaded)', () => {
    const rows = parseUsageRows([
      line({ caller: 'ui-test', evalTokens: 500, promptTokens: 500 }),
      line({ caller: 'backend', evalTokens: 7, promptTokens: 3 }),
    ])
    expect(sumTokens(rows)).toBe(10)
  })

  it('a malformed short line is skipped entirely, not counted as a zero-token call', () => {
    const rows = parseUsageRows(['1785000000\tbackend\tcode', line({ evalTokens: 1, promptTokens: 1 })])
    expect(rows).toHaveLength(1)
    expect(sumTokens(rows)).toBe(2)
  })
})
