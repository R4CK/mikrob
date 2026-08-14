// route-histogram.mjs -- what the offload router actually decides, on the real board (card 7ca946a4).
//
// WHY THIS EXISTS. Every routing change so far was argued with a number somebody produced by hand,
// in a scratch file, once. Two of those numbers were wrong in ways only a rerun caught (a "before"
// measured on a stale dist; a pair of counts that were not the same quantity). A tuning epic cannot
// run on measurements that are not reproducible, so this is the fixed one: same script, same corpus,
// same output, before and after every change.
//
// IT CALLS THE REAL routeTask FROM THE BUILD, never a re-implementation. A second copy of the rules
// would drift from the shipped one and would then be measuring itself -- which is how a tuning loop
// congratulates itself while the live path does something else. That also means the numbers describe
// the COMPILED artefact: build first, or you are grading yesterday's router.
//
// USAGE
//   node store/route-histogram.mjs                        # live board, print the histogram
//   node store/route-histogram.mjs --save corpus.json     # freeze the board for repeatable runs
//   node store/route-histogram.mjs --corpus corpus.json   # measure a frozen corpus
//   node store/route-histogram.mjs --corpus c.json --json out.json      # machine-readable result
//   node store/route-histogram.mjs --corpus c.json --baseline before.json   # before/after diff
//
// EXIT: 0 ok | 2 bad usage / no corpus | 3 a card moved from a SECURITY category to local
//
// Exit 3 is the point of the baseline mode. The goal of the epic is a higher local share, and the
// cheapest way to fake that is to stop classifying security work -- so the one direction that must
// never pass silently is a card leaving authz/isolation/security-decision for the local model. The
// script does not judge whether that was justified; it makes it impossible to ship unnoticed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROUTER = process.env.ROUTE_HISTOGRAM_ROUTER ?? join(HERE, '..', 'dist', 'local-llm-router.js')
const DASH = process.env.DASHBOARD_URL ?? 'http://localhost:3420'
const SECURITY_CATEGORIES = new Set(['authz', 'isolation', 'security-decision'])

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
}

if (!existsSync(ROUTER)) {
  console.error(`route-histogram: no router build at ${ROUTER} -- run \`npm run build\` first.`)
  console.error('Measuring the source instead would answer a question nobody asked: the fleet runs the build.')
  process.exit(2)
}
// ...and a build older than its source answers a question nobody asked either (card a3611ecc): the
// numbers would describe the routing this repo USED to do, which is the most misleading possible
// output from a tool whose entire job is to prove a routing change. Same exit 2 as no build at all.
// Skipped when a stub router is injected: the seam exists so tests can run against a router with no
// source tree, and "no source" is exactly the case the checker cannot decide.
// Same nullish test the ROUTER line above uses: an empty ROUTE_HISTOGRAM_ROUTER counts as SET
// there, so it has to count as set here too, or the two lines disagree about which router this is.
if ((process.env.ROUTE_HISTOGRAM_ROUTER ?? null) === null) {
  const { checkBuildFreshness } = await import(join(HERE, 'build-freshness.mjs'))
  const freshness = checkBuildFreshness(ROUTER)
  if (freshness.status !== 'fresh') {
    console.error(`route-histogram: ${freshness.status} build -- ${freshness.reason}`)
    process.exit(2)
  }
}
const { routeTask, classifyCategory } = await import(ROUTER)

/** The board as a corpus: one text per card, the same text the dispatch path would hand the router. */
async function liveCorpus() {
  const tokenFile = join(HERE, '.dashboard-token')
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf-8').trim() : ''
  const res = await fetch(`${DASH}/api/kanban`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  if (!res.ok) throw new Error(`kanban API answered ${res.status}`)
  const raw = await res.json()
  const cards = Array.isArray(raw) ? raw : (raw.cards ?? [])
  return cards.map((c) => ({ id: c.id, title: c.title ?? '', text: `${c.title ?? ''}\n${c.description ?? ''}`.trim() }))
}

const corpusFile = flag('--corpus')
const rawCorpus = corpusFile ? JSON.parse(readFileSync(corpusFile, 'utf-8')) : await liveCorpus()
const corpus = rawCorpus
  // A card with almost no text says nothing about the router and would only dilute the share.
  .filter((r) => (r.text ?? '').length > 20)

// AN EMPTY CORPUS IS NOT A CLEAN RUN (card b975dc0e, Cybersec on the 9446ddb GO). Everything below
// -- the shares, and above all the "no card left a security category" line -- is vacuously true of
// nothing, and this tool's machine-readable surface IS the exit code. A caller that feeds it a
// truncated or wrong-shaped corpus would read "no regression" from a measurement that never
// happened, which is the failure this script exists to prevent, aimed at itself.
//
// The two causes are separated because they need different fixes: an empty INPUT is a broken
// producer, while a full input filtered down to nothing means the rows do not carry `text` (the
// usual cause: a raw kanban dump, where the field is `description`).
if (corpus.length === 0) {
  console.error(`route-histogram: nothing to measure -- ${rawCorpus.length} row(s) in, 0 usable.`)
  if (rawCorpus.length > 0) {
    console.error("Every row was dropped by the >20-char `text` filter. A raw board dump has `title`/")
    console.error('`description`, not `text` -- map it first, or the run measures an empty set.')
  }
  process.exit(2)
}

const saveTo = flag('--save')
if (saveTo) {
  writeFileSync(saveTo, JSON.stringify(corpus, null, 1))
  console.log(`route-histogram: froze ${corpus.length} cards into ${saveTo}`)
}

// REASONS ARE FREE TEXT WITH VALUES IN THEM ("difficulty 'trivial' within threshold 'isolated'"), so
// a raw histogram would have one bucket per card. Bucketing on the shape keeps the kinds visible and
// the counts stable across runs; the per-card detail is in the JSON output for anyone who needs it.
const reasonKind = (reason) => String(reason ?? '').replace(/'[^']*'/g, "'<x>'")

const perCard = {}
const byCategory = new Map()
const byReason = new Map()
let local = 0
for (const row of corpus) {
  const decision = routeTask({ description: row.text })
  const category = classifyCategory(row.text)
  perCard[row.id] = { route: decision.route, category: category ?? null, reason: reasonKind(decision.reason), title: row.title.slice(0, 70) }
  if (decision.route === 'local') local++
  const catKey = category ?? '(none)'
  byCategory.set(catKey, (byCategory.get(catKey) ?? 0) + 1)
  byReason.set(perCard[row.id].reason, (byReason.get(perCard[row.id].reason) ?? 0) + 1)
}

const share = (n) => `${((100 * n) / corpus.length).toFixed(1)}%`
const sorted = (m) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
console.log(`corpus: ${corpus.length} cards (${corpusFile ?? 'live board'})   router: ${ROUTER}`)
console.log(`LOCAL: ${local} (${share(local)})   ONLINE: ${corpus.length - local} (${share(corpus.length - local)})`)
console.log('by category:')
for (const [k, n] of sorted(byCategory)) console.log(`   ${k.padEnd(20)} ${String(n).padStart(4)}  ${share(n)}`)
console.log('by reason:')
for (const [k, n] of sorted(byReason)) console.log(`   ${String(n).padStart(4)}  ${k}`)

const result = { corpusSize: corpus.length, local, online: corpus.length - local, perCard }
const jsonTo = flag('--json')
if (jsonTo) writeFileSync(jsonTo, JSON.stringify(result, null, 1))

const baselineFile = flag('--baseline')
if (baselineFile) {
  const before = JSON.parse(readFileSync(baselineFile, 'utf-8'))
  if (before.corpusSize !== result.corpusSize) {
    // Not fatal, but said loudly: two runs over different corpora are not a before/after, and that
    // is exactly the mistake this script was written to stop.
    console.log(`\nWARNING: baseline corpus was ${before.corpusSize} cards, this one is ${result.corpusSize}.`)
    console.log('Freeze a corpus with --save and measure both sides against it, or the delta is noise.')
  }
  const toLocal = [], toOnline = [], categoryOnly = []
  let compared = 0
  for (const [id, now] of Object.entries(result.perCard)) {
    const was = before.perCard?.[id]
    if (!was) continue
    compared++
    if (was.route !== now.route) (now.route === 'local' ? toLocal : toOnline).push([id, was, now])
    else if (was.category !== now.category) categoryOnly.push([id, was, now])
  }
  // THE OVERLAP IS THE COMPARISON (card b975dc0e). Cards absent from the baseline are skipped
  // silently, so a baseline from a different board -- or one whose perCard the producer never
  // wrote -- compares NOTHING and still prints a confident "local 240 -> 230" headline plus the
  // all-clear line. Reported as a count on every run, and fatal at zero.
  //
  // Deliberately NOT a percentage threshold on the size difference, which is what "drastically
  // different" would suggest: a corpus can grow by one card between runs and still be a perfectly
  // good before/after, while two same-sized corpora from different boards share nothing. Zero
  // overlap is the condition that is unambiguously not a comparison, so that is the one asserted.
  if (compared === 0) {
    console.error('\nroute-histogram: the baseline shares no cards with this corpus -- nothing was')
    console.error('compared, so a before/after cannot be stated and the security check below would')
    console.error('pass by examining an empty set.')
    process.exit(2)
  }
  console.log(`\nvs ${baselineFile}:  local ${before.local} -> ${result.local} (${share(result.local)})`)
  console.log(`   cards present in BOTH runs: ${compared} of ${result.corpusSize}`)
  console.log(`   online->local: ${toLocal.length}   local->online: ${toOnline.length}   category changed, route same: ${categoryOnly.length}`)
  for (const [id, was, now] of toLocal) console.log(`   -> LOCAL  ${id} ${String(was.category).padEnd(18)} -> ${String(now.category).padEnd(18)} ${now.title}`)
  for (const [id, was, now] of toOnline) console.log(`   -> ONLINE ${id} ${String(was.category).padEnd(18)} -> ${String(now.category).padEnd(18)} ${now.title}`)

  const escaped = toLocal.filter(([, was]) => SECURITY_CATEGORIES.has(was.category))
  if (escaped.length) {
    console.log(`\nSECURITY REGRESSION: ${escaped.length} card(s) left a security category for the local model:`)
    for (const [id, was, now] of escaped) console.log(`   ${id} ${was.category} -> ${now.category ?? '(none)'}  ${now.title}`)
    process.exit(3)
  }
  console.log('\nno card left a security category for the local model.')
}
