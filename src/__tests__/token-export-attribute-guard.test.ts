// Card 2d4c7943 (613a8142 RedHat INFO follow-up): local-llm-rag.sh already closed the TOKEN
// export-attribute leak (613a8142 F1, `declare +x TOKEN` right after `TOKEN="$(cat ...)"`) --
// RedHat flagged that FIVE other store/ scripts load a dashboard token the same way and spawn a
// child process (curl/python3) afterward, without measuring whether the same inheritance class
// applies. All five do spawn children after the assignment, so the same fix was applied to each.
// This is a structural source check (the line immediately following the TOKEN assignment), the
// same technique the sibling scaffold-guard tests use -- it reads the one line whose presence IS
// the property under test, independent of which real caller does or doesn't export TOKEN today.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE_DIR = join(__dirname, '..', '..', 'store')
const REPO_ROOT = join(__dirname, '..', '..')

const SCRIPTS = [
  'local-llm-rag.sh',
  'card-build-route.sh',
  'self-advance-pickup.sh',
  'decompose-type-stop.sh',
  'card-build-route-24h-measure.sh',
  'kanban-snapshot.sh',
  'idle-shutdown-check.sh',
]

function checkGuard(absPath: string, label: string, varName: string): void {
  const src = readFileSync(absPath, 'utf-8')
  // Quotes around `$(cat ...)` vary by script (`TOKEN="$(cat x)"` vs `TOKEN=$(cat x)`), so the
  // assignment match tolerates either, anchored on the variable name actually used.
  const assignRx = new RegExp(`^[ \\t]*${varName}="?\\$\\(cat .*$`, 'm')
  const assignMatch = src.match(assignRx)
  expect(assignMatch, `${label}: no ${varName}=$(cat ...) assignment found`).not.toBeNull()
  const assignIdx = assignMatch!.index!
  const assignLineEnd = src.indexOf('\n', assignIdx)
  // card-build-route.sh indents this assignment inside an `if` block -- the guard follows on
  // the next NON-COMMENT statement line, skipping the explanatory comment lines in between.
  const after = src.slice(assignLineEnd + 1, assignLineEnd + 1 + 600)
  const nextStatementLine = after
    .split('\n')
    .find((line) => line.trim().length > 0 && !line.trim().startsWith('#'))
  expect(nextStatementLine?.trim(), `${label}: next statement after ${varName} assignment is not the export-attribute guard`).toBe(`declare +x ${varName}`)
}

describe('TOKEN export-attribute guard present right after loading the dashboard token (card 2d4c7943)', () => {
  for (const script of SCRIPTS) {
    it(`${script} drops the export attribute immediately after assigning TOKEN from the token file`, () => {
      checkGuard(join(STORE_DIR, script), script, 'TOKEN')
    })
  }
})

// Card 03d48dab (WhiteHat2 CYBERSEC GO N1 LOW, e912f7db follow-up): the same inheritance class
// also applies to scripts/ -- these spawn curl/mktemp/python3 children after loading the token
// from a file, same as the store/ scripts above. Measured on scripts/agent-msg.sh: an exported
// caller TOKEN survived the reassignment and reached the curl/python3 children's environment.
// store/sync-agent-templates.sh was also named in the N1 finding, but on inspection it never
// assigns a TOKEN/DASHBOARD_TOKEN variable itself (every "TOKEN=" occurrence in that file is
// either a comment or a heredoc test fixture for its own unrelated argv-leak scanner) -- there is
// no assignment to pin, so it is intentionally left out here, not silently dropped.
// scripts/pre-pr-review.sh was replaced wholesale (card 647e0b6f, upstream #1965 security
// hardening) with a version that never assigns DASHBOARD_TOKEN to a shell variable at all: the
// token file is read straight into a 0600 header file by write_header() (a python3 -I heredoc),
// so there is no shell variable whose export attribute could leak to a spawned child's
// environment in the first place -- the leak class this guard checks for cannot occur by
// construction. Same reasoning as the sync-agent-templates.sh carve-out above: no assignment
// to pin, so it is intentionally left out here, not silently dropped.
describe('TOKEN/DASHBOARD_TOKEN export-attribute guard present in scripts/ (card 03d48dab)', () => {
  const SCRIPTS_SCRIPTS_DIR: Array<{ file: string; varName: string }> = [
    { file: 'agent-msg.sh', varName: 'TOKEN' },
    { file: 'fleet-safe-start.sh', varName: 'TOKEN' },
    { file: 'watchdog.sh', varName: 'TOKEN' },
  ]
  for (const { file, varName } of SCRIPTS_SCRIPTS_DIR) {
    it(`scripts/${file} drops the export attribute immediately after assigning ${varName} from the token file`, () => {
      checkGuard(join(REPO_ROOT, 'scripts', file), `scripts/${file}`, varName)
    })
  }
})

// Card 02b5e13b (WhiteHat F1 follow-up on 647e0b6f, komment 22586): the carve-out comment above
// for pre-pr-review.sh asserts "no assignment to pin" -- true on today's source (verified: zero
// occurrences of the literal "DASHBOARD_TOKEN" anywhere in the file; the token travels only as a
// FILE PATH into write_header(), which reads it inside a python3 -I heredoc, never through a
// shell variable). But an absent assignment pattern is not itself pinned by anything above, so a
// mutant reintroducing `export DASHBOARD_TOKEN=...` (making the value inheritable by every
// curl/python3 child pre-pr-review.sh spawns afterward) survived the full suite unnoticed
// (measured by WhiteHat: 54/54 green). This test pins the ABSENCE, and -- if the absence is ever
// broken -- requires the same immediate `declare +x DASHBOARD_TOKEN` guard the checkGuard() cases
// above use, rather than silently allowing any reintroduction.
describe('pre-pr-review.sh never lets DASHBOARD_TOKEN become an exportable shell variable (card 02b5e13b)', () => {
  it('scripts/pre-pr-review.sh has no DASHBOARD_TOKEN shell-variable assignment without an immediate export-attribute guard', () => {
    const absPath = join(REPO_ROOT, 'scripts', 'pre-pr-review.sh')
    const src = readFileSync(absPath, 'utf-8')
    const assignRx = /^[ \t]*(export\s+)?DASHBOARD_TOKEN=.*$/m
    const match = src.match(assignRx)
    if (match === null) {
      // Current, intended shape: the token never becomes a shell variable at all, so there is
      // nothing for the export-attribute guard to apply to.
      return
    }
    const assignLineEnd = src.indexOf('\n', match.index!)
    const after = src.slice(assignLineEnd + 1, assignLineEnd + 1 + 600)
    const nextStatementLine = after
      .split('\n')
      .find((line) => line.trim().length > 0 && !line.trim().startsWith('#'))
    expect(
      nextStatementLine?.trim(),
      'scripts/pre-pr-review.sh: DASHBOARD_TOKEN was assigned to a shell variable without the ' +
        'export-attribute guard (`declare +x DASHBOARD_TOKEN`) immediately after it -- this is ' +
        'exactly the leak class card 02b5e13b/647e0b6f F1 found a surviving mutant for.'
    ).toBe('declare +x DASHBOARD_TOKEN')
  })
})
