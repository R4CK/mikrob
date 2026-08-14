// usage-share.mjs decides what is WORK from a list, so an unknown source cannot inflate it
// (card 5cce8ac6, Cybered MEDIUM).
//
// THE OLD POLARITY HAD A DIRECTION. The script excluded ONE named source (the stage-1 classifier)
// and counted everything else as work. That error could only drift upward: every diagnostic, probe
// or experiment source anyone added later would land in the numerator, and the local-model redesign
// would look more successful the more of them existed. The live log already carried three such rows
// (selftest, diag-test, diag-verify).
//
// What is pinned here is the polarity itself, not the current membership of the lists. The numbers
// below are chosen so that the OLD logic and the NEW logic give DIFFERENT answers -- an assertion
// both versions satisfy would prove nothing about the change.
import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'store', 'usage-share.mjs')

/** ts, caller, task, model, ms, status, source, in, out -- the log's nine tab-separated fields. */
const row = (ts: number, source: string, out: number, task = 'chat', status = 'ok') =>
  [ts, 'someagent', task, 'qwen', 1200, status, source, 100, out].join('\t')

const T = 1786000000 // fixed: the script buckets by UTC day, and a drifting clock is not a test input

let out = ''
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-share-'))
  const log = join(dir, 'usage.log')
  writeFileSync(
    log,
    [
      row(T, 'rag', 100), // work: declared
      row(T, 'dispatch-offload', 200), // work: declared
      row(T, 'selftest', 9000), // known NON-work: decided, with a reason, stays quiet
      row(T, 'a-source-nobody-declared', 9000), // the case this card exists for
      row(T, 'routing', 5), // the stage-1 classifier, counted in its own column
      '', // a truncated trailing line, which the log genuinely has
    ].join('\n'),
    'utf-8',
  )
  const r = spawnSync(process.execPath, [SCRIPT, '--log', log], { encoding: 'utf-8' })
  expect(r.status, `usage-share exited ${r.status}: ${r.stderr}`).toBe(0)
  out = r.stdout
})

describe('usage-share.mjs counts declared work only (card 5cce8ac6)', () => {
  it('an undeclared source is NOT work -- this is the whole polarity flip', () => {
    // Two work rows out of five. The old logic said four: everything that was not `routing`.
    // So `work 2` is exactly the assertion the pre-fix script fails.
    expect(out).toContain('window total: work 2,')
  })

  it('...and its output tokens stay out of the total, which is the number people quote', () => {
    // 100 + 200 from the two work rows. The selftest and the undeclared row carry 9000 each, so a
    // regression here is loud rather than a rounding difference: 300 vs 18300.
    expect(out).toContain('output tokens 300,')
  })

  it('the undeclared source is NAMED, not just counted', () => {
    // A bare "2 unclassified" tells the reader that something needs deciding but not what, which is
    // how a visible column becomes a number people scroll past.
    expect(out).toContain('UNDECIDED SOURCES (1)')
    expect(out).toContain('a-source-nobody-declared  1 call(s)')
    expect(out).toContain('Add each to WORK_SOURCES or to NON_WORK_SOURCES with a reason')
  })

  it('a DECIDED non-work source is silent -- a permanent warning is one nobody reads', () => {
    // selftest is excluded on purpose and says so in the source, so it must not appear in the list
    // of things awaiting a decision. It still shows up in the unclassified COUNT (2, with the
    // undeclared row), because hiding it entirely would make the work total unauditable.
    expect(out).not.toContain('selftest  1 call(s)')
    expect(out).toMatch(/\|\s+1\s+2 \|/) // classifier 1, unclassified 2, on the one day
  })

  it('the classifier keeps its own column rather than merging into non-work', () => {
    expect(out).toContain('classifier calls 1')
  })

  it('CONTROL: a log with only declared sources reports the decided state out loud', () => {
    // Otherwise "no undecided sources" is indistinguishable from "the detection never ran" -- the
    // silent-success trap that this card's own defect was an instance of.
    const dir = mkdtempSync(join(tmpdir(), 'usage-share-clean-'))
    const log = join(dir, 'usage.log')
    writeFileSync(log, [row(T, 'rag', 100), row(T, 'selftest', 50)].join('\n'), 'utf-8')
    const r = spawnSync(process.execPath, [SCRIPT, '--log', log], { encoding: 'utf-8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('every source in the window is decided')
    expect(r.stdout).not.toContain('UNDECIDED SOURCES')
  })

  it('reports how much of "work" rests on the DEFAULT source, which this fix does not close', () => {
    // `bare` is local-llm.sh's default, so it is a catch-all of its own: a caller that passes no
    // --source is counted as work whatever it was doing. Measured in the live log:
    // caller=backend-selftest, source=bare, 14.4s. Flipping the source polarity cannot reach that,
    // so the share is printed instead of being left implicit.
    const dir = mkdtempSync(join(tmpdir(), 'usage-share-bare-'))
    const log = join(dir, 'usage.log')
    writeFileSync(log, [row(T, 'rag', 10), row(T, 'bare', 10), row(T, 'bare', 10)].join('\n'), 'utf-8')
    const r = spawnSync(process.execPath, [SCRIPT, '--log', log], { encoding: 'utf-8' })
    expect(r.stdout).toContain('2 came from the DEFAULT source `bare` (66.7%)')
  })
})
