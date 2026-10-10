import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// Exit-code contract of scripts/hooks/outgoing-copy-gate.py on malformed
// input (the crash-vs-fail-closed regression), plus the FIFOTIMEOUT924
// regression (card 0dab76a3, Cybered C1 HIGH on 087e4418): a `< fifo`
// redirect body must be denied fast, never hang past the hook's real
// timeout. This suite had no CI wrapper before -- it only ran when invoked
// by hand -- so this wrapper makes it a gate, the same pattern as the
// email-approval-gate.py / email-extract-parity.test.py python suites.
const ROOT = join(__dirname, '..', '..')

describe('outgoing-copy-gate fail-closed contract', () => {
  it('the python suite passes (crash-exit-code net + FIFO fast-deny)', () => {
    const res = spawnSync('python3', [join(ROOT, 'scripts', '__tests__', 'outgoing-copy-gate-failclosed.test.py')], {
      encoding: 'utf-8',
      timeout: 30_000,
    })
    if (res.status !== 0) {
      console.error(res.stdout)
      console.error(res.stderr)
    }
    expect(res.status).toBe(0)
  }, 35_000)
})
