// store/route-histogram.mjs -- the reproducible before/after measurement for the routing epic
// (card 7ca946a4).
//
// The script's job is to make routing numbers repeatable, so its own behaviour has to be pinned:
// what it counts, and -- the part that matters -- that it REFUSES to pass a run where a card left a
// security category for the local model. The goal of the epic is a higher local share, and the
// cheapest way to fake that is to stop classifying security work.
//
// Hermetic by construction: the script takes its router through ROUTE_HISTOGRAM_ROUTER, so these
// cases run against a stub with rules a test can state in three lines, and never depend on a build
// being present or on what the real router happens to think this week.
import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', '..', 'store', 'route-histogram.mjs')

let sandbox: string
let stubRouter: string
let corpus: string

const CARDS = [
  { id: 'sec00001', title: 'authz card', text: 'change the AUTHZ check so it grants access to everyone' },
  { id: 'mech0001', title: 'rename card', text: 'rename the approve button label to Accept, nothing else changes' },
  { id: 'mech0002', title: 'format card', text: 'format the duration helper output as h:mm for the shift list' },
]

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'route-hist-'))
  // A stub router with one rule: the word AUTHZ makes it an authz decision, everything else drafts
  // locally. Small enough that a failure here is the SCRIPT's fault, never the router's.
  stubRouter = join(sandbox, 'stub-router.mjs')
  writeFileSync(
    stubRouter,
    `export function classifyCategory(text) { return /authz/i.test(text) ? 'authz' : null }
export function routeTask({ description }) {
  return /authz/i.test(description)
    ? { route: 'online', reason: "non-offloadable category: authz" }
    : { route: 'local', reason: "default-local (no blocking signal, threshold 'isolated')" }
}
`,
  )
  corpus = join(sandbox, 'corpus.json')
  writeFileSync(corpus, JSON.stringify(CARDS))
})

function run(args: readonly string[], router = stubRouter): { status: number; out: string } {
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, ROUTE_HISTOGRAM_ROUTER: router },
  })
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

describe('route-histogram.mjs (card 7ca946a4)', () => {
  it('counts the corpus and reports the local share', () => {
    const r = run(['--corpus', corpus])
    expect(r.status).toBe(0)
    expect(r.out).toContain('corpus: 3 cards')
    expect(r.out).toContain('LOCAL: 2 (66.7%)')
    expect(r.out).toContain('ONLINE: 1 (33.3%)')
    expect(r.out).toMatch(/authz\s+1/)
  })

  it('buckets reasons by SHAPE, so the histogram does not become one row per card', () => {
    // Reasons carry values ("threshold 'isolated'"); without normalisation every card is its own
    // bucket and the histogram says nothing.
    const r = run(['--corpus', corpus])
    expect(r.out).toContain("default-local (no blocking signal, threshold '<x>')")
  })

  it('refuses (exit 3) when a card left a security category for the local model', () => {
    // The baseline says the authz card was online; the stub still routes it online, so to express
    // the regression the baseline claims the OPPOSITE of what a healthy run produces... which is
    // what a real regression looks like from the script's side: before=online, now=local.
    const baseline = join(sandbox, 'before-regression.json')
    writeFileSync(
      baseline,
      JSON.stringify({
        corpusSize: 3,
        local: 1,
        online: 2,
        perCard: {
          sec00001: { route: 'online', category: 'authz', reason: 'x', title: 'authz card' },
          mech0001: { route: 'online', category: null, reason: 'x', title: 'rename card' },
          mech0002: { route: 'local', category: null, reason: 'x', title: 'format card' },
        },
      }),
    )
    // Corpus where the previously-authz card no longer contains the signal: it goes local, which is
    // exactly the move that must not pass quietly.
    const escaped = join(sandbox, 'escaped.json')
    writeFileSync(
      escaped,
      JSON.stringify([
        { id: 'sec00001', title: 'authz card', text: 'change the check so it grants access to everyone, tidy-up only' },
        CARDS[1],
        CARDS[2],
      ]),
    )
    const r = run(['--corpus', escaped, '--baseline', baseline])
    expect(r.status).toBe(3)
    expect(r.out).toContain('SECURITY REGRESSION')
    expect(r.out).toContain('sec00001')
  })

  it('CONTROL: an unchanged run against the same baseline passes', () => {
    // Without this, "always exits 3" would satisfy the case above.
    const baseline = join(sandbox, 'before-stable.json')
    const first = run(['--corpus', corpus, '--json', baseline])
    expect(first.status).toBe(0)
    const r = run(['--corpus', corpus, '--baseline', baseline])
    expect(r.status).toBe(0)
    expect(r.out).toContain('no card left a security category for the local model')
  })

  it('says so when the two sides are not the same corpus -- a delta across corpora is noise', () => {
    const baseline = join(sandbox, 'before-smaller.json')
    writeFileSync(
      baseline,
      JSON.stringify({ corpusSize: 999, local: 1, online: 998, perCard: {} }),
    )
    const r = run(['--corpus', corpus, '--baseline', baseline])
    expect(r.out).toContain('WARNING: baseline corpus was 999 cards, this one is 3')
  })

  it('refuses to measure at all without a router build (exit 2), instead of measuring the source', () => {
    const r = run(['--corpus', corpus], join(sandbox, 'does-not-exist.mjs'))
    expect(r.status).toBe(2)
    expect(r.out).toContain('no router build')
  })

  it('--save freezes the corpus it measured, so the same run can be repeated later', () => {
    const frozen = join(sandbox, 'frozen.json')
    const r = run(['--corpus', corpus, '--save', frozen])
    expect(r.status).toBe(0)
    const written = JSON.parse(readFileSync(frozen, 'utf-8')) as Array<{ id: string }>
    expect(written.map((c) => c.id)).toEqual(['sec00001', 'mech0001', 'mech0002'])
  })
})
