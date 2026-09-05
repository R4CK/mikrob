// saveMemory must vectorise on WRITE, like saveAgentMemory (card f27c999b, B-wave 4/6).
//
// The two writers had drifted: saveAgentMemory generated an embedding, saveMemory did not, so a row
// written through the second path reached semantic search only once backfillEmbeddings() ran -- and
// that runs at STARTUP (index.ts), not on a timer. The nightly daily-log digest is written through
// saveMemory, so its row was unsearchable until the next restart.
//
// MEASURED, and it corrects the note that asked for this fix: 0 of 1509 rows on the live install are
// unvectorised, including all 20 digest rows. The backfill works. What was wrong was the WINDOW and
// the dependency on a sweep nobody schedules -- not a permanent hole. Saying it the stronger way
// would have sent the next reader looking for missing rows that are not missing.
//
// Asserted on the SOURCE rather than by writing to a database: the embedding call is fire-and-forget
// (deliberately -- a memory write must not wait on Ollama), so a behavioural test would race it, and
// mocking the generator would only prove the mock was called.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DB_TS = readFileSync(join(import.meta.dirname, '..', 'db.ts'), 'utf-8')

/** The body of one exported function, from its signature to the next top-level `export`. */
function functionBody(name: string): string {
  const start = DB_TS.indexOf(`export function ${name}(`)
  expect(start, `${name} not found in db.ts`).toBeGreaterThan(-1)
  const next = DB_TS.indexOf('\nexport ', start + 1)
  return DB_TS.slice(start, next > start ? next : undefined)
}

describe('both memory writers vectorise on write', () => {
  it.each(['saveMemory', 'saveAgentMemory'])('%s generates an embedding', (fn) => {
    const body = functionBody(fn)
    expect(body).toContain('generateEmbedding(')
    expect(body).toContain('UPDATE memories SET embedding = ? WHERE id = ?')
  })

  it.each(['saveMemory', 'saveAgentMemory'])('%s captures lastInsertRowid to update the right row', (fn) => {
    // Without the id the UPDATE has nothing to target, and an embedding written against the wrong
    // row is worse than none: it makes an unrelated memory match a query it has nothing to do with.
    const body = functionBody(fn)
    expect(body).toContain('lastInsertRowid')
  })

  it.each(['saveMemory', 'saveAgentMemory'])('%s does not let an embedding failure break the write', (fn) => {
    // Fire-and-forget on purpose: Ollama being down must cost the vector, never the memory.
    expect(functionBody(fn)).toMatch(/\.catch\(\(\)\s*=>\s*\{?\s*\}?\)/)
  })

  it('the startup backfill still exists -- this fix narrows the window, it does not replace it', () => {
    // Rows written before this change, and any write whose embedding call failed, still depend on
    // backfillEmbeddings(). Removing it while calling this "fixed" would strand exactly those.
    expect(DB_TS).toContain('export async function backfillEmbeddings()')
    expect(DB_TS).toContain("SELECT id, content, keywords FROM memories WHERE embedding IS NULL")
  })
})
