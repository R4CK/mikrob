// The live offload path must refuse a STALE build, not just a missing one (card a3611ecc).
//
// The failure being pinned actually happened: src/local-llm-router.ts changed at 09:56, dist/
// local-llm-router.js was built at 07:34, the card showed 100% with two gate PASSes, and every
// offload call went on being judged by the previous routing logic. Nothing compared the artifact to
// its source, so nothing said a word.
//
// TWO LEVELS, on purpose:
//   1. store/build-freshness.mjs directly -- fresh / stale / "cannot tell", including a module DEEP
//      in the import graph, because a check that only looks at the entry file would pass every one
//      of those cases and look identical here.
//   2. the real store/local-llm-rag.sh end to end -- the card asks for proof on the live path, and a
//      unit test cannot show that the wiring runs BEFORE the router is trusted.
//
// THE CONTROL PAIR IS THE POINT. Both end-to-end cases exit 9, so an exit code proves nothing on its
// own: a sandbox whose stub router simply failed to load would ALSO exit 9 (fail-closed router-error
// -- the exact trap card 37756c9c's suite documented). So the two runs share one sandbox, one set of
// files, and differ in a single mtime; the fresh run must reach the stub and quote IT.
import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, utimesSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MODULE = join(ROOT, 'store', 'build-freshness.mjs')

type Freshness = { status: 'fresh' | 'stale' | 'unknown'; reason: string; checked: number }
let checkBuildFreshness: (entry: string, opts?: { srcRoot?: string; distRoot?: string }) => Freshness

/** A tree with a two-hop import graph: entry -> mid -> leaf, each with a source counterpart. */
function tree(): { dir: string; dist: string; src: string } {
  const dir = mkdtempSync(join(tmpdir(), 'freshness-'))
  const dist = join(dir, 'dist')
  const src = join(dir, 'src')
  mkdirSync(join(dist, 'web'), { recursive: true })
  mkdirSync(join(src, 'web'), { recursive: true })
  writeFileSync(join(dist, 'entry.js'), "import { mid } from './web/mid.js'\nexport const entry = mid\n")
  writeFileSync(join(dist, 'web', 'mid.js'), "export { leaf as mid } from '../leaf.js'\n")
  writeFileSync(join(dist, 'leaf.js'), 'export const leaf = 1\n')
  for (const [rel, text] of [
    ['entry.ts', 'export const entry = 1\n'],
    [join('web', 'mid.ts'), 'export const mid = 1\n'],
    ['leaf.ts', 'export const leaf = 1\n'],
  ] as const) {
    writeFileSync(join(src, rel), text)
  }
  // Build order: sources first, artifacts after -- which is what "freshly built" means on disk.
  const now = Date.now() / 1000
  for (const f of ['entry.ts', join('web', 'mid.ts'), 'leaf.ts']) utimesSync(join(src, f), now - 60, now - 60)
  for (const f of ['entry.js', join('web', 'mid.js'), 'leaf.js']) utimesSync(join(dist, f), now, now)
  return { dir, dist, src }
}

function backdate(file: string, seconds: number): void {
  const t = statSync(file).mtimeMs / 1000 - seconds
  utimesSync(file, t, t)
}

beforeAll(async () => {
  ;({ checkBuildFreshness } = (await import(MODULE)) as { checkBuildFreshness: typeof checkBuildFreshness })
})

describe('checkBuildFreshness (card a3611ecc)', () => {
  it('a freshly built tree is fresh -- and says how much it actually checked', () => {
    const { dist, src } = tree()
    const r = checkBuildFreshness(join(dist, 'entry.js'), { srcRoot: src })
    expect(r.status).toBe('fresh')
    expect(r.checked).toBe(3) // the whole graph, not just the file we handed it
  })

  it('the ENTRY being older than its source is stale, and the message names the source', () => {
    const { dist, src } = tree()
    backdate(join(dist, 'entry.js'), 3600)
    const r = checkBuildFreshness(join(dist, 'entry.js'), { srcRoot: src })
    expect(r.status).toBe('stale')
    expect(r.reason).toContain('entry.ts')
    expect(r.reason).toContain('npm run build') // condition: tell the caller what to DO
  })

  it('a module TWO HOPS IN being stale is caught -- the entry alone would look current', () => {
    // The real graph is 19 modules deep and the routing constants (RELIABLE_CEILING,
    // isDraftableLocally) live in the imported module, not the entry. An entry-only check would
    // have passed the exact shape of the incident this card came from.
    const { dist, src } = tree()
    backdate(join(dist, 'leaf.js'), 3600)
    expect(checkBuildFreshness(join(dist, 'entry.js'), { srcRoot: src })).toMatchObject({ status: 'stale' })
    expect(checkBuildFreshness(join(dist, 'entry.js'), { srcRoot: src }).reason).toContain('leaf.ts')
  })

  it('no source tree at all is UNKNOWN, not fresh', () => {
    // A dist-only box cannot establish that what it runs is current. "I cannot tell" must not be
    // spelled "fine" -- that is the whole failure mode this card exists for.
    const { dir, dist, src } = tree()
    rmSync(src, { recursive: true, force: true })
    const r = checkBuildFreshness(join(dist, 'entry.js'), { srcRoot: src })
    expect(r.status).toBe('unknown')
    expect(r.reason).toContain('no source tree')
    expect(dir).toBeTruthy()
  })

  it('a loaded module with no source counterpart is UNKNOWN, not silently skipped', () => {
    const { dist, src } = tree()
    rmSync(join(src, 'leaf.ts'))
    expect(checkBuildFreshness(join(dist, 'entry.js'), { srcRoot: src })).toMatchObject({ status: 'unknown' })
  })

  it('a missing artifact is UNKNOWN (the caller handles "not built", but never gets `fresh` here)', () => {
    const { dist, src } = tree()
    rmSync(join(dist, 'entry.js'))
    expect(checkBuildFreshness(join(dist, 'entry.js'), { srcRoot: src })).toMatchObject({ status: 'unknown' })
  })

  it('the real dist/local-llm-router.js is fresh in this checkout, or the suite is testing a stale build', () => {
    // Not decoration: if this fails, every OTHER router test in this repo is measuring an artifact
    // nobody rebuilt -- which is precisely how the incident got through two gates.
    const r = checkBuildFreshness(join(ROOT, 'dist', 'local-llm-router.js'))
    expect(r.status, r.reason).not.toBe('stale')
  })
})

// --- the live path ------------------------------------------------------------------------------
describe('store/local-llm-rag.sh refuses a stale build (card a3611ecc)', () => {
  let sandbox: string
  let router: string

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'rag-stale-'))
    mkdirSync(join(sandbox, 'store'))
    mkdirSync(join(sandbox, 'dist'))
    mkdirSync(join(sandbox, 'src'))
    copyFileSync(join(ROOT, 'store', 'local-llm-rag.sh'), join(sandbox, 'store', 'local-llm-rag.sh'))
    copyFileSync(MODULE, join(sandbox, 'store', 'build-freshness.mjs'))
    // A stub router with a verdict nothing else in the script could produce, so "the fresh run
    // reached the router" is provable from the output rather than assumed.
    router = join(sandbox, 'dist', 'local-llm-router.js')
    writeFileSync(router, "export function routeTask() { return { route: 'online', reason: 'STUB-ROUTER-WAS-REACHED' } }\n")
    writeFileSync(join(sandbox, 'src', 'local-llm-router.ts'), 'export function routeTask() { return null }\n')
    // A token must exist (the script refuses without one); it need not work -- DASHBOARD_URL below
    // points at a closed port, so retrieval degrades exactly as it does offline.
    writeFileSync(join(sandbox, 'store', '.dashboard-token'), 'not-a-real-token\n')
    const now = Date.now() / 1000
    utimesSync(join(sandbox, 'src', 'local-llm-router.ts'), now - 60, now - 60)
    utimesSync(router, now, now)
  })

  function run(): { status: number; stderr: string } {
    const r = spawnSync('bash', [join(sandbox, 'store', 'local-llm-rag.sh'), '--agent', 'backend2', 'rename a button label'], {
      encoding: 'utf-8',
      timeout: 120_000,
      env: { ...process.env, DASHBOARD_URL: 'http://127.0.0.1:9', LOCAL_LLM_ADVISORY: '0' },
    })
    return { status: r.status ?? -1, stderr: r.stderr ?? '' }
  }

  it('CONTROL: with the artifact newer than its source, the run reaches the router and quotes it', () => {
    const r = run()
    expect(r.stderr).toContain('STUB-ROUTER-WAS-REACHED')
    expect(r.stderr).not.toContain('stale build')
    expect(r.status).toBe(9)
  })

  it('back-dating that ONE artifact stops the run before the router is trusted', () => {
    backdate(router, 3600)
    const r = run()
    expect(r.stderr).toContain('ROUTE=online')
    expect(r.stderr).toContain('stale build: ') // "is out of date", not the "cannot tell" wording
    expect(r.stderr).toContain('npm run build') // speaking: says what to do, not just that it failed
    expect(r.stderr).not.toContain('STUB-ROUTER-WAS-REACHED') // the stale judge never got asked
    expect(r.status).toBe(9)
  })

  it('the advisory draft is skipped too -- a stale build is treated like a missing one', () => {
    // Otherwise the local model would still be handed a task that the rebuilt router might have
    // refused outright, which is the same gap wearing a different hat.
    backdate(router, 3600)
    const r = spawnSync('bash', [join(sandbox, 'store', 'local-llm-rag.sh'), '--agent', 'backend2', 'rename a button label'], {
      encoding: 'utf-8',
      timeout: 120_000,
      env: { ...process.env, DASHBOARD_URL: 'http://127.0.0.1:9', LOCAL_LLM_ADVISORY: '1' },
    })
    expect(r.stderr ?? '').toContain('advisory draft SKIPPED')
    expect(r.status).toBe(9)
  })

  it('"cannot tell" reads differently from "out of date" -- same refusal, different fact', () => {
    // Runs last: it removes the sandbox's source tree. A caller told "stale build" would go run a
    // build; on a box with no sources that is a wasted trip, so the two cases must not share wording.
    rmSync(join(sandbox, 'src'), { recursive: true, force: true })
    const r = run()
    expect(r.stderr).toContain('stale build check inconclusive')
    expect(r.stderr).toContain('no source tree')
    expect(r.status).toBe(9)
  })
})
