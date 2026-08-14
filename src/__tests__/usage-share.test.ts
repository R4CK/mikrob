// store/usage-share.mjs -- the second, independent signal for the routing epic (card 63c7d6f9).
//
// The script exists to stop two conflations that the raw log invites, so those two are what the
// tests pin: the stage-1 CLASSIFIER is not work, and `task` is a caller-declared label rather than a
// measurement. Both were measured on the live log first (classifier median 599 ms; `chat` calls
// median 35s / 941 output tokens, i.e. real drafting under a default label).
import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', '..', 'store', 'usage-share.mjs')

let sandbox: string
let log: string

// epoch \t caller \t task \t model \t ms \t status \t source \t in \t out
const DAY = Math.floor(Date.parse('2026-08-14T10:00:00Z') / 1000)
const row = (task: string, source: string, out: number, status = 'ok', ts = DAY) =>
  [ts, 'backend2', task, 'qwen', 30_000, status, source, 100, out].join('\t')

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'usage-share-'))
  log = join(sandbox, 'usage.log')
  writeFileSync(
    log,
    [
      row('chat', 'dispatch-offload', 900),
      row('chat', 'dispatch-offload', 1100),
      row('code', 'rag', 1500),
      row('route-triage', 'routing', 420), // classifier: must not count as work
      row('route-triage', 'routing', 430),
      row('chat', 'advisory', 500), // a draft for a task the router sent ONLINE
      row('chat', 'dispatch-offload', 0, 'err'),
      'truncated\trow\twith\tfew\tcolumns', // must be skipped, not guessed at
      '',
    ].join('\n'),
  )
})

function run(args: readonly string[]): { status: number; out: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf-8', timeout: 60_000 })
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

describe('usage-share.mjs (card 63c7d6f9)', () => {
  it('counts the stage-1 classifier APART from work -- it is the router asking, not work arriving', () => {
    const r = run(['--log', log])
    expect(r.status).toBe(0)
    // 5 work rows (2 chat + 1 code + 1 advisory + 1 err), 2 classifier rows.
    expect(r.out).toContain('work 5')
    expect(r.out).toContain('classifier calls 2')
  })

  it('the code share is computed WITHIN work, and labelled as a caller-declared flag', () => {
    const r = run(['--log', log])
    // 1 of 5 work rows, not 1 of 7 total rows -- the classifier must not dilute it.
    expect(r.out).toContain('task=code within work: 1 (20.0%)')
    expect(r.out).toContain('counts flags, not work')
  })

  it('advisory drafts are visible on their own -- work the model never used to see at all', () => {
    const r = run(['--log', log])
    expect(r.out).toContain('advisory drafts 1')
  })

  it('sums output tokens over work only', () => {
    // 900 + 1100 + 1500 + 500 + 0 = 4000; the classifier rows (420 + 430) are excluded.
    const r = run(['--log', log])
    expect(r.out).toContain('output tokens 4000')
  })

  it('a truncated row is skipped, not guessed at -- the log is appended to by a shell script', () => {
    const r = run(['--log', log])
    expect(r.status).toBe(0)
    expect(r.out).toContain('7 rows') // 9 lines, minus the truncated one and the blank
  })

  it('--since narrows the window', () => {
    const older = join(sandbox, 'older.log')
    const OLD = Math.floor(Date.parse('2026-08-01T10:00:00Z') / 1000)
    writeFileSync(older, [row('chat', 'dispatch-offload', 700, 'ok', OLD), row('chat', 'rag', 300)].join('\n'))
    const all = run(['--log', older])
    expect(all.out).toContain('work 2')
    const narrowed = run(['--log', older, '--since', '2026-08-10'])
    expect(narrowed.out).toContain('work 1')
  })

  it('no log at all is exit 2, not a zero that reads like an empty day', () => {
    const r = run(['--log', join(sandbox, 'missing.log')])
    expect(r.status).toBe(2)
    expect(r.out).toContain('no usage log')
  })
})
