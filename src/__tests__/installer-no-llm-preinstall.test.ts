// The installers must NOT install a local-LLM runtime or pull models (Peti directive 2026-08-13,
// EPIC ebc7b4dd / card fbbb4015). Models are chosen after boot, by the user, from a catalogue
// filtered to what the machine can actually run.
//
// THIS FILE REPLACES installer-ollama-nonfatal.test.ts, and the replacement is deliberate rather
// than a deletion. That test guarded "the ollama+pull step is NON-FATAL when the service is dead"
// (BC100FAIL810) -- a real defect, correctly pinned. Its subject no longer exists: the step is gone,
// so the test could only be deleted or inverted. Deleting it would leave the new rule unguarded, and
// re-adding a silent pre-install is a one-line change that nothing else would notice. So the guard
// is inverted: it now pins the ABSENCE of what the old test made safe.
//
// It matches on COMMANDS, not on the word "ollama": every one of these files legitimately mentions
// the runtime in prose and in the pointer to first-run-llm.sh, and a keyword guard would either fire
// on its own explanatory comment or have to be weakened until it caught nothing.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const INSTALLERS = ['install-linux.sh', 'install-macos.sh']

/** Strip comment lines so the file's own explanation of the rule cannot trip the rule. */
function code(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf-8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
}

// Each pattern is a COMMAND that would install a runtime or fetch a model.
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['runtime install via the vendor script', /curl[^\n|]*ollama\.com\/install\.sh\s*\|\s*sh/],
  ['runtime install via a package manager', /\b(brew|apt-get|apt|dnf|pacman)\s+install\b[^\n]*\bollama\b/],
  ['model pull via the CLI', /^[^\n]*\bollama\s+pull\b/m],
  ['model pull via the HTTP API', /\/api\/pull\b/],
  ['starting the runtime as a side effect', /\bollama\s+serve\b|systemctl\s+(--user\s+)?enable\s+--now\s+ollama/],
]

describe('installers do not pre-install a local LLM (EPIC ebc7b4dd)', () => {
  for (const rel of INSTALLERS) {
    for (const [label, rx] of FORBIDDEN) {
      it(`${rel}: no ${label}`, () => {
        const offending = code(rel)
          .split('\n')
          .filter((l) => rx.test(l))
        expect(
          offending,
          `${rel} would ${label} during install. Models are chosen after boot by the user ` +
            `(store/first-run-llm.sh); a pre-install is exactly what this EPIC removed.`,
        ).toEqual([])
      })
    }

    it(`${rel}: points the user at the post-boot chooser instead`, () => {
      // Removing the step without leaving a route to the replacement would be a silent capability
      // loss -- the user would simply never learn that a local model is possible.
      expect(readFileSync(join(ROOT, rel), 'utf-8')).toContain('first-run-llm.sh')
    })
  }

  it('the embedding pull moved to first-run rather than disappearing', () => {
    // The nomic-embed-text pull sat INSIDE the removed block. Semantic memory search depends on it,
    // and "it is gone from the installer" must not mean "it is gone". This asserts the dependency
    // has a new home, which is the half of the change that is easy to forget.
    const firstRun = readFileSync(join(ROOT, 'store', 'first-run-llm.sh'), 'utf-8')
    expect(firstRun).toMatch(/nomic-embed-text/)
    expect(firstRun).toMatch(/pull\s+"?\$EMBED_MODEL"?|pull\s+nomic-embed-text/)
  })

  it('installing a model never writes the fleet default as a side effect', () => {
    // Card 87d7c86f: the write to store/local-llm-model is its own explicit, logged verb. If a pull
    // path ever wrote it directly, a freshly downloaded and unmeasured model would become the
    // fleet's code oracle without anyone deciding so.
    const firstRun = readFileSync(join(ROOT, 'store', 'first-run-llm.sh'), 'utf-8')
    const writes = firstRun.split('\n').filter((l) => />\s*"\$MODEL_FILE"/.test(l))
    expect(writes.length, 'expected exactly one place that writes the model file').toBe(1)
    expect(writes[0]).toMatch(/printf/)
    // ...and it lives in the --use branch, not in an install path.
    const useBranch = firstRun.slice(firstRun.indexOf('--use'))
    expect(useBranch).toContain('> "$MODEL_FILE"')
  })
})
