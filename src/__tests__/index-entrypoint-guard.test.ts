// Card d91550bc: src/index.ts's `main().catch(...)` used to fire UNCONDITIONALLY at
// module-load time, with no `require.main === module` / `import.meta.url` guard. Nothing
// imports index.ts today (verified by grep before this fix), so this was a live but
// dormant risk, not yet the trigger of any incident -- but the moment anything ever
// imports it (a test, a future refactor reusing a type/constant), the FULL boot sequence
// (real initDatabase(), a real WEB_PORT bind that can SIGTERM whatever else holds it,
// heartbeat/watcher timers) would fire as an import side effect, invisible to and
// unblockable by assert-not-live-install.ts (that guard only catches a live install
// being the TEST TREE, not an accidental import triggering IT to boot for real).
//
// SAFETY OF THIS TEST ITSELF. The whole point is that main()'s side effects are
// dangerous, so this test must never let them run for real even if the guard it exists
// to catch a regression in is broken. The three modules that do real, external-state
// work (a real WEB_PORT bind/kill, a real database file, a real HTTP server) are fully
// mocked before the dynamic import; everything else index.ts imports is already proven
// safe to import by the hundreds of other test files that import it transitively.
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const INDEX_TS = join(__dirname, '..', 'index.ts')
const SRC = readFileSync(INDEX_TS, 'utf-8')

const acquirePortLock = vi.fn().mockResolvedValue(undefined)
const acquirePidfileLock = vi.fn().mockResolvedValue(undefined)
const initDatabase = vi.fn()
const backfillEmbeddings = vi.fn().mockResolvedValue(0)
const startWebServer = vi.fn().mockReturnValue({ close: vi.fn() })

vi.mock('../process-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../process-lock.js')>()
  return { ...actual, acquirePortLock, acquirePidfileLock }
})
vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return { ...actual, initDatabase, backfillEmbeddings }
})
vi.mock('../web.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web.js')>()
  return { ...actual, startWebServer }
})

describe('index.ts source: the guard exists and wraps the right statement (card d91550bc)', () => {
  it('main().catch( is no longer the first thing at module scope -- it sits inside an if', () => {
    const guardIdx = SRC.indexOf('if (process.argv[1] === fileURLToPath(import.meta.url)) {')
    const callIdx = SRC.indexOf('main().catch((err) => {')
    expect(guardIdx, 'the guard condition is missing entirely').toBeGreaterThan(-1)
    expect(callIdx, 'main().catch( is missing entirely').toBeGreaterThan(-1)
    expect(callIdx).toBeGreaterThan(guardIdx)
    // And nothing but the guard's own opening brace sits between them -- so the call is
    // the if's immediate body, not merely somewhere later in the file.
    const between = SRC.slice(guardIdx + 'if (process.argv[1] === fileURLToPath(import.meta.url)) {'.length, callIdx)
    expect(between.trim()).toBe('')
  })

  it('imports fileURLToPath from node:url', () => {
    expect(SRC).toContain("import { fileURLToPath } from 'node:url'")
  })
})

describe('index.ts, dynamically imported as a NON-entry module, never runs main() (card d91550bc)', () => {
  beforeAll(async () => {
    // The defect this reproduces: something OTHER than "node/tsx index.ts directly"
    // importing the module. process.argv[1] here is whatever launched the test runner,
    // which is never index.ts's own path.
    expect(process.argv[1]).not.toBe(fileURLToPath(new URL('../index.ts', import.meta.url)))
    await import('../index.js')
  })

  it('never acquires the port lock', () => {
    expect(acquirePortLock).not.toHaveBeenCalled()
  })

  it('never acquires the pidfile lock', () => {
    expect(acquirePidfileLock).not.toHaveBeenCalled()
  })

  it('never touches the database', () => {
    expect(initDatabase).not.toHaveBeenCalled()
    expect(backfillEmbeddings).not.toHaveBeenCalled()
  })

  it('never starts the web server', () => {
    expect(startWebServer).not.toHaveBeenCalled()
  })
})
