// Card d5638d28 round 2 (CYBERED NO-GO 32207 F3, MikroB Fix-Direction 32209 #3): "one switch-file
// contract" is a claim about TWO implementations agreeing (the TS guard this test's own module
// imports, and the python3 one-liner embedded in store/marveen-land.sh, which bash cannot share
// code with directly). This test extracts that python3 snippet VERBATIM out of the live script
// (not a hand-copied duplicate that could drift) and feeds both sides the same fixture set, so a
// future edit to either side that breaks the agreement fails here instead of surfacing as the
// split RedHat measured (TS said OFF, bash said ON for the same malformed file).
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { degradedOrchestratorSwitchPath, readDegradedOrchestratorState } from '../degraded-orchestrator-guard.js'

const LAND_SCRIPT = join(import.meta.dirname, '..', '..', 'store', 'marveen-land.sh')

function extractPythonSnippet(): string {
  const src = readFileSync(LAND_SCRIPT, 'utf-8')
  const start = src.indexOf("python3 -c '")
  if (start < 0) throw new Error('marveen-land.sh: python3 -c snippet marker not found -- script shape changed')
  const bodyStart = start + "python3 -c '".length
  const end = src.indexOf("'", bodyStart)
  if (end < 0) throw new Error('marveen-land.sh: python3 -c closing quote not found')
  return src.slice(bodyStart, end)
}

// CYBERED NO-GO 32605 (card e3cf26d0 round 4): the missing-file short-circuit itself has TWO
// cases in store/marveen-land.sh (lines 120-131), not one -- an override pointing at nothing is
// an unverifiable caller misconfiguration (fail-closed ON), only the genuine default never
// having been written is the legitimate OFF (Kesz, ha #1). `overrideSet` mirrors that branch;
// it is irrelevant (and defaulted) for every fixture row below that writes a real file, since
// existsSync is true there regardless of override status.
function bashSideIsOn(fixturePath: string, overrideSet = false): boolean {
  // Mirrors the bash function's own `[ -e "$path" ] || { ...; return 1; }` lines, which run
  // BEFORE python is ever invoked -- the extracted snippet alone does not include that
  // short-circuit.
  if (!existsSync(fixturePath)) return overrideSet
  const script = extractPythonSnippet()
  try {
    execFileSync('python3', ['-c', script, fixturePath], { stdio: 'pipe' })
    return true // exit 0 = ON (blocking)
  } catch (err) {
    const e = err as { status?: number }
    if (e.status === 1) return false // exit 1 = OFF
    throw err
  }
}

function tsSideIsOn(fixturePath: string): boolean {
  return readDegradedOrchestratorState(fixturePath) !== 'off'
}

describe('TS guard vs bash land-guard: identical classification for every fixture (card d5638d28 round 2)', () => {
  const dir = mktemp()
  function mktemp(): string {
    return mkdtempSync(join(tmpdir(), 'degraded-switch-parity-'))
  }

  const FIXTURES: { name: string; json: string | null }[] = [
    { name: 'valid on: {"enabled": true}', json: '{"enabled": true}' },
    { name: 'valid off: {"enabled": false}', json: '{"enabled": false}' },
    { name: 'bare true', json: 'true' },
    { name: 'bare empty array', json: '[]' },
    { name: 'bare string "on"', json: '"on"' },
    { name: 'bare number 1', json: '1' },
    { name: 'bare null', json: 'null' },
    { name: 'empty object {}', json: '{}' },
    { name: 'string-typed enabled: {"enabled": "true"}', json: '{"enabled": "true"}' },
    { name: 'number-typed enabled: {"enabled": 1}', json: '{"enabled": 1}' },
    // Card d5638d28 round 3 (RedHat NO-GO 32245 F4c): FALSY non-boolean values -- these would
    // read as OFF in bash if the `isinstance(data["enabled"], bool)` check ever regressed to a
    // plain truthiness check (Python's `0`/`""`/`None` are all falsy), while the string "true"
    // fixture above reads ON "by accident" either way -- so that one fixture alone could not have
    // caught this regression class.
    { name: 'falsy number-typed enabled: {"enabled": 0}', json: '{"enabled": 0}' },
    { name: 'falsy string-typed enabled: {"enabled": ""}', json: '{"enabled": ""}' },
    { name: 'null-typed enabled: {"enabled": null}', json: '{"enabled": null}' },
    { name: 'typo key: {"Enabled": true}', json: '{"Enabled": true}' },
    { name: 'extra key: {"enabled": false, "note": "x"}', json: '{"enabled": false, "note": "x"}' },
    { name: 'malformed JSON', json: '{not valid json' },
  ]

  it.each(FIXTURES)('$name: TS and bash agree', ({ json }) => {
    const path = join(dir, 'degraded-orchestrator-enabled.json')
    try {
      if (json !== null) writeFileSync(path, json)
      const tsOn = tsSideIsOn(path)
      const bashOn = bashSideIsOn(path)
      expect(bashOn).toBe(tsOn)
    } finally {
      rmSync(path, { force: true })
    }
  })

  // CYBERED NO-GO 32605: the two missing-file rows below replace the old single "missing file"
  // fixture, which drove the TS side with an EXPLICIT path argument -- a call shape no real
  // caller uses (every production call site passes no argument at all; a caller either sets the
  // env override or relies on the default). readDegradedOrchestratorState() treats "explicit
  // argument, missing" as unreadable (card e3cf26d0 round 2), which disagreed with the bash
  // mirror's "missing = OFF" and was a stale pin, not a behaviour hole: driven the way production
  // actually calls it, the two sides already agree.
  it('missing file, override set to a missing path: TS and bash agree (ON)', () => {
    const missingPath = join(dir, 'override-missing.json')
    const prev = process.env.DEGRADED_ORCHESTRATOR_SWITCH
    process.env.DEGRADED_ORCHESTRATOR_SWITCH = missingPath
    try {
      const tsOn = readDegradedOrchestratorState() !== 'off' // no explicit arg -- the real call shape
      const bashOn = bashSideIsOn(missingPath, true)
      expect(bashOn).toBe(tsOn)
    } finally {
      if (prev === undefined) delete process.env.DEGRADED_ORCHESTRATOR_SWITCH
      else process.env.DEGRADED_ORCHESTRATOR_SWITCH = prev
    }
  })

  // Safe to run for real: fleet-test.sh builds a throwaway checkout, so the genuine production
  // default (PROJECT_ROOT/store/degraded-orchestrator-enabled.json) never exists there -- same
  // reasoning degraded-orchestrator-guard.test.ts's own default-path test already relies on.
  it('missing file, genuine default (no override, no explicit arg): TS and bash agree (OFF)', () => {
    const prev = process.env.DEGRADED_ORCHESTRATOR_SWITCH
    delete process.env.DEGRADED_ORCHESTRATOR_SWITCH
    try {
      const tsOn = readDegradedOrchestratorState() !== 'off'
      const bashOn = bashSideIsOn(degradedOrchestratorSwitchPath(), false)
      expect(bashOn).toBe(tsOn)
    } finally {
      if (prev === undefined) delete process.env.DEGRADED_ORCHESTRATOR_SWITCH
      else process.env.DEGRADED_ORCHESTRATOR_SWITCH = prev
    }
  })

  it('cleanup', () => {
    rmSync(dir, { recursive: true, force: true })
  })
})
