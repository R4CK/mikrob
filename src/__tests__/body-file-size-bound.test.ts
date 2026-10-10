import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// SIZEBOUND924 (card 14256aac, Cybersec NO-GO F1 on e8b479d0): outgoing-copy-gate.py's
// _safe_read_text size cap enforced only fstat's st_size, which is 0 on procfs/sysfs
// regardless of real content length, and can change on a sparse file mid-read -- so the
// cap was enforceable, not enforced. Fixed by bounding the actual read() call. This
// wrapper makes the python regression suite a CI gate, matching the
// email-approval-gate.test.ts / email-extract-parity.test.ts pattern.
const ROOT = join(__dirname, '..', '..')

describe('outgoing-copy-gate body-file size bound (SIZEBOUND924)', () => {
  it('the python suite passes (honest oversize + lying-fstat + control)', () => {
    const res = spawnSync('python3', [join(ROOT, 'scripts', '__tests__', 'body-file-size-bound.test.py')], {
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
