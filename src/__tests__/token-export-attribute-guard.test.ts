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

const SCRIPTS = [
  'local-llm-rag.sh',
  'card-build-route.sh',
  'self-advance-pickup.sh',
  'decompose-type-stop.sh',
  'card-build-route-24h-measure.sh',
  'kanban-snapshot.sh',
]

describe('TOKEN export-attribute guard present right after loading the dashboard token (card 2d4c7943)', () => {
  for (const script of SCRIPTS) {
    it(`${script} drops the export attribute immediately after assigning TOKEN from the token file`, () => {
      const src = readFileSync(join(STORE_DIR, script), 'utf-8')
      const assignMatch = src.match(/^[ \t]*TOKEN="\$\(cat .*$/m)
      expect(assignMatch, `${script}: no TOKEN="$(cat ...)" assignment found`).not.toBeNull()
      const assignIdx = assignMatch!.index!
      const assignLineEnd = src.indexOf('\n', assignIdx)
      // card-build-route.sh indents this assignment inside an `if` block -- the guard follows on
      // the next NON-COMMENT statement line, skipping the explanatory comment lines in between.
      const after = src.slice(assignLineEnd + 1, assignLineEnd + 1 + 600)
      const nextStatementLine = after
        .split('\n')
        .find((line) => line.trim().length > 0 && !line.trim().startsWith('#'))
      expect(nextStatementLine?.trim(), `${script}: next statement after TOKEN assignment is not the export-attribute guard`).toBe('declare +x TOKEN')
    })
  }
})
