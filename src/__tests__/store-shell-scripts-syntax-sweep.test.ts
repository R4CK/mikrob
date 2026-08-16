// Card 0623da8f: Cybered hit the SAME defect class twice (d7220a73/0a12077e first-run-llm.sh, then
// gate-dispatch-check.sh) -- a WHY-comment's own apostrophe closes a bash single-quoted block early
// (typically a `python3 -c '...'` heredoc), and the remainder of the embedded source runs as raw bash
// -- exit code 2, syntax error. Before this card, only install-linux.sh/install-macos.sh and
// first-run-llm.sh had a dedicated `bash -n` regression test; every other store/*.sh script (73 files
// at the time of writing) had no syntax coverage at all, so a third occurrence would only surface at
// runtime, on whichever agent happened to invoke that specific script next. This is the blanket sweep:
// every store/*.sh file, one `bash -n` check each, so a syntax error fails CI by name instead of
// waiting for a live invocation to find it.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const STORE_DIR = join(ROOT, 'store')

const scripts = readdirSync(STORE_DIR)
  .filter((f) => f.endsWith('.sh'))
  .sort()

// Not a defect in the sweep itself, but a defect in what it would be sweeping: an empty list would
// make every case below vacuously pass. store/ has carried dozens of *.sh scripts throughout this
// project's history, so a near-empty result means the directory listing broke, not that the fleet
// suddenly deleted its own tooling.
it('found a non-trivial number of store/*.sh scripts to check (sweep is not vacuous)', () => {
  expect(scripts.length).toBeGreaterThan(10)
})

describe.each(scripts)('%s', (name) => {
  it('is syntactically valid bash (bash -n)', () => {
    const r = spawnSync('bash', ['-n', join(STORE_DIR, name)], { encoding: 'utf-8' })
    expect(r.status, r.stderr).toBe(0)
  })
})
