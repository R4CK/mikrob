// usage-share.mjs -- what actually reaches the local model, from the usage log (card 63c7d6f9).
//
// THE SECOND, INDEPENDENT SIGNAL. route-histogram.mjs says what the router would DECIDE; this says
// what the model was actually ASKED to do. They can disagree, and the disagreement is the point: a
// router that got more permissive without more real work reaching the model is a regression wearing
// a better histogram.
//
// TWO THINGS THIS SCRIPT REFUSES TO CONFLATE, both measured on the live log before it was written:
//
//  1. THE STAGE-1 CLASSIFIER IS NOT WORK. `route-triage` calls (source=routing) are the two-stage
//     router asking the 7B to classify a task -- median 599 ms. They are 33% of all rows, and they
//     grew the day stage 1 landed, which would flatter or dilute every share computed over "all
//     calls". They are counted separately, never in the denominator of work.
//
//  2. `task` IS A CALLER-DECLARED LABEL, NOT A MEASUREMENT. It is whatever the caller passed to
//     --task, defaulting to `chat`. Measured: `chat` calls have a median of 35s and 941 output
//     tokens -- they ARE drafting work, they just went through a dispatch path that names no preset.
//     So "the share of task=code" tracks who typed a flag, not what the model did: it sits at 1-2%
//     on days with 9 work calls and on days with 650. Reported for transparency, never as the
//     success metric.
//
// So the metric here is WORK CALLS and their OUTPUT TOKENS per day, plus the advisory drafts that
// card ee43a6ac added (a draft produced for a task the router sent online -- work the model did that
// it previously never saw at all).
//
// USAGE
//   node store/usage-share.mjs                      # per-day table, last 14 days
//   node store/usage-share.mjs --days 30
//   node store/usage-share.mjs --since 2026-08-14   # one window, e.g. before/after a landing
//   node store/usage-share.mjs --log <file>         # a frozen copy, for a repeatable comparison
//
// EXIT: 0 ok | 2 no usage log
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const LOG = flag('--log') ?? join(HERE, 'local-llm-usage.log')
const DAYS = Number(flag('--days') ?? 14)
const SINCE = flag('--since')

if (!existsSync(LOG)) {
  console.error(`usage-share: no usage log at ${LOG}`)
  process.exit(2)
}

// One TSV line per real model invocation: epoch, caller, task, model, ms, status, source, in, out.
// A short row is skipped rather than guessed at -- the log is append-only from a shell script and a
// truncated last line during a write is normal.
const CLASSIFIER_SOURCE = 'routing'
const rows = []
for (const line of readFileSync(LOG, 'utf-8').split('\n')) {
  const p = line.split('\t')
  if (p.length < 9) continue
  const ts = Number(p[0]), ms = Number(p[4]), out = Number(p[8])
  if (!Number.isFinite(ts) || ts <= 0) continue
  rows.push({ ts, caller: p[1], task: p[2], ms, status: p[5], source: p[6], out: Number.isFinite(out) ? out : 0 })
}

const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10)
const sinceTs = SINCE ? Date.parse(`${SINCE}T00:00:00Z`) / 1000 : 0
const inWindow = rows.filter((r) => r.ts >= sinceTs)

const byDay = new Map()
for (const r of inWindow) {
  const d = day(r.ts)
  const acc = byDay.get(d) ?? { work: 0, classifier: 0, code: 0, advisory: 0, out: 0, err: 0 }
  if (r.source === CLASSIFIER_SOURCE) acc.classifier++
  else {
    acc.work++
    acc.out += r.out
    if (r.task === 'code') acc.code++
    if (r.source === 'advisory') acc.advisory++
    if (r.status !== 'ok') acc.err++
  }
  byDay.set(d, acc)
}

const days = [...byDay.keys()].sort().slice(-DAYS)
console.log(`usage-share: ${LOG}   ${inWindow.length} rows${SINCE ? ` since ${SINCE}` : ''}`)
console.log('WORK = calls that asked the model to produce something. The stage-1 classifier is')
console.log('counted apart: it is the router asking, not work arriving.')
console.log('')
console.log('day           work   out-tokens   advisory   err   | classifier |  task=code (a caller-declared label)')
for (const d of days) {
  const a = byDay.get(d)
  const codeShare = a.work ? `${a.code} (${((100 * a.code) / a.work).toFixed(1)}%)` : '-'
  console.log(
    `${d}  ${String(a.work).padStart(5)}  ${String(a.out).padStart(11)}  ${String(a.advisory).padStart(8)}  ${String(a.err).padStart(4)}  |${String(a.classifier).padStart(11)} |  ${codeShare}`,
  )
}

const total = days.reduce((acc, d) => {
  const a = byDay.get(d)
  return { work: acc.work + a.work, out: acc.out + a.out, code: acc.code + a.code, advisory: acc.advisory + a.advisory, classifier: acc.classifier + a.classifier }
}, { work: 0, out: 0, code: 0, advisory: 0, classifier: 0 })
console.log('')
console.log(`window total: work ${total.work}, output tokens ${total.out}, advisory drafts ${total.advisory}, classifier calls ${total.classifier}`)
console.log(`task=code within work: ${total.code} (${total.work ? ((100 * total.code) / total.work).toFixed(1) : '0.0'}%) -- see the header: this counts flags, not work.`)
