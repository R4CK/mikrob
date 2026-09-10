// No suite may take the LIVE, fleet-wide GPU lock (card f3b219bb).
//
// THE DEFECT. store/local-llm.sh resolves `GPU_LOCK="${LOCAL_LLM_GPU_LOCK_PATH:-/tmp/local-llm-gpu.lock}"`.
// A test that execs the real script without overriding that variable competes for the same lock as
// every genuine local-llm.sh call on the fleet. Under load the script gives up -- `gpu lock busy --
// could not acquire within 30s`, exit 6 -- and a landing fails over machine load rather than over
// anything in the diff. It was measured doing exactly that (DECISIONS.md: "elso futas 4 helyi-llm/
// GPU-lock hibaval bukott ... masodik futas valtoztatas nelkul 644/644 fajl zold").
//
// WHY A TEST AND NOT JUST THE SETUP FILE. The first round of this card patched the two files that
// happened to flake, individually, and four more were still taking the real lock on develop months
// later. The setup file now sets the variable once per worker; this pins that it STAYS set, and
// that no future suite re-hardcodes the real path -- the structural half, so the guarantee does not
// rest on the next author remembering.
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const REAL_LOCK = '/tmp/local-llm-gpu.lock'

describe('local-LLM GPU lock isolation (card f3b219bb)', () => {
  it('the global setup points this worker at a throwaway lock, not the fleet-wide one', () => {
    const lock = process.env.LOCAL_LLM_GPU_LOCK_PATH
    expect(lock, 'setup/isolate-local-llm-state.ts did not set LOCAL_LLM_GPU_LOCK_PATH').toBeTruthy()
    expect(lock).not.toBe(REAL_LOCK)
  })

  it('the default in local-llm.sh is still the real lock -- this test would be vacuous otherwise', () => {
    // Pins the premise. If the script stopped defaulting to the shared path, the isolation above
    // would be guarding nothing and this file should be reconsidered rather than left green.
    const sh = readFileSync(join(HERE, '..', '..', 'store', 'local-llm.sh'), 'utf8')
    expect(sh).toContain(`\${LOCAL_LLM_GPU_LOCK_PATH:-${REAL_LOCK}}`)
  })

  it('no test file hardcodes the REAL fleet-wide lock path', () => {
    // A suite that sets LOCAL_LLM_GPU_LOCK_PATH back to the real path would defeat the setup file
    // while looking deliberate. Prose in a comment is fine -- an assignment is not.
    const offenders: string[] = []
    for (const name of readdirSync(HERE)) {
      if (!name.endsWith('.test.ts') || name === 'local-llm-gpu-lock-isolation.test.ts') continue
      const src = readFileSync(join(HERE, name), 'utf8')
      // Comments quote the path deliberately (this file does too), so only an ASSIGNMENT counts.
      const assigns = new RegExp(`LOCAL_LLM_GPU_LOCK_PATH\\s*[:=]\\s*['"\`]${REAL_LOCK}`)
      if (assigns.test(src)) offenders.push(name)
    }
    expect(
      offenders,
      'these suites point the GPU lock back at the live fleet-wide path -- use a throwaway path',
    ).toEqual([])
  })
})
